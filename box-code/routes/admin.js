// routes/admin.js - Block sender (the dialog and its post), the team's Blocked senders page, and the
// owners' pages: Teach review, the audit log and Adoption. Extracted from server.js (UI rework
// Step 0, 2026-06-10); redrawn in the shared vocabulary in redesign phase 3 (2026-10-07). Routes,
// fields, guards and audit rows are unchanged.
const RESOLVE = require("../resolve-customer.js"); // read-only SAP-customer check in the block dialog
const OB = require("../outlook-block.js");        // Outlook-side filing of blocked senders (action #7)
const { db, audit } = require("../db.js");
const K = require("../knowledge.js");             // Teach Axle: text cap, sanitiser, prompt line format
const { esc, t, fmtDateTime, icon, iconBtn, pill, deskPage, bannerPage, notFoundPage } = require("../views/ui.js");
const { markReadSafe } = require("./shared.js");
const BASE = require("../base-path.js");          // AXLE_BASE_PATH URL prefix

const B = BASE.path;
// An in-place request from axle.js: refusals answer as JSON the client shows as a banner.
const inline = (req) => req.get("X-Axle-Inline") === "1";
const refusal = (message) => ({ ok: false, kind: "refused", message, unchanged: true });
// A table on desk and tablet, the same rows as a card list on a phone (axle.css switches them).
// dense: the audit log's compact rows, scrolling sideways inside the card where it is too wide.
const tableCard = (head, rows, dense) =>
  `<section class="wb-card ax-tablecard${dense ? " ax-scroll" : ""}"><table class="wb-table${dense ? " wb-table--dense" : ""}"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></section>`;
const cardList = (cards) => `<ul class="wb-cardlist ax-cards">${cards.join("")}</ul>`;
const emptyCard = (text) => `<section class="wb-card"><div class="wb-empty">${esc(text)}</div></section>`;
const itemLink = (id) => (id ? `<a class="wb-link" href="${B}/item/${id}">#${id}</a>` : "");
// A form that posts in place and redraws the page around it (the response is this page again).
const inPlace = (action, toast) => `method="post" action="${B}${action}" data-inline data-target=".ax-pagewrap" data-select=".ax-pagewrap" data-toast="${esc(toast)}"`;

module.exports = function mountAdmin(app) {

// ---- Block sender (Axle-only suppression, reversible) -------------------------------------
// GET = what will be blocked: the ONE address, with a SAP-customer check so a real customer isn't
// blocked by accident. In place (X-Axle-Inline) it is the dialog the email's More menu opens; any
// other request gets the same content as a page. POST = insert the block, archive this item
// (resolution no_action) and mark the inbound read. The pattern is derived in code from the item's
// STORED sender address, never from typed input. Blocks are global (info@ + drachten@). Audited.
//
// Single addresses ONLY since 2026-07-27: see the POST handler for why the whole-domain option
// was removed.
app.get("/item/:id/block", async (req, res) => {
  const lang = req.user.lang;
  const L = (k) => esc(t(lang, k));
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return inline(req) ? res.status(404).json(refusal(t(lang, "not_found"))) : res.status(404).send(notFoundPage(req.user));
  const addr = String(w.sender_email || "").trim().toLowerCase();
  const domain = addr.split("@")[1] || "";
  // Never offer to block a composed email, a blank or invalid sender, or ourselves. With the Outlook
  // rule live (action #7) a block on one of our own domains would file our own internal mail,
  // including action #6's cross-mailbox handover forwards, out of the inbox.
  if (w.origin === "compose" || !addr || !domain || OB.isInternal(addr)) {
    return inline(req) ? res.status(400).json(refusal(t(lang, "block_refused"))) : res.redirect(BASE.url("/item/" + w.id));
  }

  // SAP check: warn when the address belongs to a real customer (guest matches have no CardCode
  // and don't count). A SQL failure must not break the dialog: it says SAP could not be checked.
  let sap = `<p class="ax-note">${icon("info")}<span>${L("block_sap_unknown")}</span></p>`;
  try {
    const r = await RESOLVE.resolveCustomer(addr);
    const hit = (r && r.customer && r.customer.cardCode) ? r.customer
      : ((r && r.candidates) || []).find((c) => c.cardCode);
    sap = hit
      ? `<p class="ax-note" data-tone="warn">${icon("alert")}<span>${esc(t(lang, "block_sap_warn").replace("{name}", hit.name || "?").replace("{code}", hit.cardCode))}</span></p>`
      : `<p class="ax-note" data-tone="ok">${icon("check")}<span>${L("block_sap_none")}</span></p>`;
  } catch (e) { /* keep the unknown note */ }

  const action = `${B}/item/${w.id}/block`;
  const body = `<p class="ax-who"><span class="ax-addr">${esc(addr)}</span>${w.sender_name ? `<span class="wb-hint">${esc(w.sender_name)}</span>` : ""}</p>
    <p>${L(OB.active() ? "block_explain_outlook" : "block_explain")}</p>${sap}`;
  const go = `<button type="submit" form="ax-block-form" class="wb-btn wb-btn--danger">${L("block_confirm_btn")}</button>`;
  if (inline(req)) {
    return res.send(`<div class="ax-ov" data-kind="dialog" role="dialog" aria-modal="true" aria-label="${L("block_title")}">
  <div class="ax-ov__hd">${iconBtn(t(lang, "back"), "back", "data-close", "ax-ov__back")}<h2 class="ax-ov__t">${L("block_title")}</h2>${iconBtn(t(lang, "close"), "x", "data-close", "ax-ov__x")}</div>
  <div class="ax-ov__bd"><div data-ax-banner></div>${body}<form id="ax-block-form" method="post" action="${action}" data-inline data-next data-toast="${L("blocked_toast")}"></form></div>
  <div class="ax-ov__ft"><button type="button" class="wb-btn ax-ov-desk" data-close data-autofocus>${L("cancel")}</button>${go}</div>
</div>`);
  }
  const back = { href: `${B}/item/${w.id}`, label: t(lang, "back_email") };
  res.send(deskPage(t(lang, "block_title"), req.user, `<section class="wb-card"><div class="wb-card__bd ax-result">${body}
    <form id="ax-block-form" method="post" action="${action}" class="ax-acts"><a class="wb-btn" href="${back.href}">${L("cancel")}</a>${go}</form></div></section>`, { back }));
});

app.post("/item/:id/block", async (req, res) => {
  const lang = req.user.lang;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return inline(req) ? res.status(404).json(refusal(t(lang, "not_found"))) : res.status(404).send(notFoundPage(req.user));
  const refused = () => inline(req) ? res.status(400).json(refusal(t(lang, "block_refused"))) : res.redirect(BASE.url("/item/" + w.id));
  if (w.origin === "compose") return refused();
  const addr = String(w.sender_email || "").trim().toLowerCase();
  const domain = addr.split("@")[1] || "";
  if (!addr || !domain) return refused();
  // Whole-domain blocking was REMOVED on 2026-07-27 (Brad's call). Two mis-clicks on the old
  // "the whole domain" option ('@gmail.com' and '@shopify.com') silently swallowed 13 days of
  // consumer customer email and 4 weeks of webshop contact-form messages, with no trace anywhere
  // anyone looks. The blast radius of the option was wildly out of proportion to its usefulness,
  // so only single addresses can be blocked now. `kind` is no longer read from the request at all.
  //
  // Pre-existing domain rows still MATCH in isBlockedSender (they are all legitimate
  // single-organisation domains: marketing senders, spam domains); they simply cannot be created
  // any more, and remain removable on the Blocked senders page.
  const kind = "address";
  const pattern = addr.slice(0, 200);
  if (OB.isInternal(pattern)) return refused();   // mirrors the GET guard
  db.prepare("INSERT OR IGNORE INTO sender_blocks (pattern, kind, reason, added_by, work_item_id) VALUES (?, ?, 'unwanted sender', ?, ?)")
    .run(pattern, kind, req.user.tailscale_login, w.id);
  db.prepare("UPDATE work_items SET status = 'archived', resolution = 'no_action', updated_at = datetime('now') WHERE id = ?").run(w.id);
  audit(req.user.tailscale_login, "sender_blocked", w.id, `${pattern} (${kind})`);
  await markReadSafe(req.user.tailscale_login, w);
  // Outlook side (action #7): rebuild the inbox rule from the table, then sweep this sender's mail
  // already in the inbox into the "Axle Blocked" folder. DB first, mailbox second, and applyBlock
  // never throws: a Graph failure is audited and leaves the Axle-side block standing rather than
  // failing the whole action in the user's face.
  await OB.applyBlock(req.user.tailscale_login, pattern, w.id);
  res.redirect(BASE.url("/"));
});

// Blocked senders: visible to the whole team, unblock allowed for anyone (audited), so a mistake is
// fixable on the spot without waiting for Brad. One quiet line says whether Outlook is filing the
// blocked mail (the antidote to the 2026-07-27 incident, where suppression was invisible); any Graph
// trouble leaves the line out, never a broken page.
app.get("/blocks", async (req, res) => {
  const lang = req.user.lang;
  const L = (k) => esc(t(lang, k));
  const rows = db.prepare(`SELECT b.*, COALESCE(u.display_name, b.added_by) AS who
    FROM sender_blocks b LEFT JOIN users u ON u.tailscale_login = b.added_by ORDER BY b.id DESC`).all();

  let olLine = "";
  try {
    const st = await OB.status();
    const state = (b) => b.error ? esc(b.error)
      : b.rule === "missing" ? L("blocks_ol_missing")
      : `${L(st.dry ? "blocks_ol_dry" : "blocks_ol_on")}, ${b.count == null ? "?" : b.count} ${L("blocks_ol_msgs")}${b.syncedAt ? "" : ", " + L("blocks_ol_never")}`;
    const boxes = !st.enabled && !st.dry ? L("blocks_ol_off")
      : st.boxes.map((b) => `<span${b.syncedAt ? ` title="${esc(t(lang, "updated").replace("{t}", fmtDateTime(b.syncedAt, lang)))}"` : ""}>${esc(b.mailbox.split("@")[0])}@ ${state(b)}</span>`).join(" · ");
    olLine = `<p class="ax-sub">${L("blocks_ol_status")}: ${boxes}</p>`;
  } catch (e) { olLine = ""; }

  const sender = (b) => `${esc(b.pattern)}${b.kind === "address" ? "" : " " + pill(t(lang, "blocks_domain"))}`;
  const unblock = (b, cls) => `<form ${inPlace(`/blocks/${b.id}/unblock`, t(lang, "unblocked_toast").replace("{x}", b.pattern))}${cls ? ` class="${cls}"` : ""}><button class="wb-btn wb-btn--sm">${L("unblock")}</button></form>`;
  const list = rows.length ? tableCard(
    [L("col_sender_b"), L("col_by_b"), L("col_when_b"), L("col_item_b"), `<span class="wb-sr">${L("unblock")}</span>`],
    rows.map((b) => `<tr><td><b>${sender(b)}</b></td><td>${esc(b.who)}</td><td>${esc(fmtDateTime(b.added_at, lang))}</td><td>${itemLink(b.work_item_id)}</td><td class="wb-num">${unblock(b)}</td></tr>`))
    + cardList(rows.map((b) => `<li class="wb-lcard"><span class="wb-lcard__title">${sender(b)}</span><span class="wb-lcard__meta">${[esc(b.who), esc(fmtDateTime(b.added_at, lang)), itemLink(b.work_item_id)].filter(Boolean).join(" · ")}</span>${unblock(b, "ax-lcard-act")}</li>`))
    : emptyCard(t(lang, "blocks_none"));
  res.send(deskPage(t(lang, "blocks_title"), req.user, olLine + list, { count: rows.length || null }));
});

app.post("/blocks/:id/unblock", async (req, res) => {
  const b = db.prepare("SELECT * FROM sender_blocks WHERE id = ?").get(req.params.id);
  if (b) {
    db.prepare("DELETE FROM sender_blocks WHERE id = ?").run(b.id);
    audit(req.user.tailscale_login, "sender_unblocked", b.work_item_id || null, `${b.pattern} (${b.kind})`);
    // Rebuild the rule without this pattern and move the sender's filed mail back to the inbox.
    // Unblocking is the fix-a-mistake path, so it has to undo the visible effect, not just the row.
    await OB.applyUnblock(req.user.tailscale_login, b.kind === "address" ? b.pattern : null, b.work_item_id || null);
  }
  res.redirect(BASE.url("/blocks"));
});

// The owners' pages. Anyone else gets 403 (an error Banner page, or JSON for an in-place post) and
// an audit row naming what they tried.
const requireAdmin = (req, res, what) => {
  if (req.user.role === "admin") return true;
  audit(req.user.tailscale_login, what + "_denied", null, null);
  const lang = req.user.lang;
  if (inline(req)) res.status(403).json(refusal(t(lang, "owners_only")));
  else res.status(403).send(bannerPage(t(lang, "forbidden"), req.user, t(lang, "owners_only")));
  return false;
};

// Adoption dashboard (owners). Computed live from the DB (adoption-report.js), the numbers cached
// for 5 minutes so the shell button and repeat views cost nothing; drawn per request in the
// reader's language and frame. Opened from the queue More menu, the Workbench shell's Adoption
// button inside the Axle frame, or at /adoption directly.
let adoptionCache = { at: 0, data: null };
app.get("/adoption", (req, res) => {
  if (!requireAdmin(req, res, "adoption")) return;
  const ADOPT = require("../adoption-report.js");
  if (Date.now() - adoptionCache.at > 5 * 60 * 1000) adoptionCache = { at: Date.now(), data: ADOPT.computeFromDb() };
  audit(req.user.tailscale_login, "view_adoption", null, null);
  res.send(ADOPT.renderHtml(adoptionCache.data, req.user));
});

// Teach Axle review (owners, Phase 6). Pending flags first, each with the email link, the draft as
// the salesperson saw it, and an editable text box: Approve stores the box's text as final_text (so
// Brad's edit IS the gate), Reject keeps the row with status 'rejected'. Decided entries are listed
// below, approved ones as they appear in the prompt, for folding into business-knowledge.md by
// hand. Every decision posts in place and redraws the page.
app.get("/teach", (req, res) => {
  if (!requireAdmin(req, res, "teach")) return;
  const lang = req.user.lang;
  const L = (k) => esc(t(lang, k));
  audit(req.user.tailscale_login, "view_teach", null, null);
  const rows = db.prepare(`SELECT f.*, COALESCE(u.display_name, f.flagged_by) AS who, COALESCE(r.display_name, f.reviewed_by) AS reviewer, w.subject
    FROM teach_flags f LEFT JOIN users u ON u.tailscale_login = f.flagged_by LEFT JOIN users r ON r.tailscale_login = f.reviewed_by
    LEFT JOIN work_items w ON w.id = f.work_item_id
    ORDER BY CASE f.status WHEN 'pending' THEN 0 ELSE 1 END, f.id DESC`).all();
  const pending = rows.filter((f) => f.status === "pending");
  const decided = rows.filter((f) => f.status !== "pending").slice(0, 100);

  const pendingHtml = pending.map((f) => `<section class="wb-card">
      <div class="wb-card__hd"><h2 class="wb-card__t">${esc(f.who)}</h2><span class="wb-hint">${itemLink(f.work_item_id)} ${esc(f.subject || "")} · ${esc(fmtDateTime(f.created_at, lang))}</span></div>
      <form class="wb-card__bd ax-flagform" ${inPlace(`/teach/${f.id}/approve`, t(lang, "teach_approved_toast"))}>
        ${f.draft_snapshot ? `<details class="wb-details"><summary>${L("teach_draft_then")}${icon("chevron-right")}</summary><pre class="ax-pre ax-quiet">${esc(f.draft_snapshot)}</pre></details>` : ""}
        <div class="wb-input wb-input--area"><textarea name="text" maxlength="${K.MAX_TEXT}" required aria-label="${L("teach_col_text")}">${esc(f.text)}</textarea></div>
        <div class="ax-acts"><button class="wb-btn wb-btn--primary">${L("teach_approve")}</button><button class="wb-btn" formaction="${B}/teach/${f.id}/reject" formnovalidate data-toast="${L("teach_rejected_toast")}">${L("teach_reject")}</button></div>
      </form></section>`).join("");

  const status = (f) => pill(t(lang, "teach_" + f.status), f.status === "approved" ? "ok" : "neutral");
  const text = (f) => esc(f.status === "approved" ? K.learnedLine(f) : f.text);
  const reviewed = (f) => [esc(f.reviewer || ""), esc(fmtDateTime(f.reviewed_at, lang))].filter(Boolean).join(" · ");
  const retire = (f, cls) => f.status === "approved"
    ? `<form ${inPlace(`/teach/${f.id}/retire`, t(lang, "teach_retired_toast"))}${cls ? ` class="${cls}"` : ""}><button class="wb-btn wb-btn--sm" data-confirm="${L("teach_retire_confirm")}" data-confirm-ok="${L("teach_retire")}">${L("teach_retire")}</button></form>` : "";
  const decidedHtml = decided.length ? `<h2 class="ax-h2">${L("teach_decided")}</h2>` + tableCard(
    [L("col_status"), L("teach_col_text"), L("teach_col_by"), L("col_email"), `<span class="wb-sr">${L("teach_retire")}</span>`],
    decided.map((f) => `<tr><td>${status(f)}</td><td class="ax-wrap">${text(f)}</td><td class="ax-nowrap">${reviewed(f)}</td><td>${itemLink(f.work_item_id)}</td><td class="wb-num">${retire(f)}</td></tr>`))
    + cardList(decided.map((f) => `<li class="wb-lcard"><span class="wb-lcard__title">${status(f)}</span><span class="wb-lcard__meta ax-lcard-text">${text(f)}</span><span class="wb-lcard__meta">${[reviewed(f), itemLink(f.work_item_id)].filter(Boolean).join(" · ")}</span>${retire(f, "ax-lcard-act ax-lcard-end")}</li>`)) : "";

  res.send(deskPage(t(lang, "teach_page"), req.user, (pendingHtml || emptyCard(t(lang, "teach_none"))) + decidedHtml, { count: pending.length || null }));
});

app.post("/teach/:id/approve", (req, res) => {
  if (!requireAdmin(req, res, "teach")) return;
  const f = db.prepare("SELECT work_item_id, text FROM teach_flags WHERE id = ?").get(req.params.id);
  const final = f && K.approve(db, req.params.id, req.user.tailscale_login, req.body.text);
  if (final) audit(req.user.tailscale_login, "teach_approve", f.work_item_id, `#${req.params.id}${final !== f.text ? " (edited)" : ""} ${final.slice(0, 100)}`);
  res.redirect(BASE.url("/teach"));
});

app.post("/teach/:id/retire", (req, res) => {
  if (!requireAdmin(req, res, "teach")) return;
  const f = db.prepare("SELECT work_item_id, final_text FROM teach_flags WHERE id = ?").get(req.params.id);
  if (f && K.retire(db, req.params.id, req.user.tailscale_login)) {
    audit(req.user.tailscale_login, "teach_retire", f.work_item_id, `#${req.params.id} ${String(f.final_text || "").slice(0, 100)}`);
  }
  res.redirect(BASE.url("/teach"));
});

app.post("/teach/:id/reject", (req, res) => {
  if (!requireAdmin(req, res, "teach")) return;
  const f = db.prepare("SELECT work_item_id, text FROM teach_flags WHERE id = ?").get(req.params.id);
  if (f && K.reject(db, req.params.id, req.user.tailscale_login)) {
    audit(req.user.tailscale_login, "teach_reject", f.work_item_id, `#${req.params.id} ${f.text.slice(0, 100)}`);
  }
  res.redirect(BASE.url("/teach"));
});

// Pending count for the Workbench shell badge. JSON, admin only, not audited (polled).
app.get("/teach/count", (req, res) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "admin only" });
  res.json({ pending: K.pendingCount(db) });
});

// Audit log viewer (owners). Searchable over the WHOLE table (not just the newest 500): free text
// runs a parameterised LIKE across user/action/detail (wildcards escaped, so input is matched
// literally), combinable with an action-type select and an email filter. Results stay capped at the
// newest 500 matches. The search itself is audit-logged. A filter applies on change or Enter.
app.get("/audit", (req, res) => {
  if (!requireAdmin(req, res, "audit")) return;
  const lang = req.user.lang;
  const L = (k) => esc(t(lang, k));
  const q = String(req.query.q || "").trim().slice(0, 100);
  const act = String(req.query.action || "").trim().slice(0, 60);
  const item = parseInt(String(req.query.item || ""), 10) || 0;
  audit(req.user.tailscale_login, "view_audit", null,
    (q || act || item) ? `q=${q || "-"} action=${act || "-"} item=${item || "-"}` : null);

  const conds = [], params = [];
  if (q) {
    const like = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    conds.push("(user LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR COALESCE(detail, '') LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  if (act) { conds.push("action = ?"); params.push(act); }
  if (item) { conds.push("work_item_id = ?"); params.push(item); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const rows = db.prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT 500`).all(...params);
  const actionNames = db.prepare("SELECT DISTINCT action FROM audit_log ORDER BY action").all().map((r) => r.action);

  const filtered = !!(q || act || item);
  const form = `<form class="ax-filters" method="get" action="${B}/audit" role="search" data-autosubmit>
      <div class="wb-input"><span class="wb-adorn">${icon("search")}</span><input type="search" name="q" value="${esc(q)}" placeholder="${L("audit_ph")}" aria-label="${L("audit_ph")}" autocomplete="off" enterkeyhint="search"></div>
      <div class="wb-input wb-input--select"><select name="action" aria-label="${L("col_action")}"><option value="">${L("audit_any")}</option>${actionNames.map((a) => `<option value="${esc(a)}"${a === act ? " selected" : ""}>${esc(a)}</option>`).join("")}</select>${icon("chevron-down")}</div>
      <div class="wb-input"><input name="item" value="${item || ""}" inputmode="numeric" placeholder="${L("audit_item_ph")}" aria-label="${L("audit_item_ph")}" autocomplete="off"></div>
      <button class="wb-sr">${L("search")}</button>
    </form>`;
  const note = !filtered ? t(lang, "audit_note") : rows.length === 500 ? t(lang, "audit_capped")
    : rows.length === 1 ? t(lang, "audit_match_1") : t(lang, "audit_matches").replace("{n}", rows.length);
  const who = (u) => `<span title="${esc(u)}">${esc(String(u).replace(/@.*$/, "@"))}</span>`;
  const when = (r) => esc(fmtDateTime(r.ts, lang));
  const list = rows.length ? tableCard(
    [L("col_when_b"), L("col_user"), L("col_action"), L("col_email"), L("col_detail")],
    rows.map((r) => `<tr><td class="ax-nowrap">${when(r)}</td><td>${who(r.user)}</td><td>${esc(r.action)}</td><td>${itemLink(r.work_item_id)}</td><td class="ax-wrap">${esc(r.detail || "")}</td></tr>`), true)
    + cardList(rows.map((r) => `<li class="wb-lcard"><span class="wb-lcard__title">${esc(r.action)}</span><span class="wb-lcard__meta">${[who(r.user), when(r), itemLink(r.work_item_id)].filter(Boolean).join(" · ")}</span>${r.detail ? `<span class="wb-lcard__meta ax-lcard-text">${esc(r.detail)}</span>` : ""}</li>`))
    : "";
  res.send(deskPage(t(lang, "audit_log"), req.user,
    `${form}<p class="wb-hint ax-countline"><span>${esc(note)}</span>${filtered ? `<a class="wb-link" href="${B}/audit">${L("audit_clear")}</a>` : ""}</p>${list}`));
});

};
