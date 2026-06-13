// server.js - Axle team tool web server.
// v9: search - live filter box on the inbox (all useful fields incl. body text),
//     search-with-highlight inside the email on the detail page.
// v8: attachments listed on the detail page, opened via on-demand Graph fetch
//     (nothing stored on disk; PDFs/images inline, all other types download-only).
// v7: email rendering - clickable URLs, quoted-history folding.
// v6: identity via Tailscale Serve headers.
// The app binds 127.0.0.1 only. Tailscale Serve (configured once: `tailscale serve
// --bg 8484`) terminates HTTPS on the tailnet and injects the visitor's identity as
// the Tailscale-User-Login header. No public surface; no CLI dependency.
// Salesperson answers are TRUSTED input (passed via seed context); email stays untrusted.
// UI rework Step 0 (2026-06-10): server.js split into views/ui.js (esc/i18n/layout)
// and routes/{shared,inbox,item,admin}.js, all moved code verbatim. This file keeps
// startup + identity/CSRF middleware AND the safety-path routes unmoved: /compose +
// /compose/resolve and /item/:id/contactform-recipient (recipients pass the
// pickRecipient gate here) and /item/:id/send (allow-list checks + send-guard).
require("dotenv").config({ path: "C:\\Axle\\secrets\\.env", quiet: true });
const express = require("express");
const SG = require("./send-guard.js");
const SEND = require("./send.js");
const RESOLVE = require("./resolve-customer.js");   // Compose: deterministic read-only customer resolver
const COMPOSE = require("./compose.js");            // Compose: compose-mode engine (draft-only)
const SCEN = require("./scenarios.js");             // Compose: seeded quick-start scenario library
const crypto = require("crypto");                   // synthetic conversation keys
const { db, audit } = require("./db.js");
const { esc, t, page, langOK, workPanes } = require("./views/ui.js");
const { MAILBOX_OF, MAX_ATTACH_BYTES, MAX_ATTACH_TOTAL, runRedraft, markReadSafe,
        isContactFormItem, saveWorkInputs, defaultMailbox } = require("./routes/shared.js");
const mountInbox = require("./routes/inbox.js");
const mountItem = require("./routes/item.js");
const mountAdmin = require("./routes/admin.js");

const PORT = 8484;
const BIND_IP = "127.0.0.1";

// Allow-list action #4 — "send reply to contact-form customer". OFF by default; Brad enables it
// deliberately at the gate by setting AXLE_ACTION_CONTACTFORM_SEND=on in the box .env and
// restarting. Until then, contact-form items draft and hold only: the Send button never appears
// and /item/:id/send refuses them at the route. Governed separately from compose's action #3.
const ACTION_CONTACTFORM_SEND = process.env.AXLE_ACTION_CONTACTFORM_SEND === "on";

// Allow-list action #3 - "send new (non-reply) / composed email". OFF by default; Brad enables it
// at Gate D by setting AXLE_ACTION_COMPOSE_SEND=on in the box .env and restarting. Until then a
// compose item drafts and holds only: no Send button, and /item/:id/send refuses it at the route.
const ACTION_COMPOSE_SEND = process.env.AXLE_ACTION_COMPOSE_SEND === "on";

// Recover items stuck in 'investigating' after a crash/restart mid-redraft.
const stuck = db.prepare("UPDATE work_items SET status = 'awaiting_input', updated_at = datetime('now') WHERE status = 'investigating'").run();
if (stuck.changes) audit("system", "recovered_stuck_items", null, `${stuck.changes} item(s) reset to awaiting_input on startup`);
// Clear a stuck sync lock left by a manual sync that died with a previous server instance.
const stuckSync = db.prepare("UPDATE sync_state SET running = 0 WHERE id = 1 AND running = 1").run();
if (stuckSync.changes) audit("system", "sync_lock_reset", null, "cleared running flag on startup");

// Read one cookie value from the request (no cookie-parser dependency).
function getCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const app = express();

// Limit raised so an attachment (browser-encoded to base64 in a hidden field) fits in a
// normal form post — no multipart/dependency needed. Per-file cap is enforced separately.
app.use(express.urlencoded({ extended: false, limit: "16mb" }));

// Identity from Tailscale Serve headers. No header = request didn't come through Serve.
app.use((req, res, next) => {
  const login = String(req.headers["tailscale-user-login"] || "");
  if (!login) {
    audit("system", "no_identity_header", null, `direct request from ${req.socket.remoteAddress}`);
    return res.status(403).send("<h1>Forbidden</h1><p>Axle must be accessed via its tailnet HTTPS address.</p>");
  }
  const user = db.prepare("SELECT * FROM users WHERE tailscale_login = ?").get(login);
  if (!user) {
    audit(login, "access_denied", null, "unregistered tailnet user");
    return res.status(403).send(`<h1>Not registered</h1><p>Tailnet identity <b>${esc(login)}</b> is not registered in Axle. Ask Brad to add you.</p>`);
  }
  req.user = user;
  req.user.lang = langOK(getCookie(req, "axle_lang")); // per-browser UI language (header toggle)
  next();
});

// CSRF hardening (opt-in, off until Brad sets the env). Auth is via the Serve-injected
// Tailscale-User-Login header rather than a cookie, so SameSite gives no protection: a malicious
// website could drive a tailnet user's browser to POST here and the Serve proxy would still attach
// that user's identity. When AXLE_ALLOWED_ORIGIN is set (e.g. https://axle.<tailnet>.ts.net), any
// state-changing request whose Origin/Referer is a DIFFERENT origin is rejected. Left a no-op until
// the env is set, so it can never lock the team out before the exact Serve origin is confirmed.
const ALLOWED_ORIGIN = process.env.AXLE_ALLOWED_ORIGIN || "";
app.use((req, res, next) => {
  if (!ALLOWED_ORIGIN || req.method === "GET" || req.method === "HEAD") return next();
  const src = req.headers.origin || req.headers.referer || "";
  let ok = !src;                                      // no Origin/Referer (non-browser tooling) — allowed
  if (src) { try { ok = new URL(src).origin === ALLOWED_ORIGIN; } catch (e) { ok = false; } }
  if (!ok) {
    audit(req.user.tailscale_login, "csrf_blocked", null, `${req.method} ${req.path} origin=${String(src).slice(0, 80)}`);
    return res.status(403).send("<h1>Forbidden</h1><p>Cross-origin request blocked.</p>");
  }
  next();
});

// Static design-system assets (UI rework Step 1): tokens.css + components.css from
// ./assets, vendored locally (Tailscale-only network — no CDN). Mounted AFTER the
// identity + CSRF middleware so even stylesheets are never served without a tailnet
// identity; GETs pass CSRF untouched. dotfiles/redirects off; 1h cache (?v= busts).
app.use("/assets", require("express").static(require("path").join(__dirname, "assets"), {
  maxAge: "1h", redirect: false, dotfiles: "ignore", index: false,
}));

// Routes are mounted in the original order; the safety-path routes below stay in this
// file verbatim. (Express patterns here are disjoint, so relative order is cosmetic.)
mountInbox(app, { ACTION_COMPOSE_SEND });

// --- Compose ("New email") -----------------------------------------------------
// Step 3: DRAFT-ONLY. Allow-list action #3 ("send new non-reply email") is OFF, so Compose
// researches + drafts + holds; it never sends. The recipient is produced ONLY by the
// deterministic resolver (resolve-customer.js) and re-validated here against a fresh
// resolution — no model output or free-typed value can set or redirect the To address.


// A compose work item has no inbound thread, so its conversation_key is synthetic and unique
// (satisfies UNIQUE(mailbox, conversation_key)). Step 5 will consolidate a customer's reply
// onto the item by (recipient, normalised subject) + the stored sent message-id, not this key.
function composeConvKey() {
  return "compose:" + Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
}
const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

// AJAX: resolve a customer identifier to a recipient (or candidates) for the modal. Read-only.
app.post("/compose/resolve", async (req, res) => {
  const who = String(req.body.who || "").trim();
  audit(req.user.tailscale_login, "compose_resolve", null, who.slice(0, 80));
  if (!who) return res.json({ resolved: false, candidates: [], message: "" });
  try {
    const r = await RESOLVE.resolveCustomer(who);
    if (r.resolved && r.customer) {
      const c = r.customer;
      return res.json({
        resolved: true, matched_via: r.matched_via, needsAddressPick: r.needsAddressPick, message: r.message,
        customer: {
          cardCode: c.cardCode, name: c.name, contactName: c.contactName || null, country: c.country,
          knownAccount: c.knownAccount, frozen: c.frozen, language_hint: c.language_hint,
          addresses: c.sendableAddresses || [], notes: c.notes || [],
        },
      });
    }
    if (r.candidates && r.candidates.length) {
      return res.json({
        resolved: false, message: r.message,
        candidates: r.candidates.map((c) => ({
          cardCode: c.cardCode, name: c.name, contactName: c.contactName || null,
          email: c.email || (c.sendableAddresses && c.sendableAddresses[0]) || null,
          addresses: c.sendableAddresses || (c.email ? [c.email] : []),
          country: c.country, frozen: c.frozen, reason: c.reason || null,
        })),
      });
    }
    return res.json({ resolved: false, candidates: [], message: r.message || t(req.user.lang, "compose_not_found") });
  } catch (e) {
    audit(req.user.tailscale_login, "compose_resolve_error", null, e.message.slice(0, 200));
    res.status(502).json({ resolved: false, error: e.message.slice(0, 200) });
  }
});

// Submit: resolve deterministically, validate the recipient came from the resolver, run
// compose-mode, persist an origin='compose' work item, and land on the detail page.
app.post("/compose", async (req, res) => {
  const lang = req.user.lang;
  const login = req.user.tailscale_login;
  const who = String(req.body.who || "").trim();
  const instruction = String(req.body.instruction || "").trim();
  const scenarioKey = (req.body.scenario && SCEN.byKey(req.body.scenario)) ? String(req.body.scenario) : null;
  const langSel = ["en", "nl", "de", "fr", "es"].includes(req.body.language) ? req.body.language : "auto";
  const mailbox = ["info", "drachten"].includes(req.body.mailbox) ? req.body.mailbox : defaultMailbox(req.user);
  const pickCard = String(req.body.pick_card || "").trim();
  const pickAddr = String(req.body.pick_addr || "").trim().toLowerCase();

  const fail = (msg) => res.status(400).send(page(t(lang, "compose_failed"), req.user,
    `<p><b>${esc(t(lang, "compose_failed"))}:</b> ${esc(msg)}</p><p><a href="&#47;">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`));

  if (!who || !instruction) return fail(t(lang, "compose_need_who_instr"));

  // Resolve deterministically (read-only). The modal already showed this to the salesperson;
  // we re-resolve server-side so the recipient is authoritative, never a posted free-text value.
  let chosen, validAddrs;
  try {
    const r0 = await RESOLVE.resolveCustomer(who);
    if (r0.resolved && r0.customer) {
      chosen = r0; validAddrs = r0.customer.sendableAddresses || [];
    } else if (r0.candidates && r0.candidates.length && pickCard) {
      const rc = await RESOLVE.resolveCustomer(pickCard);     // disambiguate to the picked card
      if (rc.resolved && rc.customer) { chosen = rc; validAddrs = rc.customer.sendableAddresses || []; }
    }
  } catch (e) {
    audit(login, "compose_error", null, "resolve: " + e.message.slice(0, 180));
    return fail(e.message.slice(0, 200));
  }
  if (!chosen) return fail(t(lang, "compose_need_pick"));

  // SECURITY INVARIANT (the crown jewel): the recipient MUST be an address the resolver
  // produced. pickRecipient honours a posted pick_addr only if it is in that set (else rejects
  // with no fallback), or takes the sole address when nothing was picked. A tampered or
  // model-supplied address can never reach the To line.
  const recipient = RESOLVE.pickRecipient(validAddrs, pickAddr);
  if (!recipient) return fail(t(lang, "compose_need_pick"));

  const language = langSel === "auto" ? (chosen.customer.language_hint || "en") : langSel;

  // Persist immediately as origin='compose', status='investigating', then run the slow research +
  // draft in the BACKGROUND so the salesperson lands on the task at once (the detail page shows the
  // "investigating" banner and auto-refreshes) instead of waiting on a 30-60s hang. The draft is
  // produced by runRedraft's compose branch, which rebuilds everything from the stored item - the
  // sanitized customer carries NO address, and the recipient stays code-held in `recipient`.
  const modelCustomer = COMPOSE.sanitizeCustomerForModel(chosen.customer);
  const subject = scenarioKey ? SCEN.byKey(scenarioKey).label_en : "New email";   // provisional; the draft proposes the final one
  const itemId = db.prepare(
    "INSERT INTO work_items (mailbox, conversation_key, sender_email, sender_name, subject, language, intent, priority, status, origin, compose_instruction, compose_customer, recipient, scenario, owner) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'investigating', 'compose', ?, ?, ?, ?, ?)"
  ).run(
    mailbox, composeConvKey(), recipient, chosen.customer.name || chosen.customer.contactName || recipient,
    subject, language, scenarioKey, 2, instruction, JSON.stringify(modelCustomer), recipient, scenarioKey,
    req.user.owner_label || req.user.display_name
  ).lastInsertRowid;

  // Attachments staged in the modal (base64), capped per-file and per-item.
  const names = asArray(req.body.att_name), ctypes = asArray(req.body.att_ctype), datas = asArray(req.body.att_data);
  let total = 0, atts = 0;
  for (let i = 0; i < datas.length; i++) {
    const b64 = String(datas[i] || ""); if (!b64) continue;
    const size = Math.floor((b64.length * 3) / 4);
    if (size > MAX_ATTACH_BYTES || total + size > MAX_ATTACH_TOTAL) continue;
    total += size; atts++;
    db.prepare("INSERT INTO draft_attachments (work_item_id, name, content_type, size, content_b64, added_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(itemId, String(names[i] || "attachment").slice(0, 200), String(ctypes[i] || "application/octet-stream").slice(0, 100), size, b64, login);
  }

  audit(login, "compose_created", itemId,
    `via=${chosen.matched_via} mailbox=${mailbox}@ lang=${language} scenario=${scenarioKey || "-"} atts=${atts} (drafting in background)`);
  setImmediate(() => runRedraft(itemId, login));   // research + draft happen off the request path
  res.redirect("/item/" + itemId);
});

mountItem(app, { ACTION_COMPOSE_SEND, ACTION_CONTACTFORM_SEND });

// Confirm the contact-form reply recipient (Step 3 of the contact-form build). The candidate
// set was built deterministically at ingest (the parsed form address + any SAP/Shopify addresses)
// and stored on the item. The posted address is honoured ONLY if pickRecipient finds it in that
// set — a tampered or out-of-set value is rejected with no fallback, so a recipient the resolver
// never produced can't get through. The chosen address is code-held in w.recipient. This sets a
// recipient only; it NEVER sends (allow-list action #4 is still off — that's Step 4's gate).
app.post("/item/:id/contactform-recipient", (req, res) => {
  const lang = req.user.lang;
  const login = req.user.tailscale_login;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(lang, "not_found"))}</p>`));
  if (!isContactFormItem(w)) {
    return res.status(400).send(page(t(lang, "send_refused"), req.user,
      `<p>${esc(t(lang, "send_refused"))}</p><p><a href="/item/${w.id}">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`));
  }
  let cf = null;
  try { cf = JSON.parse(w.contact_form_json || "null"); } catch (e) { cf = null; }
  const cands = (cf && cf.candidateAddresses) || [];
  const picked = String(req.body.addr || "").trim().toLowerCase();

  // pickRecipient: returns the address only if it is one the resolver produced; else "".
  const recipient = RESOLVE.pickRecipient(cands, picked);
  if (!recipient) {
    audit(login, "contactform_recipient_rejected", w.id, `picked=${picked.slice(0, 80)} not in candidate set`);
    return res.status(400).send(page(t(lang, "send_refused"), req.user,
      `<p><b>${esc(t(lang, "send_refused"))}:</b> ${esc(t(lang, "cf_recipient_rejected"))}</p><p><a href="/item/${w.id}">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`));
  }
  db.prepare("UPDATE work_items SET recipient = ?, updated_at = datetime('now') WHERE id = ?").run(recipient, w.id);
  audit(login, "contactform_recipient_set", w.id, `to=${recipient}`);
  res.redirect("/item/" + w.id);
});

// Send the approved reply (allow-list action #1). The salesperson can edit the reply and
// send at any time; deterministic guardrails (send-guard) re-validate the FINAL body - an
// injection-flagged item can never send, recipient is hard-locked to the sender, every URL
// must be allowlisted. Both the AI draft (drafts, source='ai') and the actual sent text
// (sends.body + a source='human' draft) are kept for the self-improvement layer. De-dup is
// on (work_item_id, body_sha256): a double-click of the identical body can't send twice.
app.post("/item/:id/send", async (req, res) => {
  const lang = req.user.lang;
  const login = req.user.tailscale_login;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(lang, "not_found"))}</p>`));

  // Allow-list action #3 ("send new / composed email"). While AXLE_ACTION_COMPOSE_SEND is OFF a
  // compose item drafts and holds only - refuse at the route, not merely by hiding the button. When
  // ON, it sends a FRESH email to the CODE-HELD, human-confirmed recipient (w.recipient - set only by
  // the resolver + pickRecipient at compose time, never by the model or email content); a confirmed
  // recipient is required first.
  const isComposeItem = w.origin === "compose";
  if (isComposeItem) {
    if (!ACTION_COMPOSE_SEND) {
      audit(login, "compose_send_blocked", w.id, "action #3 disabled (draft-only)");
      return res.status(403).send(page(t(lang, "send_refused"), req.user,
        `<p><b>${esc(t(lang, "send_refused"))}:</b> ${esc(t(lang, "compose_send_blocked"))}</p><p><a href="/item/${w.id}">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`));
    }
    if (!w.recipient) {
      audit(login, "compose_send_no_recipient", w.id, "no confirmed recipient");
      return res.status(400).send(page(t(lang, "send_refused"), req.user,
        `<p><b>${esc(t(lang, "send_refused"))}:</b> ${esc(t(lang, "compose_need_pick"))}</p><p><a href="/item/${w.id}">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`));
    }
  }

  // Contact-form messages: the thread sender is Shopify's mailer, not the customer, so a send is
  // a NEW outbound to the code-held, human-confirmed recipient - governed by allow-list action #4.
  // While #4 is OFF, refuse at the route (not just a hidden button). When ON, a recipient must
  // have been confirmed first. When permitted, isCF routes the assembly to the new-outbound path.
  const isCF = isContactFormItem(w);
  if (isCF) {
    if (!ACTION_CONTACTFORM_SEND) {
      audit(login, "contactform_send_blocked", w.id, "action #4 disabled (draft-only)");
      return res.status(403).send(page(t(lang, "send_refused"), req.user,
        `<p><b>${esc(t(lang, "send_refused"))}:</b> ${esc(t(lang, "cf_send_not_enabled"))}</p><p><a href="/item/${w.id}">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`));
    }
    if (!w.recipient) {
      audit(login, "contactform_send_no_recipient", w.id, "no confirmed recipient");
      return res.status(400).send(page(t(lang, "send_refused"), req.user,
        `<p><b>${esc(t(lang, "send_refused"))}:</b> ${esc(t(lang, "cf_confirm_first"))}</p><p><a href="/item/${w.id}">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`));
    }
  }

  saveWorkInputs(w, req.body, login);                 // persist the edited reply + any answers/feedback
  const body = String(req.body.reply != null ? req.body.reply : (w.draft_edit || ""));

  // The AI draft this reply was edited from (latest AI full, else AI holding) - for lineage.
  const aiSrc = db.prepare("SELECT * FROM drafts WHERE work_item_id = ? AND source = 'ai' ORDER BY is_interim ASC, version DESC, id DESC LIMIT 1").get(w.id);

  // Staged attachments: loaded BEFORE assembly so the assembler can resolve any [image:N]
  // tokens the human placed against this item's own staged rows (and refuse bad ones).
  const attRows = db.prepare("SELECT id, name, content_type, size, content_b64 FROM draft_attachments WHERE work_item_id = ? ORDER BY id").all(w.id);

  let payload;
  try {
    // Contact-form: new outbound to the code-held recipient with the human-approved subject.
    // Everything else: in-thread reply hard-locked to the sender. Both re-validate the FINAL body.
    payload = isComposeItem ? SG.assembleNewOutboundSend(w, body, req.body.compose_subject, attRows)
            : isCF ? SG.assembleNewOutboundSend(w, body, req.body.cf_subject, attRows)
            : SG.assembleSend(w, body, attRows);
  } catch (e) {
    audit(login, "send_refused", w.id, e.message.slice(0, 200));
    return res.status(400).send(page("Send refused", req.user,
      `<p><b>${esc(t(lang, "send_refused"))}:</b> ${esc(e.message)}</p><p><a href="/item/${w.id}">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`));
  }

  // De-dup an identical body for this item (double-click / refresh).
  if (db.prepare("SELECT 1 FROM sends WHERE work_item_id = ? AND body_sha256 = ?").get(w.id, payload.sha256)) {
    return res.redirect("/item/" + w.id);
  }

  // Bytes for Graph, metadata for the audit record. Attachments whose id the assembler
  // validated as inline get the send-guard contentId (the <img> in the HTML references it);
  // the rest stay regular attachments.
  const inlineSet = new Set(payload.inlineIds || []);
  const attMeta = attRows.map((a) => ({ name: a.name, contentType: a.content_type, size: a.size, inline: inlineSet.has(a.id) || undefined }));
  const graphAtts = attRows.map((a) => ({
    name: a.name, contentType: a.content_type, contentBytes: a.content_b64,
    ...(inlineSet.has(a.id) ? { contentId: SG.contentIdFor(a.id) } : {}),
  }));

  // Record the exact sent text as a human draft (keeps the AI-vs-sent pair in the history).
  const ver = (db.prepare("SELECT MAX(version) AS v FROM drafts WHERE work_item_id = ?").get(w.id).v || 0) + 1;
  const humanDraftId = db.prepare("INSERT INTO drafts (work_item_id, version, is_interim, body, source, edited_by) VALUES (?, ?, 0, ?, 'human', ?)")
    .run(w.id, ver, body, login).lastInsertRowid;

  // Reserve a pending send; UNIQUE(work_item_id, body_sha256) rejects a race double-send.
  try {
    db.prepare("INSERT INTO sends (work_item_id, draft_id, source_draft_id, to_addr, subject, body_sha256, body, attachments_json, status, sent_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
      .run(w.id, humanDraftId, aiSrc ? aiSrc.id : null, payload.to, payload.subject, payload.sha256, body, attMeta.length ? JSON.stringify(attMeta) : null, login);
  } catch (e) {
    db.prepare("DELETE FROM drafts WHERE id = ?").run(humanDraftId);
    return res.redirect("/item/" + w.id);
  }

  try {
    // Contact-form is a fresh email (no thread); originalMessageId=null so send.js threads nothing.
    const r = await SEND.sendReply({
      mailbox: MAILBOX_OF[w.mailbox], originalMessageId: (isCF || isComposeItem) ? null : w.latest_message_id,
      to: payload.to, subject: payload.subject, html: payload.html, attachments: graphAtts,
    });
    db.prepare("UPDATE sends SET status = 'sent', graph_message_id = ? WHERE work_item_id = ? AND body_sha256 = ?").run(r.sentId || "sent", w.id, payload.sha256);
    db.prepare("UPDATE work_items SET status = 'done', resolution = 'replied', draft_edit = NULL, updated_at = datetime('now') WHERE id = ?").run(w.id);
    db.prepare("DELETE FROM draft_attachments WHERE work_item_id = ?").run(w.id); // bytes no longer needed; metadata kept in sends
    const edited = aiSrc ? String(aiSrc.body) !== body : true;
    audit(login, "email_sent", w.id,
      `kind=${isComposeItem ? "compose_new" : isCF ? "contactform_new" : "reply"} to=${payload.to} edited=${edited} ai_draft=${aiSrc ? aiSrc.id : "-"} atts=${attMeta.length}${inlineSet.size ? ` inline=${inlineSet.size}` : ""} threaded=${r.threaded} sha=${payload.sha256.slice(0, 12)}`);
    if (!isComposeItem) await markReadSafe(login, w);
    res.redirect("/item/" + w.id);
  } catch (e) {
    db.prepare("DELETE FROM sends WHERE work_item_id = ? AND body_sha256 = ? AND status = 'pending'").run(w.id, payload.sha256);
    db.prepare("DELETE FROM drafts WHERE id = ?").run(humanDraftId);   // remove the speculative human draft on failure
    audit(login, "send_failed", w.id, e.message.slice(0, 200));
    res.status(502).send(page("Send failed", req.user,
      `<p><b>${esc(t(lang, "send_failed"))}:</b> ${esc(e.message)}</p><p>${esc(t(lang, "send_failed_note"))}</p><p><a href="/item/${w.id}">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`));
  }
});

mountAdmin(app);

// Last-resort error handler. Express 5 routes sync throws AND rejected async handlers
// here; without it they became default 500s that htmx silently ignores — a failed
// queue-click looked like "nothing happened". Now: console + audit row, and an htmx
// request gets a pane-shaped error so the failure is VISIBLE in the workpane; plain
// navigations get a full page. Short message only — no stack to the browser.
app.use((err, req, res, next) => {
  const itemId = (req.path.match(/^\/item\/(\d+)/) || [])[1] || null;
  const short = String((err && err.message) || err).slice(0, 200);
  console.error(`Route error ${req.method} ${req.path}:`, (err && err.stack) || err);
  try { audit(req.user ? req.user.tailscale_login : "system", "route_error", itemId, `${req.method} ${req.path} - ${short}`); } catch (e) { /* never block the response */ }
  if (res.headersSent) return next(err);
  const lang = langOK(req.user && req.user.lang);
  const msg = `<div class="empty-state"><p class="muted">${esc(t(lang, "load_error"))}</p><p class="muted">${esc(short)}</p></div>`;
  if (req.get("HX-Request")) return res.status(500).send(workPanes(msg, ""));
  res.status(500).send(page("Error", req.user || { lang, display_name: "-", role: "-" }, msg));
});

app.listen(PORT, BIND_IP, () => {
  console.log(`Axle web listening on ${BIND_IP}:${PORT} (loopback; fronted by Tailscale Serve)`);
});
