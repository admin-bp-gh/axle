// routes/item.js - the item detail page and its actions: inbound attachments,
// outbound attachment staging, work-form save/redraft, language re-tag, owner
// reassign, reply translation, SAP-document attach (draft-only staging) and status
// changes. Extracted VERBATIM from server.js (UI rework Step 0, 2026-06-10).
// NOT here, deliberately: /item/:id/send and /item/:id/contactform-recipient stay
// in server.js - the send/recipient safety paths do not move in this refactor.
// Redesign phase 2 (2026-10-07), Email C: one work area, the email beside the reply from 1280 up,
// one column below. Every action posts in place through assets/axle.js (data attributes, no inline
// script) to the same routes with the same fields; the routes, guards and audit rows are unchanged.
const C = require("../connectors.js");
const TR = require("../translate.js");
const SCEN = require("../scenarios.js");
const SAPDOC = require("../sap-doc-pdf.js");       // render a referenced SAP document to its Boyum print PDF (read-only)
const DOCSUGGEST = require("../doc-suggest.js");   // Auto-attach: resolve + scope-filter referenced documents (read-only)
const CUSTSUM = require("../customer-summary.js"); // FR-0002: read-only customer at-a-glance + detail
const PHONE = require("../phone-numbers.js");       // a phone number's tel: target
const RSET = require("../recipient-set.js");       // the single definition of an item's known addresses
const FG = require("../forward-guard.js");         // handover forward: deterministic internal-only guardrails
const FWD = require("../forward.js");              // handover forward: the Graph call (Mail.Send)
const SG = require("../send-guard.js");            // only for needsConfirmedRecipient (the UI mirror of the send refusal)
const DS = require("../draft-staleness.js");       // is the newest stored draft still this email's draft?
const { db, audit } = require("../db.js");
const { esc, t, page, splitQuoted, fmtSize, replyParas, pill, icon, iconBtn, TR_SKEL,
        fmtDateTime, statusWithRes, suggestCloseChip, intentLabel, langDisplay, ownerLabel,
        ownerChoices, renderTimeline, workPanes, shell, lazyQueue, deskPage, bannerHtml, bannerPage,
        notFoundPage } = require("../views/ui.js");
const { anthropic, MAILBOX_OF, MAX_ATTACH_BYTES, runRedraft, markReadSafe,
        isContactFormItem, isReturnNotificationItem, itemKind, itemCardCode, customerEmails, saveWorkInputs, addAttachment,
        latestWithdrawn, latestDraftVersion } = require("./shared.js");
const WA = require("../withdrawn-attempt.js");     // why the reply box is empty after a gate withdrew the draft
const K = require("../knowledge.js");              // Teach Axle: text cap + sanitiser for flags
const MS = require("../message-store.js");         // the thread's stored messages and attachments (files on disk)
const SEARCH = require("../search.js");            // keeps the customer resolved here in the search index
const BASE = require("../base-path.js");          // AXLE_BASE_PATH URL prefix
const FMT = require("../reply-format.js");        // formatting markers: the reply translates as plain text
const CC = require("../cc-list.js");               // the reply's Cc (list, suggestions); routes in server.js
const DM = require("../draft-media.js");           // the customer files the latest draft could not be shown
const ED = require("../assets/axle-editor.js");    // the reply editor's model: its first view is rendered here
const fs = require("fs");
const path = require("path");

// Resolver-backed address lookups, built once. Best-effort by contract (see recipient-set.js).
const RSET_DEPS = RSET.defaultDeps();

module.exports = function mountItem(app, { ACTION_COMPOSE_SEND, ACTION_CONTACTFORM_SEND, ACTION_RETURN_SEND, ACTION_OWNER_FORWARD }) {

// The reply grammar for the editor in the browser (assets/axle-editor.js reads window.AxleFormat):
// reply-format.js itself, wrapped at start-up so its module.exports lands there. One grammar for the
// send path, the displays and the editor, never a copy. Served beside the static assets (express
// static passes a miss on to the routes).
const FMT_JS = `(function (module) {\n${fs.readFileSync(path.join(__dirname, "..", "reply-format.js"), "utf8")}\n})(window.AxleFormat = { exports: {} });\n`;
app.get("/assets/reply-format.js", (req, res) => res.type("js").set("Cache-Control", "public, max-age=3600").send(FMT_JS));

// A proposed subject for a return-request reply (NEW outbound, no "Re:"), order-ref-aware and in the
// customer's language (work_items.language). Deterministic default; the salesperson can edit it.
function returnSubject(rn, orderRef, draftLang) {
  const nl = String(draftLang || "").toLowerCase() === "nl";
  const ref = orderRef || (rn && rn.parsed && rn.parsed.orderRef) || "";
  if (nl) return `Je retouraanvraag${ref ? " " + ref : ""}`;
  return `Your return request${ref ? " " + ref : ""}`;
}

// A proposed subject for a contact-form reply (a NEW outbound, so no "Re:"). Order-ref-aware,
// in the customer's language. Deterministic default; the salesperson can edit it before sending.
// Proposed subject for a NEW outbound contact-form reply. Language follows the DRAFT
// (work_items.language = the customer's actual message language), NOT the country map
// (cf.language), so an English draft never gets a Dutch subject. Order-ref wins when present.
function contactFormSubject(cf, draftLang) {
  const ref = cf && cf.parsed && cf.parsed.orderRef;
  if (ref) return `${ref} - RoverParts.eu`;
  return draftLang === "nl" ? "Uw bericht aan RoverParts.eu" : "Your message to RoverParts.eu";
}

// --- Auto-attach: suggested documents for an inbound item (READ-ONLY) -------------------
// Compute (Step 3) the SAP documents this email appears to reference and that belong to the
// email's customer, so the salesperson can one-click attach them instead of typing the number.
// This only READS SAP via the deterministic resolve+scope filter; it renders/stages NOTHING (the
// one-click reuses the existing /attach-doc route behind the approval gate). Safety: skip
// injection-flagged items entirely (surface nothing automatically), skip compose/contact-form
// (the feature is about inbound customer emails). A failure here must never break the item page.
//
// Lazy + cached by (item, latest inbound message). Step 4 moves this to ingest-time storage and
// adds the inbox hint + model hint; until then the cache keeps repeat views and auto-refresh cheap.
const _suggCache = new Map();   // key -> { suggestions }
async function computeItemSuggestions(w) {
  if (!w || isContactFormItem(w) || w.injection_flag) return { suggestions: [] };
  // Prefer the stored result (instant): computed at ingest for inbound, at draft time for compose
  // (FR-0004 - the compose branch of runRedraft scopes it to the resolved compose customer).
  if (w.doc_suggestions_json != null) {
    try { return { suggestions: JSON.parse(w.doc_suggestions_json) || [] }; } catch (e) { /* fall through to lazy compute */ }
  }
  // The lazy fallback below resolves customer scope from the SENDER, so it is INBOUND-only. A compose
  // item has no inbound sender; its suggestions are computed from the compose customer at draft time,
  // so when none are stored there are simply none to show.
  if (w.origin === "compose") return { suggestions: [] };
  // Lazy fallback (older items ingested before this feature, or a transient ingest error): compute
  // once and cache per (item, latest inbound message). Same deterministic, read-only path as ingest.
  if (!w.sender_email || !w.email_text) return { suggestions: [] };
  const key = w.id + ":" + (w.latest_message_id || "");
  if (_suggCache.has(key)) return _suggCache.get(key);
  let out = { suggestions: [] };
  try { out = { suggestions: await DOCSUGGEST.suggestForEmail(w.sender_email, w.email_text, {}) }; }
  catch (e) { audit("system", "suggest_error", w.id, String(e.message || e).slice(0, 150)); }
  if (_suggCache.size >= 500) _suggCache.delete(_suggCache.keys().next().value); // bound memory (oldest-out)
  _suggCache.set(key, out);
  return out;
}

// The file name a SAP document gets on the draft; also how "already attached" is recognised.
const docTypeOf = (objectId) => Object.keys(SAPDOC.DOC_TYPES).find((k) => SAPDOC.DOC_TYPES[k].objectId === objectId) || "order";
const docFileName = (d) => SAPDOC.DOC_TYPES[docTypeOf(d.objectId)].prefix + "-" + d.docNum + ".pdf";

// Money in the UI language: "€ 1.234,56" in Dutch, "€1,234.56" in English.
const fmtMoney = (n, cur, lang) =>
  new Intl.NumberFormat(lang === "nl" ? "nl-NL" : "en-GB", { style: "currency", currency: cur || "EUR" }).format(Number(n) || 0);

// A small result page for a request that was not made in place (a browser without script or an old
// tab): the outcome as a Banner, any choices under it, and the way back to the email.
const backTo = (req, w) => ({ href: `${BASE.path}/item/${w.id}`, label: t(req.user.lang, "back_email") });
const resultPage = (req, w, title, message, html) => deskPage(title, req.user,
  bannerHtml("warn", esc(message)) + (html ? `<section class="wb-card"><div class="wb-card__bd ax-result">${html}</div></section>` : ""), { back: backTo(req, w) });

// One SAP document as the reply card names it: "Invoice 431086 · € 111,26".
const docLabel = (d, lang) => `${t(lang, "doc_" + docTypeOf(d.objectId))} ${d.docNum}${d.docTotal != null ? " · " + fmtMoney(d.docTotal, d.docCur, lang) : ""}`;

// A document as a choice in a dialog: type and number, customer, total, date.
const docChoice = (d, lang) => [docLabel(d, lang), [d.cardCode, d.cardName].filter(Boolean).join(" "),
  d.docDate ? new Date(d.docDate).toLocaleDateString(lang === "nl" ? "nl-NL" : "en-GB", { day: "numeric", month: "short", year: "numeric" }) : ""].filter(Boolean).join(" · ");

// A short warning or note line inside a card.
const note = (tone, text) => `<p class="ax-note" data-tone="${tone}">${icon("alert")}<span>${esc(text)}</span></p>`;

// The suggested documents of an inbound email (stored at ingest, read-only), minus those already on
// the draft. Each becomes a one-click chip on the reply card; every chip posts the proven
// /attach-doc route, so this renders and stages nothing itself.
//  in_scope: the chip posts doctype, docnum and docentry; the document is staged at once.
//  ambiguous: the chip opens a dialog with one button per in-scope candidate (validated in-set by
//    the route), as the old per-candidate buttons; with one candidate left it is a plain chip.
//  out_of_scope: the chip posts WITHOUT confirm, exactly as the old Review button, so the route's
//    scope warning comes back and the dialog shows it with "Attach anyway" (SCOPE-OVERRIDE audit).
function suggestionParts(w, suggestions, lang, attachedNames) {
  const have = new Set(attachedNames || []);
  const list = (suggestions || [])
    .map((s) => Object.assign({}, s, { docs: s.docs.filter((d) => !have.has(docFileName(d))) }))
    .filter((s) => s.docs.length && ["in_scope", "ambiguous", "out_of_scope"].includes(s.status));
  const form = (fid, d) => `<form id="${fid}" method="post" action="${BASE.path}/item/${w.id}/attach-doc" data-inline hidden>
    <input type="hidden" name="doctype" value="${esc(docTypeOf(d.objectId))}"><input type="hidden" name="docnum" value="${esc(String(d.docNum))}"><input type="hidden" name="docentry" value="${esc(String(d.docEntry))}"></form>`;
  let chips = "", forms = "", dialogs = "";
  list.forEach((s, i) => {
    if (s.status === "ambiguous" && s.docs.length > 1) {
      chips += `<button type="button" class="wb-pillbtn" data-overlay="ax-amb-${i}">${icon("plus")}${esc(s.reference.raw)} · ${esc(t(lang, "sugg_n_docs").replace("{n}", s.docs.length))}</button>`;
      forms += s.docs.map((d, j) => form(`ax-sd-${i}-${j}`, d)).join("");
      dialogs += overlay(`ax-amb-${i}`, t(lang, "pick_doc"), lang,
        `<p>${esc(t(lang, "sugg_pick"))}</p><div class="ax-choices">${s.docs.map((d, j) =>
          `<button type="submit" form="ax-sd-${i}-${j}" class="wb-menu__item">${icon("plus")}<span>${esc(docChoice(d, lang))}</span></button>`).join("")}</div>`,
        `<button type="button" class="wb-btn" data-close>${esc(t(lang, "cancel"))}</button>`);
      return;
    }
    const d = s.docs[0];
    const off = s.status === "out_of_scope";
    chips += `<button type="submit" form="ax-sd-${i}" class="wb-pillbtn"${off ? ` data-tone="warn" title="${esc(t(lang, "sugg_other_cust_hint"))}"` : ""}>${icon("plus")}${esc(docLabel(d, lang))}</button>`;
    forms += form(`ax-sd-${i}`, d);
  });
  return { chips, forms, dialogs };
}

// An overlay as AXLE-JS.md describes it, in a <template> (cloned on open, removed on close).
// opts.form: it holds a text field, so it is a Page on the phone; opts.kind: dialog (default) or drawer.
function overlay(id, title, lang, body, foot, opts = {}) {
  return `<template id="${id}"><div class="ax-ov" data-kind="${opts.kind || "dialog"}"${opts.form ? " data-form" : ""} role="dialog" aria-modal="true" aria-label="${esc(title)}">
  <div class="ax-ov__hd">${iconBtn(t(lang, "back"), "back", "data-close", "ax-ov__back")}<h2 class="ax-ov__t">${esc(title)}</h2>${iconBtn(t(lang, "close"), "x", "data-close", "ax-ov__x")}</div>
  ${opts.bodyTag ? body : `<div class="ax-ov__bd"><div data-ax-banner></div>${body}</div>`}
  ${foot ? `<div class="ax-ov__ft">${foot}</div>` : ""}
</div></template>`;
}

// --- FR-0002: the customer, read-only (itemCardCode lives in routes/shared.js) ---------------
// The customer as one quiet line (s = summary from customer-summary.js): name, card code, country,
// discount tier, open orders and open invoices with their money; "On hold" when frozen, "Best
// guess" for a voicemail whose number sits on several cards.
function customerLine(s, lang, opts = {}) {
  const count = (n, k) => t(lang, k + (n === 1 ? "_1" : "_n")).replace("{n}", n);
  const parts = [s.cardName || s.cardCode, s.cardCode, s.country, s.tier,
    count(s.openOrders, "cust_orders") + (s.openOrders ? ` (${fmtMoney(s.openOrdersVal, s.currency, lang)})` : ""),
    count(s.openInvoices, "cust_invoices") + (s.openInvoices ? ` (${fmtMoney(s.openInvOutstanding, s.currency, lang)})` : "")];
  return `<p class="ax-cust">${parts.filter(Boolean).map(esc).join(" · ")}${s.frozen ? " " + pill(t(lang, "cust_frozen"), "warn") : ""}${opts.guess ? " " + pill(t(lang, "cust_best_guess"), "warn", `title="${esc(t(lang, "cust_best_guess_tip"))}"`) : ""}</p>${contactLine(s, lang)}`;
}

// The customer's addresses and numbers from SAP (round 2, request 13), a quiet second line: the
// addresses as plain text to select and copy, the numbers as tel: links, a small icon before each
// kind (its name for a screen reader). Nothing when SAP holds neither.
function contactLine(s, lang) {
  const emails = s.emails || [], phones = s.phones || [];
  if (!emails.length && !phones.length) return "";
  const kind = (ic, label, items) => items.map((html, n) => `<span class="ax-ci">${n ? "" : `${icon(ic)}<span class="wb-sr">${esc(t(lang, label))}: </span>`}${html}</span>`).join("");
  const tel = (p) => { const n = PHONE.telHref(p); return n ? `<a class="wb-link" href="tel:${esc(n)}">${esc(p)}</a>` : esc(p); };
  return `<p class="ax-contact">${kind("mail", "contact_email", emails.map(esc))}${kind("phone", "contact_phone", phones.map(tel))}</p>`;
}

// Voicemail items (Change A, A5): the names to ask for on the call back. Three read-only sources,
// merged by connectors.callerPeople: the SAP contact whose number matched, people who have emailed
// us from this customer's on-file addresses (the resolver's own address set, our mailboxes
// skipped), and SAP contact persons. Best effort: any failure returns "" and the page carries on.
async function voicemailPeople(w, cardCode, lang) {
  try {
    let addrs = [];
    try { addrs = await RSET_DEPS.addressesByCardCode(cardCode); } catch (e) { addrs = []; }
    const OB = require("../outlook-block.js");
    addrs = [...new Set(addrs.map((a) => String(a || "").trim().toLowerCase()).filter((a) => a && !OB.isInternal(a)))];
    const emailers = addrs.length ? db.prepare(
      `SELECT TRIM(sender_name) AS name, MAX(COALESCE(email_received, created_at)) AS last FROM work_items
       WHERE LOWER(TRIM(sender_email)) IN (${addrs.map(() => "?").join(", ")})
         AND TRIM(COALESCE(sender_name, '')) <> '' AND sender_name NOT LIKE '%@%'
       GROUP BY LOWER(TRIM(sender_name)) ORDER BY last DESC LIMIT 12`
    ).all(...addrs) : [];
    let sap = [];
    try { sap = await C.contactPersons(cardCode); } catch (e) { sap = []; }
    const people = C.callerPeople({ matched: w.caller_contact, sap, emailers });
    if (!people.length) return "";
    const when = (iso) => { const d = new Date(iso); return isNaN(d) ? "" : d.toLocaleDateString(lang === "nl" ? "nl-NL" : "en-GB", { day: "numeric", month: "short", year: "numeric" }); };
    const row = (p) => `<li>${p.matched ? `<b>${esc(p.name)}</b> ${pill(t(lang, "vm_people_matched"), "ok")}` : esc(p.name)}`
      + (p.position ? ` · ${esc(p.position)}` : "")
      + (p.last && when(p.last) ? ` · ${esc(t(lang, "vm_people_last_email"))} ${esc(when(p.last))}` : "") + "</li>";
    return `<div class="ax-people"><span class="wb-label">${esc(t(lang, "vm_people_title"))}</span><ul>${people.map(row).join("")}</ul></div>`;
  } catch (e) {
    audit("system", "voicemail_people_error", w.id, String(e.message || e).slice(0, 150));
    return "";
  }
}

// The detail-modal body (GET /customer-modal, kept for its route; the email screen no longer opens it).
function customerModalBody(d, lang) {
  const s = d.summary;
  const money = (n) => fmtMoney(n, s.currency, lang);
  const stat = (label, val) => `<div class="wb-card ax-stat"><span class="wb-label">${esc(label)}</span><b>${esc(val)}</b></div>`;
  const rows = (list, open) => list.length ? list.map((o) =>
    `<tr><td>${esc(String(o.docNum))}</td><td>${esc(o.docDate || "")}</td><td class="wb-num">${esc(money(o.total))}</td><td>${open(o)}</td></tr>`).join("")
    : `<tr><td colspan="4">${esc(t(lang, "cust_none"))}</td></tr>`;
  const table = (title, list, open) => `<h4 class="ax-h2">${esc(t(lang, title))}</h4><table class="wb-table"><thead><tr><th>${esc(t(lang, "col_doc"))}</th><th>${esc(t(lang, "col_date"))}</th><th class="wb-num">${esc(t(lang, "col_total"))}</th><th>${esc(t(lang, "col_status"))}</th></tr></thead><tbody>${rows(list, open)}</tbody></table>`;
  return `<h3 class="ax-h2">${esc(s.cardName || s.cardCode)}${s.frozen ? " " + pill(t(lang, "cust_frozen"), "warn") : ""}</h3>
    <p class="wb-hint">${[s.cardCode, s.country, s.group, s.tier].filter(Boolean).map(esc).join(" · ")}</p>
    <div class="ax-stats">${stat(t(lang, "cust_lifetime"), money(d.stats.lifetimeInv))}${stat(t(lang, "cust_12m"), money(d.stats.inv12m))}${stat(t(lang, "cust_balance"), money(s.balance))}${stat(t(lang, "cust_since"), d.stats.firstInv || "-")}${stat(t(lang, "cust_last_order"), d.stats.lastOrder || "-")}</div>
    ${table("cust_recent_orders", d.orders, (o) => pill(t(lang, o.open ? "cust_open" : "cust_closed"), o.open ? "warn" : "ok"))}
    ${table("cust_recent_invoices", d.invoices, (i) => i.open ? pill(t(lang, "cust_unpaid") + " " + money(i.outstanding), "warn") : pill(t(lang, "cust_paid"), "ok"))}`;
}

// The email asked for does not exist: a bad banner that says so, and Retry (an in-place GET).
const notFound = (lang, url) => `<div class="wb-banner" data-tone="bad" role="alert">${icon("alert")}<div class="wb-banner__body"><b>${esc(t(lang, "load_failed_title"))}</b> ${esc(t(lang, "not_found"))}</div><button type="button" class="wb-btn wb-btn--sm" hx-get="${esc(url)}" hx-target="#workpane" hx-swap="innerHTML">${icon("refresh")}<span>${esc(t(lang, "retry"))}</span></button></div>`;

app.get("/item/:id", async (req, res) => {
  const lang = req.user.lang;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) {
    // An in-place open gets an email-shaped not-found pane so the swap stays tidy; a plain
    // navigation gets the full page exactly as before.
    if (req.get("HX-Request")) return res.status(404).send(workPanes(notFound(lang, req.originalUrl), "", { title: t(lang, "load_failed_title"), lang }));   // C4 / M-51
    return res.status(404).send(notFoundPage(req.user));
  }
  audit(req.user.tailscale_login, "view_item", w.id, `lang=${lang}`);
  MS.healItem(w);   // background: an open email's missing thread, or a failed listing or fetch, is tried again
  const isCompose = w.origin === "compose";   // a proactively-composed outbound item (no inbound email)
  const isContactForm = isContactFormItem(w);  // webshop contact-form msg: real recipient is in the body, not the sender
  const isRN = isReturnNotificationItem(w);    // Shopify "Return items" notification: reply goes to the order's customer

  // Contact-form enrichment (from ingest): parsed customer + candidate addresses. Parsed once
  // here so both the work form (subject) and the information card below can use it.
  let cf = null;
  if (isContactForm) { try { cf = JSON.parse(w.contact_form_json || "null"); } catch (e) { cf = null; } }
  const cfSubjectDefault = isContactForm ? contactFormSubject(cf, w.language || lang) : "";

  // Return-notification enrichment (from ingest): parsed order ref + resolved customer + candidate
  // addresses. Same shape as the contact form so the information card renders the same way.
  let rn = null;
  if (isRN) { try { rn = JSON.parse(w.return_json || "null"); } catch (e) { rn = null; } }
  const rnSubjectDefault = isRN ? returnSubject(rn, rn && rn.parsed && rn.parsed.orderRef, w.language || lang) : "";

  // AI reference drafts (source='ai'); human-sent drafts are kept separately for the audit
  // trail and must not be shown as "the AI draft".
  const fullRow = db.prepare("SELECT * FROM drafts WHERE work_item_id = ? AND is_interim = 0 AND source = 'ai' ORDER BY version DESC, id DESC LIMIT 1").get(w.id);
  const interimRow = db.prepare("SELECT * FROM drafts WHERE work_item_id = ? AND is_interim = 1 AND source = 'ai' ORDER BY version DESC, id DESC LIMIT 1").get(w.id);

  // A DRAFT WRITTEN BEFORE THE CURRENT EMAIL ARRIVED IS NOT THIS EMAIL'S DRAFT (2026-08-15, item
  // 1308). The item reopens on each new message in the thread, but a run that writes no draft row,
  // a no_reply outcome (suggest_close), or a run that errored, leaves the PREVIOUS round's draft as
  // the newest, and the queries above then present it as the current reply. See draft-staleness.js
  // for the full case and the reasoning behind the test.
  const fullStale = DS.isSupersededDraft(w, fullRow);
  const interimStale = DS.isSupersededDraft(w, interimRow);
  const interim = interimStale ? null : interimRow;

  // HELD ITEMS MUST NOT OFFER A SUPERSEDED DRAFT (2026-08-12, found live-verifying item 1249).
  // When a run holds the reply it emits no full draft, so ingest inserts no row, and this query
  // used to fall back to the PREVIOUS run's draft and present it as the current AI draft under
  // "this exact text goes to the customer". On 1249 that meant the very sentences the accuracy
  // gates had just refused ("it matches your VIN perfectly", "ships directly from our supplier")
  // sat in the send box, one click from the customer. Holding a draft is pointless if the
  // superseded one stays sendable.
  //
  // status='awaiting_input' is the invariant: a held run always clears result.draft (the
  // two-stage prompt rule, applyFitmentGate and holdDraft all do), so an awaiting_input item can
  // never have a CURRENT full draft, anything found is from an earlier run. Drop it, and let the
  // send box fall through to the INTERIM: the current run's only-what-we-know reply, which is
  // written to be safe to send exactly as-is. A human's own saved edit (draft_edit) always wins;
  // that is their text, not ours.
  const held = w.status === "awaiting_input" && !!fullRow;
  const full = (held || fullStale) ? null : fullRow;
  // The dropped draft is still worth seeing, it is the research from the previous round, but only
  // as read-only history, clearly labelled and out of the send path. Held drafts stay hidden (above).
  const supersededRow = fullStale ? fullRow : (interimStale ? interimRow : null);
  // Withdrawn drafts (source='withdrawn') are still recorded for the audit trail, but they are
  // NOT shown as a draft: a red "withdrawn" card next to a perfectly good reply reads as breakage
  // rather than as care. The reply the salesperson sees is simply the current, safe one.
  // What IS shown (item #2368, 2026-09-30): when the CURRENT run withdrew its draft and the box is
  // therefore empty, a short notice saying so and why, with the withdrawn text folded away as
  // reference. An empty box with no explanation read as "Redraft does nothing".
  const questions = db.prepare("SELECT * FROM questions WHERE work_item_id = ? ORDER BY id").all(w.id);
  const open = questions.filter((q) => !q.answer);
  const withdrawn = (w.status === "awaiting_input" && !full && !w.draft_edit)
    ? WA.withdrawnNotice(w, latestWithdrawn(w.id), latestDraftVersion(w.id), open) : null;
  const busy = w.status === "investigating";
  const closed = ["done", "archived"].includes(w.status);
  const thread = MS.itemThread(w.id);   // the stored messages: their attachments, and the Cc the customer copied
  const editable = !busy && !closed;
  const sentRow = db.prepare("SELECT * FROM sends WHERE work_item_id = ? AND status = 'sent' ORDER BY id DESC LIMIT 1").get(w.id);
  // Send is allowed any time the item isn't flagged (questions need not be answered first);
  // an injection-flagged item can NEVER send. The body is re-validated by send-guard on submit.
  // compose: action #3 OFF -> never a Send button. contact-form (action #4): the sender is
  // Shopify's mailer, not the customer, so a send is a NEW outbound to the code-held recipient
  // (the form address, applied at ingest) - allowed only when action #4 is enabled AND an address
  // is held. No human confirmation step: the address is on the To line, editable there.
  const cfCanSend = isContactForm && ACTION_CONTACTFORM_SEND && !!w.recipient;
  const composeCanSend = isCompose && ACTION_COMPOSE_SEND && !!w.recipient;
  const rnCanSend = isRN && ACTION_RETURN_SEND && !!w.recipient;
  // internal_forward: a colleague handed this customer email to us, so the thread sender is one of
  // OUR OWN mailboxes. Replying to the sender would mail ourselves, so send-guard refuses until a
  // recipient is confirmed - mirrored here so the To line says "Choose recipient" and Send waits.
  const fwdNeedsRecipient = SG.needsConfirmedRecipient(w);
  // Voicemail items are phone only: send-guard always refuses them, so there is no reply (Change A).
  const isVoicemail = SG.isVoicemailItem(w);
  const canSend = editable && !w.injection_flag && !fwdNeedsRecipient && !isVoicemail
    && (!isCompose || composeCanSend) && (!isContactForm || cfCanSend) && (!isRN || rnCanSend);
  // The editable reply: the human's saved edit if any, else the AI full draft, else the holding reply.
  const replyText = w.draft_edit != null ? w.draft_edit : (full ? full.body : (interim ? interim.body : ""));
  const atts = db.prepare("SELECT id, name, content_type, size FROM draft_attachments WHERE work_item_id = ? ORDER BY id").all(w.id);

  // Auto-attach: SAP documents this inbound email references and that belong to its customer
  // (read-only; rendered/staged only when the human clicks a chip, via the existing /attach-doc
  // route). Skipped for compose/contact-form/injection-flagged items inside the helper.
  const sugg = editable ? suggestionParts(w, (await computeItemSuggestions(w)).suggestions, lang, atts.map((a) => a.name)) : null;

  // FR-0002: the customer line (read-only; 3-min cached). Shown whenever the item resolves to a
  // SAP customer (inbound sender, compose customer or voicemail caller); "Not a SAP customer" for an
  // inbound email whose sender is unknown. Wrapped so SAP slowness/errors never break the page.
  let custHtml = "";
  let custName = "";   // names the customer in the typed-recipient warning
  try {
    const card = await itemCardCode(w);
    if (card) {
      const s = await CUSTSUM.summarise(card);
      const isVm = SG.isVoicemailItem(w);
      if (s) custHtml = customerLine(s, lang, { guess: isVm && !!w.caller_card_guess });
      if (s) SEARCH.rememberCustomer(w.id, s.cardCode, s.cardName);
      if (isVm && s) custHtml += await voicemailPeople(w, card, lang);
      custName = (s && s.name) || "";
    } else if (!isCompose && !isContactForm && !isRN) {
      custHtml = `<p class="ax-cust">${esc(t(lang, "not_sap"))}</p>`;
    }
  } catch (e) { audit("system", "cust_summary_error", w.id, String(e.message || e).slice(0, 150)); }

  // The recipient menu's option set: the thread sender plus whatever the deterministic resolver
  // holds for THIS item's customer. Best-effort, recipient-set swallows a SAP failure, so a slow
  // or dead SAP costs a menu row, never the page. Not computed for items that can't be edited,
  // and never for an injection-flagged item (which must not be offered a redirect UI at all).
  const kind = itemKind(w);
  let knownAddrs = [];
  if (editable && !w.injection_flag) {
    try { knownAddrs = await RSET.knownAddressesFor(w, kind, RSET_DEPS); }
    catch (e) { audit("system", "recipient_set_error", w.id, String(e.message || e).slice(0, 150)); }
  }

  // --- On-view translation into the viewer's language (cached -> inline; uncached -> async).
  // Only CACHED translations render inline (a sync DB hit); anything uncached renders a pending
  // placeholder and axle.js fills it from POST /item/:id/translations in the background. Every
  // later view hits the cache and renders inline again.
  const custLang = (w.language || "").toLowerCase();
  const needContent = custLang && custLang !== lang;
  let emailTr = null, emailTrPending = false;
  if (needContent && !isCompose) {
    const top = splitQuoted(String(w.email_text || "")).top;
    if (top.trim()) { emailTr = TR.cached(lang, top); emailTrPending = !emailTr; }
  }
  const qTr = {};
  if (lang !== "en") for (const q of questions) {
    const c = TR.cached(lang, q.question);
    if (c) qTr[q.id] = c;
  }
  const qText = (q) => (lang !== "en" && qTr[q.id]) || q.question;
  // Marks the question text for the background fill (English shows until it lands).
  const qTrAttr = (q) => (lang !== "en" && !qTr[q.id]) ? ` data-trq="${q.id}"` : "";

  const L = (k) => esc(t(lang, k));
  const U = (p) => `${BASE.path}/item/${w.id}${p || ""}`;
  const admin = req.user.role === "admin";
  const srcLabel = { sender: t(lang, "recip_from_sender"), onfile: t(lang, "recip_on_file"),
                     form: t(lang, "recip_from_form"), typed: t(lang, "recip_typed") };

  // --- The title row: the subject, then the pills. The status (with the closed resolution
  // wording), P1, the injection warning, the compose and contact-form markers, the intent (the
  // scenario on a compose item), the suggest-close hint and the owner, a menu where it can change.
  const stTone = w.injection_flag && !closed ? "bad" : ({ ready: "ok", awaiting_input: "warn", investigating: "info" })[w.status] || "neutral";
  const statusPill = (cls) => `<span class="wb-pill${cls ? " " + cls : ""}" data-tone="${stTone}"><i class="wb-dot" aria-hidden="true"></i>${esc(statusWithRes(lang, w))}</span>`;
  const scen = isCompose && w.scenario ? SCEN.byKey(w.scenario) : null;
  const ownerOpts = ownerChoices(w.mailbox);
  // An owner who works a DIFFERENT mailbox is a handover, not a relabel: picking them forwards
  // the email to their mailbox and closes this item. Those rows say so and ask first in a dialog
  // (data-confirm, read as data, never compiled as JS). forward-guard is the single source of that
  // decision, so the menu and the route agree.
  const ownerRow = (o) => {
    const on = o === (w.owner || "");
    const target = !on && ACTION_OWNER_FORWARD ? FG.forwardTargetFor(w.mailbox, o) : null;
    const act = on ? "" : ` data-submit="ax-f-owner" name="owner" value="${esc(o)}"` + (target
      ? ` data-confirm="${esc(t(lang, "owner_handover_confirm", { owner: o, address: target.address }))}" data-confirm-ok="${L("owner_handover_ok")}" data-next data-toast="${esc(t(lang, "handed_over", { owner: o }))}"` : "");
    return `<button type="button" class="wb-menu__item" role="menuitemradio" aria-checked="${on}"${act}><span>${esc(o)}${target ? `<small>${L("owner_handover_hint")}</small>` : ""}</span>${on ? icon("check", "wb-menu__mark") : ""}</button>`;
  };
  const ownerEditable = editable && ownerOpts.some((o) => o !== (w.owner || ""));
  const ownerPill = ownerEditable
    ? `<button type="button" class="wb-pillbtn" data-menu="owner" aria-haspopup="menu" aria-expanded="false" title="${L("owner_fix")}">${esc(ownerLabel(w))}${icon("chevron-down")}</button>`
    : pill(ownerLabel(w));
  // The customer's language (round 3): a pill after the owner that opens the choices in place
  // (a Sheet on a phone); the same route and audit as before. Compose: choosing re-drafts.
  const LANGS = ["nl", "en", "de", "fr", "es"];
  const langPill = editable ? `<button type="button" class="wb-pillbtn" data-menu="lang" aria-haspopup="menu" aria-expanded="false" aria-label="${L("change_lang")}" title="${L("change_lang")}">${esc((w.language || "?").toUpperCase())}${icon("chevron-down")}</button>` : "";
  const langMenu = editable ? `<template id="m-lang" data-title="${L("lang_fix")}" data-align="start">${LANGS.map((l) => {
    const on = l === (w.language || "");
    return `<button type="button" class="wb-menu__item" role="menuitemradio" aria-checked="${on}"${on ? "" : ` data-submit="ax-f-lang" name="language" value="${l}"`}><span>${l.toUpperCase()} · ${esc(langDisplay(lang, l))}${isCompose && !on ? `<small>${L("relang_note")}</small>` : ""}</span>${on ? icon("check", "wb-menu__mark") : ""}</button>`;
  }).join("")}</template>` : "";
  const pills = [
    statusPill("ax-st"),
    (w.priority || 2) === 1 ? pill("P1", "bad") : "",
    w.injection_flag ? pill(t(lang, "injection_chip"), "bad") : "",
    isCompose ? pill(t(lang, "compose_origin_chip")) : "",
    isContactForm ? pill(t(lang, "contactform_chip")) : "",
    isCompose ? (scen ? pill(lang === "nl" ? scen.label_nl : scen.label_en) : "") : pill(intentLabel(lang, w.intent)),
    suggestCloseChip(lang, w),
    ownerPill,
    langPill,
  ].filter(Boolean).join("");
  const sender = w.sender_name || w.sender_email || "";
  const backLink = `<a class="wb-link ax-back" href="${BASE.path}/" data-back>${icon("back")}${L("inbox")}</a>`;
  const ptop = `<header class="wb-page__hd ax-ptop"><a class="wb-btn wb-btn--ghost wb-btn--icon" href="${BASE.path}/" data-back aria-label="${L("inbox")}" title="${L("inbox")}">${icon("back")}</a><h1 class="wb-page__t">${esc(sender)}</h1>${statusPill()}</header>`;
  const head = `<div class="ax-head"><h1 class="ax-title">${esc(w.subject || t(lang, "no_subject"))}</h1><div class="ax-pills">${pills}</div>${custHtml}</div>`;
  const banner = (tone, html) => `<div class="wb-banner" data-tone="${tone}"${tone === "bad" ? ' role="alert"' : ""}>${icon(tone === "info" ? "info" : "alert")}<div class="wb-banner__body">${html}</div></div>`;
  const flagBanner = w.injection_flag && !closed ? banner("bad", `<b>${L("injection_chip")}.</b> ${L("send_disabled_inj")}`) : "";
  const voiceBanner = isVoicemail && !closed ? banner("info", L("voicemail_phone_only")) : "";

  // --- The email: the customer's message (compose items have none: their information card
  // takes its place). Rendered by renderTimeline (linkified, folds, translation) + attachments.
  const mailCard = isCompose ? "" : `<section class="wb-card ax-mail" aria-label="${L("customer_email")}"><div class="wb-card__bd">
    ${renderTimeline(w, lang, emailTr, emailTrPending, thread, DM.notShownFor(w))}${w.caller_info ? `<p class="ax-caller">${esc(w.caller_info)}</p>` : ""}</div></section>`;

  // --- The information cards of the new-outbound kinds, quiet, above the reply. Compose: the
  // trusted instruction and the resolved customer (compose_customer carries NO address; the
  // recipient lives only in w.recipient, shown on the To line). Contact form and return request:
  // the parsed customer and whether SAP matched; the recipient is on the To line. Nothing here is
  // model-derived.
  let infoCard = "";
  const info = (label, html) => `<section class="wb-card ax-info"><div class="wb-card__bd"><span class="wb-label">${esc(label)}</span>${html}</div></section>`;
  if (isCompose) {
    let cc = null; try { cc = JSON.parse(w.compose_customer || "null"); } catch (e) { cc = null; }
    const who = cc ? (cc.name && cc.contactName && cc.contactName !== cc.name ? `${cc.name} (${cc.contactName})` : (cc.name || cc.contactName || "")) : "";
    const bits = cc ? [who, cc.cardCode || "", cc.country || ""].filter(Boolean).map(esc).join(" · ") : "";
    infoCard = info(t(lang, "compose_customer_label"), `${bits ? `<p>${bits}</p>` : ""}
      ${cc && cc.knownAccount === false ? note("warn", t(lang, "compose_guest")) : ""}${cc && cc.frozen ? note("warn", t(lang, "compose_frozen")) : ""}
      ${cc && Array.isArray(cc.notes) && cc.notes.length ? `<ul class="ax-notes">${cc.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
      <p class="wb-hint">${L("compose_from")}: ${esc(w.mailbox)}@ · ${esc(fmtDateTime(w.created_at, lang))}</p>
      <span class="wb-label">${L("compose_your_instruction")}</span><p class="ax-pre">${esc(w.compose_instruction || "")}</p>
      ${!ACTION_COMPOSE_SEND ? `<p class="wb-hint">${L("compose_draft_only")}</p>` : ""}`);
  } else if (isContactForm || isRN) {
    const src = isContactForm ? cf : rn;
    const p = (src && src.parsed) || {};
    const rv = (src && src.resolved) || {};
    const cands = (src && src.candidateAddresses) || [];
    const who = [isContactForm ? p.name || rv.name || "" : rv.name || p.name || "", rv.matched && rv.cardCode ? rv.cardCode : "",
      isContactForm ? p.countryCode || rv.country || "" : rv.country || ""].filter(Boolean).map(esc).join(" · ");
    infoCard = info(t(lang, "cf_customer_label"), `${who ? `<p>${who}</p>` : ""}
      ${rv.frozen ? note("warn", t(lang, "compose_frozen")) : ""}
      <p class="wb-hint">${rv.matched ? `${L("cf_matched")}${rv.name ? ": " + esc(rv.name) : ""}` : L("cf_not_matched")}</p>
      ${p.orderRef ? `<p class="wb-hint">${L("cf_order")}: ${esc(p.orderRef)}</p>` : ""}${isContactForm && p.phone ? `<p class="wb-hint">${esc(p.phone)}</p>` : ""}
      ${!w.recipient && !cands.length ? note("warn", t(lang, "cf_no_address")) : ""}`);
  }

  // --- The To line. The address is a pill button whose menu lists the known addresses (only
  // resolver-produced ones are pickable, exactly what pickKnown() accepts) and "Other address...",
  // which reveals an email field. Choosing applies at once through POST /item/:id/recipient (mode
  // known or typed). The typed field always starts EMPTY: nothing from the email body, a tool
  // result or any model output is ever placed in front of the salesperson to click. A quiet pill
  // says where the address came from; "changed" and "not on file" warn as the old Send button did.
  // The customer named in the "not on file" warning comes from the trusted SAP summary.
  const sendTo = RSET.activeRecipient(w, kind);
  const ccList = CC.list(w);   // the Cc on the item now (cc-list.js)
  // "Sent to X" or "Sent to X, cc Y, Z": the closed card's line and the Send toast.
  const sentLine = (to, cc) => cc.length ? t(lang, "sent_to_cc", { to, cc: cc.join(", ") }) : `${t(lang, "sent_to")} ${to}`;
  const parseList = (s) => { try { return JSON.parse(s || "[]") || []; } catch (e) { return []; } };
  const redirected = RSET.isRedirected(w, kind);
  const typedTo = RSET.norm(w.recipient_source) === "typed";
  const pickable = knownAddrs.filter((e) => e.source !== "typed");
  const typedEntry = knownAddrs.find((e) => e.source === "typed");
  const recipNeed = !sendTo || fwdNeedsRecipient;
  const curSrc = (knownAddrs.find((e) => e.addr === sendTo) || {}).source || (typedTo ? "typed" : (kind === "reply" && !w.recipient ? "sender" : "onfile"));
  const canPick = editable && !w.injection_flag;
  const toMenu = canPick ? `<template id="m-to" data-title="${L("send_to")}" data-align="start">
    ${typedEntry ? `<button type="button" class="wb-menu__item" role="menuitemradio" aria-checked="true" disabled><span>${esc(typedEntry.addr)}<small>${esc(srcLabel.typed)}</small></span>${icon("check", "wb-menu__mark")}</button>` : ""}
    ${pickable.map((e) => {
      const on = e.addr === sendTo && !recipNeed;
      return `<button type="button" class="wb-menu__item" role="menuitemradio" aria-checked="${on}"${on ? "" : ` data-submit="ax-f-recip" name="addr" value="${esc(e.addr)}"`}><span>${esc(e.addr)}<small>${esc(srcLabel[e.source] || e.source)}</small></span>${on ? icon("check", "wb-menu__mark") : ""}</button>`;
    }).join("")}
    ${pickable.length || typedEntry ? `<div class="wb-menu__sep" role="separator"></div>` : ""}
    <button type="button" class="wb-menu__item" role="menuitem" data-to-other><span>${L("recip_other")}</span></button></template>` : "";
  const toPill = recipNeed
    ? (canPick ? `<button type="button" class="wb-pillbtn" data-tone="warn" data-menu="to" data-to-pill aria-haspopup="menu" aria-expanded="false">${L("recip_confirm_btn")}${icon("chevron-down")}</button>` : pill(t(lang, "recip_confirm_btn"), "warn"))
    : (canPick ? `<button type="button" class="wb-pillbtn" data-menu="to" data-to-pill aria-haspopup="menu" aria-expanded="false" title="${L("recip_change")}"><span>${esc(sendTo)}</span>${icon("chevron-down")}</button>` : `<span class="wb-pill" data-to-pill>${esc(sendTo)}</span>`);
  // The typed-address warning, for a typed To and a typed Cc alike.
  const typedWarn = (addr) => t(lang, "recip_typed_warn", { to: addr, customer: custName || t(lang, "recip_this_customer") });
  // Add Cc (opens the Cc row; not drawn once the row shows) sits with the address, right after its
  // pills (round 3); at the right of the To line, alone, Translate, the same control the customer's
  // message carries (needContent: the customer writes in another language than the reader). Both
  // stay put while the typed-address field is open.
  const trReply = needContent ? `<button type="button" class="wb-btn wb-btn--ghost wb-btn--sm" data-tr-reply aria-expanded="false" aria-controls="replytr" data-on="${L("hide_translation")}" data-off="${L("translate")}">${L("translate")}</button>` : "";
  const ccOpen = canPick ? `<button type="button" class="wb-btn wb-btn--ghost wb-btn--sm" data-cc-open aria-expanded="${ccList.length > 0}" aria-controls="ax-ccrow"${ccList.length ? " hidden" : ""}>${L("cc_add")}</button>` : "";
  const toEnd = trReply ? `<span class="ax-to__end">${trReply}</span>` : "";
  const otherField = (form, attr, label) => `<div class="wb-input wb-input--sm ax-toother" ${attr} hidden><input type="email" name="addr" form="${form}" autocomplete="off" spellcheck="false" required placeholder="${L("recip_email_ph")}" aria-label="${esc(label)}"></div><button type="submit" form="${form}" class="wb-btn wb-btn--sm" ${attr} hidden>${L("recip_use")}</button>`;
  const toLine = `<div class="ax-to"><span class="wb-label">${L("to_label")}</span>${toPill}
    ${!recipNeed ? `<span class="wb-pill" data-tone="neutral" data-to-pill>${esc(srcLabel[curSrc] || curSrc)}</span>` : ""}
    ${!recipNeed && typedTo ? `<span class="wb-pill" data-tone="warn" data-to-pill title="${esc(typedWarn(sendTo))}">${L("recip_typed_pill")}</span>`
      : !recipNeed && redirected ? `<span class="wb-pill" data-tone="warn" data-to-pill title="${L("recip_changed_title")}">${L("recip_changed_pill")}</span>` : ""}${ccOpen}
    ${canPick ? otherField("ax-f-typed", "data-to-other-field", t(lang, "recip_other")) + iconBtn(t(lang, "cancel"), "x", "data-to-cancel data-to-other-field hidden", "wb-btn--sm") : ""}${toEnd}</div>`;

  // --- The Cc row (round 2, request 8), under the To line wherever an address can be picked: the
  // Cc as removable pills (a typed one amber, as a typed To; they stay while the typed field is
  // open, only Add, data-cc-pill, gives way to it), Add with the suggestions (the known
  // set and the addresses the customer copied, cc-list.js) and "Other address...", which reveals a
  // field exactly as the To line's does. Adding and removing post in place to the Cc routes in
  // server.js. Drawn hidden while the Cc is empty, until Add Cc opens it.
  const ccSugg = canPick ? CC.suggestions(w, { known: knownAddrs, card: await customerEmails(w), thread, to: sendTo }) : [];
  const ccGroup = (source, label) => {
    const rows = ccSugg.filter((e) => e.source === source);
    return rows.length ? `<span class="wb-menu__label">${esc(label)}</span>${rows.map((e) => `<button type="button" class="wb-menu__item" role="menuitem" data-submit="ax-f-cc" name="addr" value="${esc(e.addr)}"><span>${esc(e.addr)}</span></button>`).join("")}` : "";
  };
  const ccMenu = canPick && ccList.length < CC.MAX_CC ? `<template id="m-cc" data-title="${L("cc_menu")}" data-align="start">
    ${ccGroup("onfile", srcLabel.onfile)}${ccGroup("copied", t(lang, "cc_src_copied"))}${ccGroup("internal", t(lang, "cc_src_internal"))}
    ${ccSugg.length ? `<div class="wb-menu__sep" role="separator"></div>` : ""}
    <button type="button" class="wb-menu__item" role="menuitem" data-cc-other><span>${L("recip_other")}</span></button></template>` : "";
  const ccPill = (e) => {
    const typed = e.source === "typed";
    return `<span class="wb-pill" data-tone="${typed ? "warn" : "neutral"}"${typed ? ` title="${esc(typedWarn(e.addr))}"` : ""}><span>${esc(e.addr)}</span>${typed ? `<span class="wb-sr">, ${L("recip_typed_pill")}</span>` : ""}<button type="submit" form="ax-f-ccrm" name="addr" value="${esc(e.addr)}" class="wb-clear" aria-label="${esc(t(lang, "cc_remove", { addr: e.addr }))}" title="${L("remove")}">${icon("x")}</button></span>`;
  };
  // At the cap (CC.MAX_CC) Add gives way to a quiet note: the only thing it could still do is refuse.
  const ccFull = ccList.length >= CC.MAX_CC;
  const ccRow = canPick ? `<div class="ax-to ax-cc" id="ax-ccrow"${ccList.length ? "" : " hidden"}><span class="wb-label">${L("cc_label")}</span>${ccList.map(ccPill).join("")}
    ${ccFull ? `<span class="wb-hint">${esc(t(lang, "cc_too_many").replace("{n}", CC.MAX_CC))}</span>`
      : `<button type="button" class="wb-pillbtn" data-menu="cc" data-cc-pill aria-haspopup="menu" aria-expanded="false" aria-label="${L("cc_menu")}">${icon("plus")}<span>${L("cc_more")}</span></button>
    ${otherField("ax-f-cctyped", "data-cc-other-field", t(lang, "cc_menu"))}${iconBtn(t(lang, "cancel"), "x", "data-cc-cancel data-cc-other-field hidden", "wb-btn--sm")}`}</div>` : "";

  // --- The reply card (editable). The withdrawn notice explains an empty box; the subject of a new
  // outbound sits above the text. The text is the rich editor (assets/axle-editor.js, its first view
  // rendered here from the stored text) over the hidden reply field that holds the stored text and
  // posts; the AI seed sits in a hidden, name-less textarea so it never posts. Axle's questions, when
  // it waits for an answer, sit with the redraft line below the card.
  const needsAnswers = editable && w.status === "awaiting_input" && open.length > 0 && !w.injection_flag;
  const qBanner = needsAnswers ? banner("warn", `${L("needs_input")}<details class="wb-details"><summary>${esc(t(lang, questions.length === 1 ? "q_1" : "q_n").replace("{n}", questions.length))}${icon("chevron-right")}</summary><ol class="ax-qs">${questions.map((q) =>
    `<li><span${qTrAttr(q)}>${esc(qText(q))}</span>${q.kind === "physical" ? pill(t(lang, "check_shelf")) : ""}${q.answer ? `<br><b>${L("answer")}:</b> ${esc(q.answer)} <span class="wb-hint">(${esc(q.answered_by)}, ${esc(fmtDateTime(q.answered_at, lang))})</span>` : ""}</li>`).join("")}</ol></details>`) : "";
  const wdBanner = withdrawn ? banner("warn", `<b>${L("withdrawn_title")}</b> ${esc(withdrawn.reasons.map((r) => t(lang, "withdrawn_" + r)).join(" "))} ${L("withdrawn_next")}<details class="wb-details"><summary>${L("withdrawn_show")}${icon("chevron-right")}</summary><pre>${esc(withdrawn.text)}</pre></details>`) : "";
  // A new outbound whose sending is switched off says so in the card (the button stays disabled).
  const offBanner = (isContactForm && !ACTION_CONTACTFORM_SEND || isRN && !ACTION_RETURN_SEND) && w.recipient ? banner("info", L("cf_send_not_enabled")) : "";
  const subjectName = isContactForm ? "cf_subject" : isRN ? "return_subject" : isCompose ? "compose_subject" : "";
  const subjectField = subjectName ? `<div class="wb-field ax-subj"><label class="wb-label" for="ax-subj">${L("cf_subject")}</label><div class="wb-input"><input id="ax-subj" name="${subjectName}" value="${esc(isContactForm ? cfSubjectDefault : isRN ? rnSubjectDefault : (w.subject || ""))}"></div></div>` : "";
  const aiSeed = full || interim;
  const isImg = (a) => /^image\//i.test(a.content_type || "");
  const attChip = (a, live) => `<span class="wb-pill ax-chip" data-tone="neutral">${icon("clip")}<span>${esc(a.name)} (${esc(fmtSize(a.size))})</span>${live && isImg(a) ? `<button type="button" class="ax-chipact" data-insimg="${a.id}">${L("img_inline_btn")}</button>` : ""}${live ? `<button class="wb-clear" name="remove_att" value="${a.id}" formnovalidate data-inline aria-label="${L("remove")} ${esc(a.name)}" title="${L("remove")}">${icon("x")}</button>` : ""}</span>`;
  // The quiet autosave mark: Saved once the server holds the text, Not saved when a save failed
  // (the text stays in the field, and on a phone in local storage). Both share one slot, so neither
  // moves anything when it appears. In the dock from 640 up, at the end of the reply's tool row on
  // a phone.
  const saveMark = `<span class="ax-savemark"><span class="ax-saved" data-ax-saved>${icon("check")}${L("saved")}</span><span class="ax-saved ax-savefail" data-ax-savefail hidden title="${L("save_failed_tip")}">${icon("alert")}${L("save_failed")}</span></span>`;
  const teachFlags = db.prepare("SELECT * FROM teach_flags WHERE work_item_id = ? ORDER BY id").all(w.id);
  const teachBtn = `<button type="button" class="wb-btn wb-btn--ghost wb-btn--sm" data-overlay="ax-teach">${icon("note")}<span>${L("teach_title")}</span>${teachFlags.length ? `<span class="wb-count">${teachFlags.length}</span>` : ""}</button>`;
  const docsRow = editable && !isContactForm && !isRN ? `<div class="ax-sugg">${sugg.chips ? `<span class="wb-label">${L("sugg_label")}</span>${sugg.chips}` : ""}<button type="button" class="wb-btn wb-btn--ghost wb-btn--sm" data-overlay="ax-doc">${L("other_doc")}</button></div>` : "";
  const fmtBtn = (f) => `<button type="button" class="wb-btn wb-btn--ghost wb-btn--icon wb-btn--sm" data-fmt="${f}" aria-pressed="false" aria-label="${L("fmt_" + f)}" title="${L("fmt_" + f)}">${icon(f)}</button>`;
  const replyCard = editable ? `<section class="wb-card ax-reply" aria-label="${L("reply")}" data-max="${MAX_ATTACH_BYTES}">${toLine}${ccRow}${offBanner}${wdBanner}${subjectField}
    <div class="ax-text"><div class="ax-edbar" role="toolbar" aria-label="${L("fmt_toolbar")}" aria-controls="replyed">${["bold", "italic", "underline", "list"].map(fmtBtn).join("")}</div>
      <div class="ax-ed" id="replyed" contenteditable="true" role="textbox" aria-multiline="true" aria-label="${L("reply")}" data-placeholder="${L("reply_ph")}" spellcheck="true">${ED.toHtml(ED.parse(replyText))}</div>
      <textarea id="replybox" name="reply" hidden>${esc(replyText)}</textarea></div>
    ${aiSeed ? `<textarea id="ai_seed" hidden readonly>${esc(aiSeed.body)}</textarea>` : ""}
    ${needContent ? `<div class="ax-tr" id="replytr" hidden><p class="wb-hint">${esc(t(lang, "reply_tr_note").replace("{lang}", langDisplay(lang, custLang)))}</p><div class="ax-msg">${TR_SKEL(lang)}</div></div>` : ""}
    <div class="ax-atts"${atts.length ? "" : " hidden"}>${atts.map((a) => attChip(a, true)).join("")}</div>
    <div class="ax-tools"><button type="button" class="wb-btn wb-btn--ghost wb-btn--sm" data-attach>${icon("clip")}<span>${L("attach")}</span></button><input type="file" id="att_file" multiple hidden>
      <button type="button" class="wb-btn wb-btn--ghost wb-btn--sm ax-cam" data-camera>${icon("camera")}<span>${L("camera")}</span></button><input type="file" id="att_cam" accept="image/*" capture="environment" hidden>
      ${teachBtn}
      ${aiSeed ? `<button type="button" class="wb-btn wb-btn--ghost wb-btn--sm" data-reset data-confirm="${L("reset_ai_confirm")}" data-confirm-ok="${L("reset_ai")}" hidden>${icon("refresh")}<span>${L("reset_ai")}</span></button>` : ""}${saveMark}</div>
    ${docsRow}</section>` : "";

  // Drafting: the To line greyed, an info banner and a skeleton in the shape of the reply.
  const SK = ["24%", "92%", "86%", "64%", "", "40%", "90%", "78%", "56%"].map((x) => x ? `<span class="wb-skel" style="width:${x}"></span>` : '<span style="height:6px"></span>').join("");
  const draftingCard = busy ? `<section class="wb-card ax-reply" aria-label="${L("reply")}"><div class="ax-to"><span class="wb-label">${L("to_label")}</span><button type="button" class="wb-pillbtn" disabled>${esc(sendTo || t(lang, "recip_confirm_btn"))}${icon("chevron-down")}</button></div>
    <div class="ax-wait">${banner("info", L("investigating_banner"))}<div class="wb-skel-rows" role="status" aria-label="${L("investigating_banner")}">${SK}</div></div></section>` : "";

  // Closed: the reply as sent, read-only, with one line naming who it went to and when (office time).
  const shownText = (sentRow && sentRow.body) || replyText;
  const closedCard = closed && (shownText || atts.length) ? `<section class="wb-card ax-reply" aria-label="${L("reply")}">
    ${sentRow ? `<p class="ax-sentline">${icon("check")}${esc(sentLine(sentRow.to_addr, parseList(sentRow.cc_json)))} · ${esc(fmtDateTime(sentRow.sent_at, lang))}</p>` : ""}
    ${shownText ? `<div class="ax-msg">${replyParas(shownText)}</div>` : ""}
    ${atts.length ? `<div class="ax-atts">${atts.map((a) => attChip(a, false)).join("")}</div>` : ""}
    <div class="ax-tools">${teachBtn}</div></section>` : "";

  // The redraft line: one field (the existing feedback field, so /work and /send keep it) and
  // Redraft, which posts /work action=redraft in place; the drafting state then shows.
  const redraft = editable ? `<div class="ax-redraft"><div class="wb-input wb-input--area ax-fb"><textarea name="feedback" rows="1" placeholder="${L(needsAnswers ? "answer_ph" : "feedback_ph")}" aria-label="${L("feedback_ph")}">${esc(w.feedback || "")}</textarea></div><button type="submit" class="wb-btn" name="action" value="redraft" data-inline title="${L("redraft_hint")}">${L("redraft")}</button></div>`
    : busy ? `<div class="ax-redraft"><div class="wb-input"><input disabled value="${esc(w.feedback || "")}" placeholder="${L("feedback_ph")}" aria-label="${L("feedback_ph")}"></div><button type="button" class="wb-btn" disabled>${L("redraft")}</button></div>` : "";
  // The previous round's draft, folded and read-only (plain text, never a field, so it cannot post).
  const prevDraft = supersededRow ? `<details class="wb-disclosure ax-prev"><summary>${L("prev_draft_summary")}${icon("chevron-right")}</summary><div><p class="wb-hint">${L("prev_draft_hint")}</p><div class="ax-msg">${replyParas(supersededRow.body)}</div></div></details>` : "";

  // Axle's questions directly above the redraft line, one unit with it (the answer goes in that field).
  const ask = qBanner ? `<div class="ax-ask">${qBanner}${redraft}</div>` : redraft;
  const replyCol = isVoicemail && !closed ? "" : `<div class="ax-replycol">${isCompose ? "" : infoCard}${replyCard}${draftingCard}${closedCard}${ask}${prevDraft}</div>`;
  const pair = `<div class="ax-pair">${isCompose ? infoCard : mailCard}${replyCol}</div>`;

  // --- The dock (from 640 up) and the phone bar. Send posts the work form to /send in place and
  // locks while it runs; the next email opens on success. Mark done, Reopen and a voicemail's
  // Resolved by phone post /status; Create order opens Ratchet's builder in a new tab (inbound items
  // only); More holds the rarer actions. Every rule for a disabled Send is the old one (canSend).
  // inBar: the phone bar's short label (two actions and More must fit at 360 in Dutch too).
  const markDone = (inBar) => `<button type="submit" form="ax-f-status" name="to" value="done" class="wb-btn" data-next data-toast="${L("marked_done")}" title="${L("done_tip")}"${busy ? " disabled" : ""}>${icon("check")}<span>${L(inBar ? "mark_done_bar" : "mark_done")}</span></button>`;
  const phoneBtn = (inBar) => `<button type="submit" form="ax-f-status" name="to" value="phone" class="wb-btn wb-btn--primary" data-next data-toast="${L("mark_phone")}" title="${L("phone_tip")}"><span>${L(inBar ? "mark_phone_bar" : "mark_phone")}</span></button>`;
  const sendBtn = (inBar) => `<button type="submit" class="wb-btn wb-btn--commit"${inBar ? ' form="workform"' : ""} formaction="${U("/send")}" formnovalidate data-send data-inline data-next data-toast="${esc(sentLine(sendTo, ccList.map((e) => e.addr)))}"${canSend ? "" : " disabled"}>${icon("send")}<span>${L("send")}</span></button>`;
  const ratchet = isCompose ? "" : busy ? `<button type="button" class="wb-btn" disabled>${icon("plus")}<span>${L("new_order_ratchet")}</span></button>`
    : `<a class="wb-btn" href="/#/ratchet/new?axle=${w.id}" target="_blank" rel="noopener" title="${L("new_order_ratchet_tip")}" data-fold="2">${icon("plus")}<span>${L("new_order_ratchet")}</span></a>`;
  const moreBtn = (icn) => !(icn ? pmoreRows : checkedRow || foldRows) ? "" : icn ? `<button type="button" class="wb-btn wb-btn--icon" data-menu="pmore" aria-haspopup="menu" aria-expanded="false" aria-label="${L("more")}" title="${L("more")}"${busy ? " disabled" : ""}>${icon("dots")}</button>`
    : `<button type="button" class="wb-btn wb-btn--ghost" data-menu="more" aria-haspopup="menu" aria-expanded="false"${busy ? " disabled" : ""}${checkedRow ? "" : " hidden"}>${icon("dots")}<span>${L("more")}</span></button>`;
  const reopen = `<button type="submit" form="ax-f-status" name="to" value="reopen" class="wb-btn">${icon("refresh")}<span>${L("reopen")}</span></button>`;
  // Block sender (round 3): a dock button on desk and tablet, a row in the phone's More sheet.
  const canBlock = editable && !isCompose;
  const blockAct = `data-remote="${U("/block")}" data-remote-title="${L("block_title")}"`;
  const blockBtn = canBlock ? `<button type="button" class="wb-btn wb-btn--ghost wb-btn--danger" ${blockAct} data-fold="1"><span>${L("block_sender")}</span></button>` : "";
  const blockRow = canBlock ? `<button type="button" class="wb-menu__item wb-menu__item--danger" role="menuitem" ${blockAct}><span>${L("block_sender")}</span></button>` : "";
  const checkedRow = admin ? `<button type="button" class="wb-menu__item" role="menuitem" data-overlay="ax-brief"><span>${L("what_checked")}</span></button>` : "";
  const ratchetRow = isCompose ? "" : `<a class="wb-menu__item" role="menuitem" href="/#/ratchet/new?axle=${w.id}" target="_blank" rel="noopener"><span>${L("new_order_ratchet")}</span></a>`;
  // More holds what is left: on desk and tablet What Axle checked (admin), plus the dock slots that
  // fold into it when the dock is too narrow (data-fold: Block sender first, then Create order;
  // axle.js dockFold shows their rows and More); on the phone also Create order and Block sender.
  const sepRow = (attr) => `<div class="wb-menu__sep" role="separator"${attr || ""}></div>`;
  const pmoreRows = `${ratchetRow}${blockRow}${checkedRow && (ratchetRow || blockRow) ? sepRow() : ""}${checkedRow}`;
  const foldRows = busy ? "" : ratchetRow.replace("<a ", '<a data-fold-row="2" hidden ') + blockRow.replace("<button ", '<button data-fold-row="1" hidden ');
  let dock, bar;
  if (closed) {
    dock = `<div class="wb-dock"><div class="wb-dock__group">${reopen}</div></div>`;
    bar = `<div class="wb-bar">${reopen}</div>`;
  } else if (isVoicemail) {
    dock = `<div class="wb-dock"><div class="wb-dock__group">${phoneBtn()}${markDone()}</div><div class="wb-dock__group wb-dock__group--end">${ratchet}${blockBtn}${moreBtn()}</div></div>`;
    bar = `<div class="wb-bar ax-bar">${markDone(true)}${phoneBtn(true)}${moreBtn(true)}</div>`;
  } else {
    dock = `<div class="wb-dock"><div class="wb-dock__group">${sendBtn(false)}${markDone()}</div><div class="wb-dock__group wb-dock__group--end">${editable ? saveMark : ""}${ratchet}${blockBtn}${moreBtn()}</div></div>`;
    bar = `<div class="wb-bar ax-bar">${markDone(true)}${sendBtn(true)}${moreBtn(true)}</div>`;
  }

  // --- Menus, overlays and the small forms the buttons post through (outside the work form:
  // forms never nest). Each posts in place (data-inline) with exactly the old fields.
  const templates = [
    !closed && !busy ? `<template id="m-more" data-title="${L("more")}" data-align="end">${foldRows}${foldRows && checkedRow ? sepRow(" data-fold-sep hidden") : ""}${checkedRow}</template><template id="m-pmore" data-title="${L("more")}" data-align="end">${pmoreRows}</template>` : "",
    langMenu,
    ownerEditable ? `<template id="m-owner" data-title="${L("owner_fix")}" data-align="start">${ownerOpts.map(ownerRow).join("")}</template>` : "",
    toMenu,
    ccMenu,
    admin && !busy ? overlay("ax-brief", t(lang, "what_checked"), lang, `<pre class="ax-brief">${esc(w.brief_md || t(lang, "none_paren"))}</pre>`, "", { kind: "drawer" }) : "",
    editable && !isContactForm && !isRN ? overlay("ax-doc", t(lang, "other_doc_title"), lang,
      `<form class="ax-ov__bd" id="ax-docform" method="post" action="${U("/attach-doc")}" data-inline novalidate><div data-ax-banner></div>
        <div class="ax-row2"><div class="wb-field"><label class="wb-label" for="ax-doctype">${L("attach_doc_type")}</label><div class="wb-input wb-input--select"><select id="ax-doctype" name="doctype">${["order", "invoice", "quotation", "delivery", "creditnote"].map((d) => `<option value="${d}">${L("doc_" + d)}</option>`).join("")}</select>${icon("chevron-down")}</div></div>
        <div class="wb-field"><label class="wb-label" for="ax-docnum">${L("attach_doc_number")}</label><div class="wb-input"><input id="ax-docnum" name="docnum" inputmode="numeric" autocomplete="off" data-autofocus></div></div></div>
        <div data-ax-choices></div></form>`,
      `<button type="button" class="wb-btn ax-ov-desk" data-close>${L("cancel")}</button><button type="submit" form="ax-docform" class="wb-btn wb-btn--primary">${icon("clip")}<span>${L("attach")}</span></button>`,
      { form: true, bodyTag: true }) : "",
    sugg ? sugg.dialogs : "",
    !busy ? overlay("ax-teach", t(lang, "teach_title"), lang,
      `${teachFlags.length ? `<ul class="ax-flags">${teachFlags.map((f) => `<li>${pill(t(lang, "teach_" + f.status), f.status === "approved" ? "ok" : "neutral")}<span>${esc(f.text)}</span><span class="wb-hint">${esc(f.flagged_by)}, ${esc(fmtDateTime(f.created_at, lang))}</span>${f.status === "pending" && (f.flagged_by === req.user.tailscale_login || admin)
        ? `<button type="submit" form="ax-f-tw-${f.id}" class="wb-btn wb-btn--ghost wb-btn--sm" data-toast="${L("teach_withdrawn")}">${L("teach_withdraw")}</button>` : ""}</li>`).join("")}</ul>` : ""}
      <form id="ax-teachform" method="post" action="${U("/teach")}" data-inline data-toast="${L("teach_done")}"><div class="wb-field"><label class="wb-label" for="ax-teach-t">${L("teach_ph")}</label><div class="wb-input wb-input--area"><textarea id="ax-teach-t" name="text" maxlength="${K.MAX_TEXT}" required data-autofocus></textarea></div></div></form>`,
      `<button type="button" class="wb-btn ax-ov-desk" data-close>${L("cancel")}</button><button type="submit" form="ax-teachform" class="wb-btn wb-btn--primary">${L("teach_btn")}</button>`,
      { form: true }) : "",
  ].join("");
  const hiddenForms = `<div hidden>
    <form id="ax-f-status" method="post" action="${U("/status")}" data-inline></form>
    ${ownerEditable ? `<form id="ax-f-owner" method="post" action="${U("/owner")}" data-inline></form>` : ""}
    ${canPick ? `<form id="ax-f-recip" method="post" action="${U("/recipient")}" data-inline><input type="hidden" name="mode" value="known"><input type="hidden" name="use" value="1"></form>
    <form id="ax-f-typed" method="post" action="${U("/recipient")}" data-inline novalidate><input type="hidden" name="mode" value="typed"><input type="hidden" name="use" value="1"></form>
    <form id="ax-f-cc" method="post" action="${U("/cc")}" data-inline></form><form id="ax-f-cctyped" method="post" action="${U("/cc")}" data-inline novalidate></form>
    <form id="ax-f-ccrm" method="post" action="${U("/cc/remove")}" data-inline></form>` : ""}
    ${editable ? `<form id="ax-f-lang" method="post" action="${U("/language")}" data-inline></form>` : ""}
    ${sugg ? sugg.forms : ""}
    ${teachFlags.filter((f) => f.status === "pending").map((f) => `<form id="ax-f-tw-${f.id}" method="post" action="${U(`/teach/${f.id}/withdraw`)}" data-inline></form>`).join("")}
  </div>`;

  // The column: the work form when the reply can be edited (autosaved through POST /work, the
  // existing save route), else a plain column. The banner slot rides above the dock, so a refusal
  // shows where Send was pressed.
  const colInner = `${backLink}${head}${flagBanner}${voiceBanner}${pair}<div class="ax-dockwrap"><div data-ax-banner></div>${dock}</div>`;
  const col = editable
    ? `<form class="ax-col ax-col--split" id="workform" method="post" action="${U("/work")}" data-autosave novalidate>${colInner}</form>`
    : `<div class="ax-col ax-col--split">${colInner}</div>`;
  const email = `<div class="ax-email" data-email="${w.id}">${ptop}${col}${bar}${templates}${hiddenForms}</div>`;

  // While the item is busy, a small self-poller re-swaps the work area every 10 s: a busy item
  // renders no edit surface, so the swap can never lose typed work. It targets #workpane only, so
  // after an in-place open has pushed a different URL it never yanks the reader away.
  const busyPoll = busy ? `<div hx-get="${U()}" hx-target="#workpane" hx-swap="innerHTML" hx-trigger="load delay:10s"></div>` : "";
  if (req.get("HX-Request")) {
    // An in-place open (a list row, an inline post's redirect, the poll): the work area only;
    // htmx takes the document title from the top-level <title>.
    return res.send(`<title>${esc(`Item ${w.id} - Axle`)}</title>${email}${busyPoll}`);
  }
  // Plain navigation (deep link / old link): the full shell. The queue pane is
  // lazy-loaded from /queue, so this route keeps exactly its old side effects.
  res.send(page(`Item ${w.id}`, req.user, shell(lazyQueue(lang, "sel=" + w.id), email + busyPoll) + (req.app.locals.composeUi ? req.app.locals.composeUi(req) : ""), 0, { shell: true, bodyClass: "ax-detail" }));
});


// One stored attachment of this item (message-store.js), by its row id: from disk, fetched from
// Graph first when the file is missing. Untrusted content rules: png, jpeg, gif, webp and PDF
// inline as exactly that type, everything else (HTML and SVG included) a download; nosniff always.
// The bytes behind a row id never change, so the browser may keep them.
app.get("/item/:id/file/:attId", async (req, res) => {
  const w = db.prepare("SELECT id, mailbox FROM work_items WHERE id = ?").get(req.params.id);
  let f = null, err = null;
  try { f = w && await MS.loadAttachment(w.id, parseInt(req.params.attId, 10)); }
  catch (e) { err = e; }
  if (!f && !err) return res.status(404).send(bannerPage(t(req.user.lang, "att_title"), req.user, t(req.user.lang, "att_missing"), { back: w ? backTo(req, w) : undefined }));
  if (err) {
    audit(req.user.tailscale_login, "attachment_error", w.id, String(err.message).slice(0, 200));
    return res.status(502).send(deskPage(t(req.user.lang, "att_title"), req.user,
      bannerHtml("bad", `${esc(t(req.user.lang, "att_fetch_failed"))}<span class="ax-link">${esc(err.message)}</span>`), { back: backTo(req, w) }));
  }
  audit(req.user.tailscale_login, "open_attachment", w.id, `${f.att.name} (${fmtSize(f.att.size)})`);
  const headers = {
    "Content-Type": f.plan.contentType, "Content-Disposition": f.plan.disposition,
    "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=31536000, immutable",
  };
  if (f.buffer) return res.set(headers).send(f.buffer);
  res.sendFile(f.path, { headers, cacheControl: false, lastModified: false, dotfiles: "allow" });
});

// The old index-based link (open tabs from before round 2): the same attachment's stored row when
// there is one, else a live fetch from Graph as before.
app.get("/item/:id/attachment/:idx", async (req, res) => {
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(notFoundPage(req.user));
  let atts = [];
  try { atts = JSON.parse(w.attachments_json || "[]"); } catch (e) { /* ignore */ }
  const a = atts[parseInt(req.params.idx, 10)];
  if (!a) return res.status(404).send(bannerPage(t(req.user.lang, "att_title"), req.user, t(req.user.lang, "att_missing"), { back: backTo(req, w) }));
  const row = db.prepare("SELECT id FROM message_attachments WHERE work_item_id = ? AND graph_att_id = ?").get(w.id, a.id);
  if (row) return res.redirect(BASE.url(`/item/${w.id}/file/${row.id}`));
  try {
    const file = await C.getAttachment(MAILBOX_OF[w.mailbox], w.latest_message_id, a.id);
    audit(req.user.tailscale_login, "open_attachment", w.id, `${a.name} (${fmtSize(file.size)})`);
    const plan = MS.servePlan(file.contentType, file.name || a.name);
    res.set({ "Content-Type": plan.contentType, "Content-Disposition": plan.disposition, "X-Content-Type-Options": "nosniff" });
    res.send(Buffer.from(file.contentBytes, "base64"));
  } catch (e) {
    audit(req.user.tailscale_login, "attachment_error", w.id, e.message.slice(0, 200));
    res.status(502).send(deskPage(t(req.user.lang, "att_title"), req.user,
      bannerHtml("bad", `${esc(t(req.user.lang, "att_fetch_failed"))}<span class="ax-link">${esc(e.message)}</span>`), { back: backTo(req, w) }));
  }
});

// Save reply/feedback/answers; add/remove an attachment; optionally kick off a redraft.
app.post("/item/:id/work", (req, res) => {
  const lang = req.user.lang;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(notFoundPage(req.user));

  saveWorkInputs(w, req.body, req.user.tailscale_login);

  if (req.body.remove_att) {
    const attId = parseInt(req.body.remove_att, 10) || 0;
    const info = db.prepare("DELETE FROM draft_attachments WHERE id = ? AND work_item_id = ?").run(attId, w.id);
    if (info.changes) {
      // Strip any [image:id] inline tokens for the removed attachment from the saved reply,
      // so the normal flow can't leave a dangling token (send-guard would refuse it).
      db.prepare("UPDATE work_items SET draft_edit = REPLACE(draft_edit, ?, '') WHERE id = ? AND draft_edit IS NOT NULL")
        .run(`[image:${attId}]`, w.id);
      audit(req.user.tailscale_login, "attachment_removed", w.id, `att ${attId}`);
    }
  }

  if (req.body.action === "redraft" && w.status !== "investigating") {
    db.prepare("UPDATE work_items SET status = 'investigating', updated_at = datetime('now') WHERE id = ?").run(w.id);
    audit(req.user.tailscale_login, "redraft_started", w.id, null);
    setImmediate(() => runRedraft(w.id, req.user.tailscale_login));
  }
  res.redirect(BASE.url("/item/" + w.id));
});

// Teach Axle (Phase 6): queue "Axle should know this" for Brad. The flag carries the item and the
// reply box as it stands (the salesperson's edit if any, else the newest AI draft) so the review
// has context. Text is sanitised and capped on the way in; it reaches the prompt only after Brad
// approves it on /teach. No draft change, no redraft.
app.post("/item/:id/teach", (req, res) => {
  const w = db.prepare("SELECT id, draft_edit FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(notFoundPage(req.user));
  // Newest AI draft of any kind: on a held item the box shows the interim, not the full draft.
  const ai = db.prepare("SELECT body FROM drafts WHERE work_item_id = ? AND source = 'ai' ORDER BY version DESC, id DESC LIMIT 1").get(w.id);
  const id = K.flag(db, { workItemId: w.id, by: req.user.tailscale_login, text: req.body.text,
    snapshot: w.draft_edit != null ? w.draft_edit : (ai ? ai.body : "") });
  if (id) audit(req.user.tailscale_login, "teach_flag", w.id, `#${id} ${K.cleanText(req.body.text).slice(0, 100)}`);
  res.redirect(BASE.url("/item/" + w.id));
});

// Withdraw a pending flag: its author or an admin. Approved and rejected rows are Brad's, untouched.
app.post("/item/:id/teach/:fid/withdraw", (req, res) => {
  const f = db.prepare("SELECT text FROM teach_flags WHERE id = ? AND work_item_id = ?").get(req.params.fid, req.params.id);
  if (f && K.withdraw(db, req.params.fid, req.user.tailscale_login, req.user.role === "admin")) {
    audit(req.user.tailscale_login, "teach_withdraw", parseInt(req.params.id, 10), `#${req.params.fid} ${f.text.slice(0, 100)}`);
  }
  res.redirect(BASE.url("/item/" + req.params.id));
});

// Change an item's language.
//  - Compose item: this is the OUTBOUND draft language the salesperson chose, so re-draft in it
//    (reuses the redraft loop, which already honours w.language).
//  - Inbound item: this CORRECTS the detected customer language when Axle got it wrong (e.g. an
//    image-only reply mis-tagged EN). It only re-tags the item, fixing the translation panel and
//    the language chip, and does NOT re-draft, since the reply already follows the customer's own
//    email. A fresh draft remains one click away via "Save & redraft".
app.post("/item/:id/language", (req, res) => {
  const lang = req.user.lang;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(notFoundPage(req.user));
  const newLang = ["en", "nl", "de", "fr", "es"].includes(req.body.language) ? req.body.language : null;
  if (!newLang || newLang === w.language) return res.redirect(BASE.url("/item/" + w.id));

  if (w.origin === "compose") {
    if (w.status !== "investigating") {
      db.prepare("UPDATE work_items SET language = ?, status = 'investigating', updated_at = datetime('now') WHERE id = ?").run(newLang, w.id);
      audit(req.user.tailscale_login, "compose_language_change", w.id, `${w.language || "?"} -> ${newLang}`);
      setImmediate(() => runRedraft(w.id, req.user.tailscale_login));
    }
  } else if (!["done", "archived"].includes(w.status)) {
    db.prepare("UPDATE work_items SET language = ?, updated_at = datetime('now') WHERE id = ?").run(newLang, w.id);
    audit(req.user.tailscale_login, "language_corrected", w.id, `${w.language || "?"} -> ${newLang}`);
  }
  res.redirect(BASE.url("/item/" + w.id));
});

// Reassign an item's owner. The new owner must be one of the mailbox's own labels (see
// ownerChoices) - never free text - so the inbox "mine" queues stay consistent. Closed items are
// immutable (reopen first), matching the other metadata edits.
//
// TWO OUTCOMES, decided in code by forward-guard.forwardTargetFor:
//
//  * SAME MAILBOX (Sales(Gouda) -> Tom) - a pure relabel, exactly as before. Nothing is sent.
//
//  * DIFFERENT MAILBOX (info@ item -> Brad, drachten@ item -> Sales(Gouda)) - a HANDOVER. The
//    email is forwarded to that owner's mailbox, then the Axle item is closed as 'forwarded' and
//    the source message marked read, so the work leaves the handing-over team's queue AND their
//    Outlook unread list rather than sitting somewhere nobody is watching. Where an owner works
//    comes from the fixed rules.OWNER_HOME table, so the destination is always one of our own
//    three mailboxes and can never be influenced by an email, a tool result or the model.
//
// ORDER MATTERS: forward first, write second. A Graph failure throws to the global error handler
// with the item untouched, so a handover is never recorded as done when the mail did not move.
// The DB write is guarded on the item still being open, so a human pressing Done in the same
// instant cannot be overwritten.
//
// Governed by allow-list action #6 (env AXLE_ACTION_OWNER_FORWARD). While it is off, a
// cross-mailbox reassign degrades to the old relabel and says so in the audit log.
app.post("/item/:id/owner", async (req, res) => {
  const login = req.user.tailscale_login;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(notFoundPage(req.user));
  const to = String(req.body.owner || "");
  const allowed = ownerChoices(w.mailbox).includes(to) && to !== (w.owner || "") && !["done", "archived"].includes(w.status);
  if (!allowed) return res.redirect(BASE.url("/item/" + w.id));

  const relabel = () => {
    db.prepare("UPDATE work_items SET owner = ?, updated_at = datetime('now') WHERE id = ?").run(to, w.id);
    audit(login, "owner_changed", w.id, `${ownerLabel(w)} -> ${to}`);
  };

  const target = FG.forwardTargetFor(w.mailbox, to);
  if (!target) { relabel(); return res.redirect(BASE.url("/item/" + w.id)); }

  if (!ACTION_OWNER_FORWARD) {
    relabel();
    audit(login, "owner_forward_skipped", w.id, `${to} <${target.address}> - AXLE_ACTION_OWNER_FORWARD not enabled`);
    return res.redirect(BASE.url("/item/" + w.id));
  }

  const fwd = FG.assembleForward(w, { toOwner: to, byName: req.user.display_name, byLogin: login });
  await FWD.forwardMessage({
    mailbox: MAILBOX_OF[w.mailbox], messageId: fwd.messageId, to: fwd.to, comment: fwd.comment,
  });
  const info = db.prepare(
    `UPDATE work_items SET owner = ?, status = 'done', resolution = 'forwarded', updated_at = datetime('now')
     WHERE id = ? AND status NOT IN ('done', 'archived')`
  ).run(to, w.id);
  audit(login, "owner_changed", w.id, `${ownerLabel(w)} -> ${to}`);
  audit(login, "email_forwarded", w.id,
    `${to} <${fwd.to}> from ${w.mailbox} msg=${String(fwd.messageId).slice(0, 24)}${info.changes ? "" : " (item already closed by someone else)"}`);
  await markReadSafe(login, w);
  // F6 (mobile fix 1): the phone adds ret=list at submit time and lands on the Open list
  res.redirect(req.body.ret === "list" ? BASE.url("/") : BASE.url("/item/" + w.id));
});

// On-demand: translate the salesperson's CURRENT (possibly edited) reply into their own
// language so they can read what they're about to send. Returns JSON; cached like all
// translations. The text is treated strictly as data by the translator.
// The e-mail as Ratchet's intake text: a From/Subject header (so the parser's customer match can use
// the sender address and domain) over the full plain-text body from Graph, falling back to the stored
// (4000-char) email_text. Read-only; capped at Ratchet's 8000-char parse limit.
app.get("/item/:id/ratchet-intake.json", async (req, res) => {
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).json({ error: "not_found" });
  if (w.origin === "compose") return res.status(400).json({ error: "no_inbound_email" });
  let body = w.email_text || "";
  if (w.latest_message_id && MAILBOX_OF[w.mailbox]) {
    const b = await C.fetchMessageBody(MAILBOX_OF[w.mailbox], w.latest_message_id);
    if (b && b.content) body = b.contentType === "html" ? C.htmlToText(b.content) : b.content;
  }
  const from = [w.sender_name, w.sender_email ? `<${w.sender_email}>` : ""].filter(Boolean).join(" ");
  const head = `From: ${from}\nSubject: ${w.subject || ""}\nReceived: ${w.email_received || ""}\n\n`;
  const text = (head + body.trim()).slice(0, 8000);
  audit(req.user.tailscale_login, "ratchet_intake", w.id, `${text.length} chars`);
  res.json({ text });
});

app.post("/item/:id/translate-reply", async (req, res) => {
  const text = String(req.body.text || "");
  if (!text.trim()) return res.json({ text: "" });
  try { res.json({ text: await TR.translate(anthropic, req.user.lang, FMT.toPlain(text)) }); }   // the words, not the markers
  catch (e) { res.status(502).json({ error: e.message.slice(0, 200) }); }
});

// Background translations for the item view (UX round, 2026-06-11). The page renders
// instantly with pending placeholders; this endpoint translates the newest inbound
// message and any untranslated questions into the VIEWER's language and the browser
// fills them in. SECURITY: only DB-stored text is translated (loaded by item id) -
// nothing client-supplied ever reaches the translator; the translator treats it
// strictly as data. Cached, so this runs once per (text, language).
app.post("/item/:id/translations", async (req, res) => {
  const lang = req.user.lang;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).json({ error: t(lang, "not_found") });
  const out = { email: null, questions: {} };
  const jobs = [];
  const custLang = (w.language || "").toLowerCase();
  if (custLang && custLang !== lang && w.origin !== "compose") {
    const top = splitQuoted(String(w.email_text || "")).top;
    if (top.trim()) jobs.push(TR.translate(anthropic, lang, top).then((x) => { out.email = x || null; }).catch(() => { /* degrade: no translation */ }));
  }
  if (lang !== "en") {
    for (const q of db.prepare("SELECT id, question FROM questions WHERE work_item_id = ?").all(w.id)) {
      jobs.push(TR.translate(anthropic, lang, q.question).then((x) => { if (x) out.questions[q.id] = x; }).catch(() => { /* keep English */ }));
    }
  }
  await Promise.all(jobs);
  res.json(out);
});

// AJAX attachment add (used by both the file picker and drag-and-drop, one call per file).
// Persists the in-progress reply/answers first so a reload won't lose them.
app.post("/item/:id/attach-add", (req, res) => {
  const lang = req.user.lang;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).json({ error: t(lang, "not_found") });
  saveWorkInputs(w, req.body, req.user.tailscale_login);
  const r = addAttachment(w, req.body, req.user.tailscale_login, lang);
  if (r.error) return res.status(413).json({ error: r.error });
  res.json({ ok: true, id: r.id });   // id lets the browser place an [image:id] inline token
});

// Attach the Boyum print PDF of a referenced SAP document to a COMPOSE email (DRAFT-ONLY).
// The DocEntry is resolved deterministically from the number the salesperson typed - never the
// model, never email content. The PDF is rendered READ-ONLY via Crystal and staged in
// draft_attachments behind the same approval gate as any hand-attached file: it never sends and
// never writes to SAP. A document whose customer differs from the email's is held for an explicit
// confirm, so another customer's document can't be attached by mistake.
// The customer card(s) a document may belong to without a confirm (the scope guard), resolved on
// the trusted side only: the compose customer, else EVERY active card carrying the inbound
// sender's address. Empty = unknown customer, which forces the explicit show-and-confirm.
async function itemScope(w) {
  let cc = null; try { cc = JSON.parse(w.compose_customer || "null"); } catch (e) { cc = null; }
  if (cc && cc.cardCode) return { cards: [cc.cardCode], name: cc.name || "" };
  if (w.origin === "compose" || !w.sender_email) return { cards: [], name: "" };
  const rows = await SAPDOC.customersByEmail(w.sender_email);
  return { cards: rows.map((r) => r.cardCode), name: rows.length ? rows[0].cardName || "" : "" };
}

// Render one resolved document and stage it on the draft, like a hand-attached file.
// Returns null on success or the i18n key of the failure.
async function stageDocPdf(w, doc, login, lang, inScope) {
  let r;
  try { r = await SAPDOC.renderPdf(doc.objectId, doc.docEntry); }
  catch (e) { audit(login, "attach_doc_error", w.id, e.message.slice(0, 180)); return { error: t(lang, "attach_doc_render_failed"), code: 502 }; }
  if (!r.ok) { audit(login, "attach_doc_render_failed", w.id, String(r.error).slice(0, 180)); return { error: t(lang, "attach_doc_render_failed"), code: 502 }; }
  const ares = addAttachment(w, { data: r.buffer.toString("base64"), name: docFileName(doc), ctype: "application/pdf" }, login, lang);
  if (ares.error) return { error: ares.error, code: 413 };
  audit(login, "doc_pdf_attached", w.id, `${doc.type} ${doc.docNum} DocEntry ${doc.docEntry} cust ${doc.cardCode || "?"} ${r.bytes}b${inScope ? "" : " SCOPE-OVERRIDE"}`);
  return { error: null };
}

// Attach every clean suggestion in one click. Nothing is trusted from the page: the list is the
// item's own stored suggestions, and each document is re-resolved and re-scope-checked against
// live SAP before it is rendered. Anything that no longer resolves to the same in-scope document
// is skipped and stays in the panel for the per-document buttons.
app.post("/item/:id/attach-all", async (req, res) => {
  const login = req.user.tailscale_login;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(notFoundPage(req.user));
  if (!isContactFormItem(w) && !isReturnNotificationItem(w)) {
    const have = new Set(db.prepare("SELECT name FROM draft_attachments WHERE work_item_id = ?").all(w.id).map((r) => r.name));
    const scope = await itemScope(w);
    const sugg = (await computeItemSuggestions(w)).suggestions.filter((s) => s.status === "in_scope");
    for (const d of sugg.map((s) => s.docs[0])) {
      if (have.has(docFileName(d))) continue;
      const resolved = await SAPDOC.resolveDocument(docTypeOf(d.objectId), d.docNum);
      const doc = resolved.ok && resolved.candidates.find((c) => c.docEntry === d.docEntry);
      if (!doc || !scope.cards.includes(doc.cardCode)) { audit(login, "attach_all_skipped", w.id, `${d.type} ${d.docNum}`); continue; }
      const out = await stageDocPdf(w, doc, login, req.user.lang, true);
      if (out.error) break;   // size cap or renderer down: the rest would fail the same way
      have.add(docFileName(doc));
    }
  }
  res.redirect(BASE.url("/item/" + w.id));
});

app.post("/item/:id/attach-doc", async (req, res) => {
  const lang = req.user.lang;
  const login = req.user.tailscale_login;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(notFoundPage(req.user));
  // Every outcome but success: for an in-place request (the reply card's chips and the Other
  // document dialog, X-Axle-Inline) JSON the dialog shows, a refusal banner or a choice to make in
  // `html`; for any other request a small page.
  const inline = req.get("X-Axle-Inline") === "1";
  const small = (code, kind, message, html) => inline
    ? res.status(code).json({ ok: false, kind, message, html: html || undefined, unchanged: true })
    : res.status(code).send(resultPage(req, w, t(lang, "attach_doc_title"), message, html));
  // The choices: one form per document, posting what the old buttons posted (in place when inline).
  const choice = (d, label, confirm, cls) => `<form method="post" action="${BASE.path}/item/${w.id}/attach-doc"${inline ? " data-inline" : ""}>
    <input type="hidden" name="doctype" value="${esc(type)}"><input type="hidden" name="docnum" value="${esc(String(d.docNum))}"><input type="hidden" name="docentry" value="${d.docEntry}">${confirm ? '<input type="hidden" name="confirm" value="1">' : ""}
    <button class="${cls}">${label}</button></form>`;

  if (isContactFormItem(w) || isReturnNotificationItem(w)) { audit(login, "attach_doc_refused", w.id, "new-outbound item"); return small(400, "refused", t(lang, "attach_doc_compose_only")); }

  const type = String(req.body.doctype || "order").toLowerCase();
  const num = String(req.body.docnum || "").trim();
  if (!SAPDOC.DOC_TYPES[type] || !num) return small(400, "refused", t(lang, "attach_doc_none"));

  // A webshop order name (S18169) is accepted for an order, and for an invoice it means the
  // invoice(s) drawn from that order. Everything after this works on the resolved candidates.
  const sName = (type === "order" || type === "invoice") && num.match(/^#?(S\d{3,6})$/i);
  let resolved;
  try {
    if (sName) {
      resolved = await SAPDOC.resolveShopifyOrder(sName[1]);
      if (resolved.ok && type === "invoice") {
        const inv = [];
        for (const o of resolved.candidates) inv.push(...await SAPDOC.invoicesForOrder(o.docEntry));
        resolved = { ok: true, candidates: inv };
      }
    } else resolved = await SAPDOC.resolveDocument(type, num);
  }
  catch (e) { audit(login, "attach_doc_error", w.id, e.message.slice(0, 180)); return small(502, "failed", t(lang, "attach_doc_render_failed")); }
  if (!resolved.ok || !resolved.candidates.length) { audit(login, "attach_doc_notfound", w.id, `${type} ${num}`); return small(404, "failed", t(lang, "attach_doc_none")); }

  // Choose the document: the unique match, or the candidate the human picked - validated to be IN
  // the resolver's own set (an out-of-set DocEntry is rejected, mirroring the recipient gate).
  let doc;
  const pick = parseInt(req.body.docentry, 10);
  if (resolved.candidates.length === 1) doc = resolved.candidates[0];
  else if (Number.isInteger(pick)) {
    doc = resolved.candidates.find((c) => c.docEntry === pick);
    if (!doc) { audit(login, "attach_doc_pick_rejected", w.id, `entry ${pick} not in set`); return small(400, "refused", t(lang, "attach_doc_none")); }
  } else {
    return small(200, "pick", t(lang, "attach_doc_ambiguous"), `<div class="ax-choices">${resolved.candidates.map((c) =>
      choice(c, `${icon("plus")}<span>${esc(docChoice(c, lang))}</span>`, false, "wb-menu__item")).join("")}</div>`);
  }

  // Customer-scope guard: attach straight away only when the document's customer is one of the
  // email's own customer cards (itemScope); otherwise hold for an explicit confirm.
  let scope = { cards: [], name: "" };
  try { scope = await itemScope(w); }
  catch (e) { audit(login, "attach_doc_scope_lookup_failed", w.id, e.message.slice(0, 120)); }
  const inScope = scope.cards.includes(doc.cardCode);
  const itemCard = scope.cards.join(", "), itemName = scope.name;
  if (!inScope && req.body.confirm !== "1") {
    audit(login, "attach_doc_scope_warn", w.id, `doc ${doc.cardCode || "?"} vs item ${itemCard || "?"}`);
    return small(200, "scope", t(lang, "attach_doc_scope_warn"), `<p class="wb-hint">${esc(t(lang, "attach_doc_doc_cust"))}: ${esc(doc.cardCode || "")} ${esc(doc.cardName || "")}<br>
      ${esc(t(lang, "attach_doc_email_cust"))}: ${esc(itemCard || "-")} ${esc(itemName)}</p>
      ${choice(doc, esc(t(lang, "attach_doc_scope_confirm")), true, "wb-btn wb-btn--primary")}`);
  }

  // Render (READ-ONLY) + stage in draft_attachments (capped, base64) - just like a hand-attached file.
  const out = await stageDocPdf(w, doc, login, lang, inScope);
  if (out.error) return small(out.code, "failed", out.error);
  res.redirect(BASE.url("/item/" + w.id));
});

// Preview the Boyum print PDF of a referenced SAP document in a new browser tab (READ-ONLY).
// FR-0003: lets the salesperson SEE a suggested document before deciding to attach it - it stages
// nothing and sends nothing. The DocEntry is resolved deterministically from the typed number and
// validated to be IN the resolver's own set (an out-of-set DocEntry is rejected), exactly like
// attach-doc, so a hand-crafted query can never render an arbitrary document. The PDF is served
// inline with nosniff. Previewing does NOT cross any new boundary: the same person can already
// render+stage any resolvable document via attach-doc; this is a strictly less-committal view of it.
app.get("/item/:id/preview-doc", async (req, res) => {
  const lang = req.user.lang;
  const login = req.user.tailscale_login;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(notFoundPage(req.user));
  const small = (key, code) => res.status(code).send(resultPage(req, w, t(lang, "sugg_preview"), t(lang, key)));

  const type = String(req.query.doctype || "order").toLowerCase();
  const num = String(req.query.docnum || "").trim();
  if (!SAPDOC.DOC_TYPES[type] || !num) return small("attach_doc_none", 400);

  let resolved;
  try { resolved = await SAPDOC.resolveDocument(type, num); }
  catch (e) { audit(login, "preview_doc_error", w.id, e.message.slice(0, 180)); return small("attach_doc_render_failed", 502); }
  if (!resolved.ok || !resolved.candidates.length) { audit(login, "preview_doc_notfound", w.id, `${type} ${num}`); return small("attach_doc_none", 404); }

  // Pick the document: the unique match, or the candidate whose DocEntry is in the resolver's set.
  let doc;
  const pick = parseInt(req.query.docentry, 10);
  if (resolved.candidates.length === 1) doc = resolved.candidates[0];
  else if (Number.isInteger(pick)) {
    doc = resolved.candidates.find((c) => c.docEntry === pick);
    if (!doc) { audit(login, "preview_doc_pick_rejected", w.id, `entry ${pick} not in set`); return small("attach_doc_none", 400); }
  } else {
    audit(login, "preview_doc_ambiguous", w.id, `${type} ${num}`);
    return small("attach_doc_ambiguous", 400);
  }

  // Scope is recorded for the audit only - preview never crosses the attach boundary, so it does
  // not block on customer scope (attach still does, via /attach-doc's scope-warn + confirm).
  let scope = { cards: [] };
  try { scope = await itemScope(w); } catch (e) { /* scope note best-effort */ }
  const offScope = !scope.cards.includes(doc.cardCode);

  let r;
  try { r = await SAPDOC.renderPdf(doc.objectId, doc.docEntry); }
  catch (e) { audit(login, "preview_doc_error", w.id, e.message.slice(0, 180)); return small("attach_doc_render_failed", 502); }
  if (!r.ok) { audit(login, "preview_doc_render_failed", w.id, String(r.error).slice(0, 180)); return small("attach_doc_render_failed", 502); }

  const filename = SAPDOC.docTypeInfo(type).prefix + "-" + doc.docNum + ".pdf";
  audit(login, "doc_pdf_previewed", w.id, `${doc.type} ${doc.docNum} DocEntry ${doc.docEntry} cust ${doc.cardCode || "?"} ${r.bytes}b${offScope ? " OUT-OF-SCOPE" : ""}`);
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${filename}"`,
    "X-Content-Type-Options": "nosniff",
  });
  res.send(r.buffer);
});

// FR-0002: customer detail-modal body (READ-ONLY). Returns the inner HTML htmx loads into the
// dialog when the salesperson clicks "View full customer". The CardCode is resolved server-side
// from the item (compose_customer or the inbound sender) - never from a client-supplied value - so
// this only ever exposes the email's own customer. Read-only SAP via customer-summary.js.
app.get("/item/:id/customer-modal", async (req, res) => {
  const lang = req.user.lang;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(`<p class="muted">${esc(t(lang, "not_found"))}</p>`);
  let card = null;
  try { card = await itemCardCode(w); } catch (e) { card = null; }
  if (!card) return res.send(`<p class="muted">${esc(t(lang, "cust_no_customer"))}</p>`);
  let d;
  try { d = await CUSTSUM.detail(card); }
  catch (e) { audit(req.user.tailscale_login, "customer_detail_error", w.id, String(e.message || e).slice(0, 150)); return res.send(`<p class="muted">${esc(t(lang, "cust_load_error"))}</p>`); }
  if (!d) return res.send(`<p class="muted">${esc(t(lang, "cust_no_customer"))}</p>`);
  audit(req.user.tailscale_login, "customer_detail_viewed", w.id, `${d.summary.cardCode} ${d.summary.cardName || ""}`.slice(0, 120));
  res.send(customerModalBody(d, lang));
});

// Status changes: done / phone (= done, resolved without email) / archived / reopen.
// Each close records HOW the item was resolved in work_items.resolution ("replied" is set
// by the send route itself); reopen clears it again.
app.post("/item/:id/status", async (req, res) => {
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(notFoundPage(req.user));
  const CLOSE = { done: ["done", "done"], phone: ["done", "phone"], archived: ["archived", "no_action"] };
  const to = req.body.to === "reopen"
    ? (db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE work_item_id = ?").get(w.id).n ? "ready" : "new")
    : CLOSE[req.body.to] ? CLOSE[req.body.to][0] : null;
  const resolution = req.body.to === "reopen" ? null : CLOSE[req.body.to] ? CLOSE[req.body.to][1] : null;
  if (to && w.status !== "investigating") {
    db.prepare("UPDATE work_items SET status = ?, resolution = ?, updated_at = datetime('now') WHERE id = ?").run(to, resolution, w.id);
    audit(req.user.tailscale_login, "status_change", w.id, `${w.status} -> ${to}${resolution && resolution !== "done" ? ` (${resolution})` : ""}`);
    if (to === "done" || to === "archived") await markReadSafe(req.user.tailscale_login, w);
  }
  res.redirect(req.body.to === "reopen" ? BASE.url("/item/" + w.id) : BASE.url("/"));
});

};
