// routes/item.js - the item detail page and its actions: inbound attachments,
// outbound attachment staging, work-form save/redraft, language re-tag, owner
// reassign, reply translation, SAP-document attach (draft-only staging) and status
// changes. Extracted VERBATIM from server.js (UI rework Step 0, 2026-06-10).
// NOT here, deliberately: /item/:id/send and /item/:id/contactform-recipient stay
// in server.js - the send/recipient safety paths do not move in this refactor.
const C = require("../connectors.js");
const TR = require("../translate.js");
const SCEN = require("../scenarios.js");
const SAPDOC = require("../sap-doc-pdf.js");       // render a referenced SAP document to its Boyum print PDF (read-only)
const DOCSUGGEST = require("../doc-suggest.js");   // Auto-attach: resolve + scope-filter referenced documents (read-only)
const CUSTSUM = require("../customer-summary.js"); // FR-0002: read-only customer at-a-glance + detail
const RSET = require("../recipient-set.js");       // the single definition of an item's known addresses
const FG = require("../forward-guard.js");         // handover forward: deterministic internal-only guardrails
const FWD = require("../forward.js");              // handover forward: the Graph call (Mail.Send)
const SG = require("../send-guard.js");            // only for needsConfirmedRecipient (the UI mirror of the send refusal)
const DS = require("../draft-staleness.js");       // is the newest stored draft still this email's draft?
const { db, audit } = require("../db.js");
const { esc, t, page, linkify, splitQuoted, fmtSize, renderAttachments, renderMail,
        fmtDateTime, statusWithRes, suggestCloseChip, intentLabel, kindLabel, langDisplay, ownerLabel,
        ownerChoices, chipMenu, renderTimeline, workPanes, shell, lazyQueue } = require("../views/ui.js");
const { anthropic, MAILBOX_OF, MAX_ATTACH_BYTES, runRedraft, markReadSafe,
        isContactFormItem, isReturnNotificationItem, itemKind, saveWorkInputs, addAttachment } = require("./shared.js");

// Resolver-backed address lookups, built once. Best-effort by contract (see recipient-set.js).
const RSET_DEPS = RSET.defaultDeps();

module.exports = function mountItem(app, { ACTION_COMPOSE_SEND, ACTION_CONTACTFORM_SEND, ACTION_RETURN_SEND, ACTION_OWNER_FORWARD }) {

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
// (cf.language) — so an English draft never gets a Dutch subject. Order-ref wins when present.
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

// Render the "Suggested documents" panel. in_scope -> one-click Attach; ambiguous -> a button per
// in-scope candidate (validated in-set by the route); out_of_scope -> a separate "different
// customer - review" area whose button hits /attach-doc WITHOUT confirm, so the existing
// scope-warn + attach-anyway (SCOPE-OVERRIDE audit) screen handles it. Every button posts to the
// proven /attach-doc route; this panel never renders or stages anything itself.
function suggestionsPanel(w, suggestions, lang) {
  if (!suggestions || !suggestions.length) return "";
  const docType = (objectId) => {
    for (const k of Object.keys(SAPDOC.DOC_TYPES)) if (SAPDOC.DOC_TYPES[k].objectId === objectId) return k;
    return "order";
  };
  const fmtDoc = (d) => {
    const date = d.docDate ? new Date(d.docDate).toISOString().slice(0, 10) : "";
    const money = (d.docTotal != null ? d.docTotal : "") + (d.docCur ? " " + d.docCur : "");
    return `${esc(String(d.type))} ${esc(String(d.docNum))} &middot; ${esc(d.cardName || d.cardCode || "")} &middot; ${esc(String(money))}${date ? " &middot; " + esc(date) : ""}`;
  };
  // A read-only Preview link: opens the rendered document PDF in a new tab (GET /preview-doc),
  // staging nothing. The route re-resolves the number deterministically and validates the DocEntry
  // is in its own set, exactly like attach-doc, so a hand-crafted query can't render an arbitrary doc.
  const previewLink = (d) => {
    const qs = `doctype=${encodeURIComponent(docType(d.objectId))}&docnum=${encodeURIComponent(String(d.docNum))}&docentry=${encodeURIComponent(String(d.docEntry))}`;
    return `<a class="preview-doc" href="/item/${w.id}/preview-doc?${qs}" target="_blank" rel="noopener" title="${esc(t(lang, "sugg_preview_title"))}">${esc(t(lang, "sugg_preview"))}</a>`;
  };
  // One suggested document on a row: the Attach button (posts the resolved doc to the proven
  // /attach-doc route, keyed by DocNum + DocEntry) plus the Preview link beside it. This panel
  // still renders/stages nothing itself.
  const addForm = (d, label, cls) => `
    <div class="suggdoc">
      <form method="post" action="/item/${w.id}/attach-doc">
        <input type="hidden" name="doctype" value="${esc(docType(d.objectId))}">
        <input type="hidden" name="docnum" value="${esc(String(d.docNum))}">
        <input type="hidden" name="docentry" value="${esc(String(d.docEntry))}">
        <button class="${cls}">${esc(label)} &mdash; ${fmtDoc(d)}</button>
      </form>
      ${previewLink(d)}
    </div>`;

  const inScope = suggestions.filter((s) => s.status === "in_scope" || s.status === "ambiguous");
  const offScope = suggestions.filter((s) => s.status === "out_of_scope");

  const inHtml = inScope.map((s) => {
    const ref = `<span class="muted">${esc(t(lang, "sugg_ref"))} "${esc(s.reference.raw)}"</span>`;
    if (s.status === "in_scope") return `<div class="suggrow">${addForm(s.docs[0], t(lang, "sugg_add"), "mini")} ${ref}</div>`;
    // ambiguous: a button per in-scope candidate
    return `<div class="suggrow"><p class="muted" style="margin:2px 0">${esc(t(lang, "sugg_pick"))} ${ref}</p>${s.docs.map((d) => addForm(d, t(lang, "sugg_add"), "mini")).join("")}</div>`;
  }).join("");

  const offHtml = offScope.length ? `
    <details style="margin-top:8px">
      <summary>${esc(t(lang, "sugg_other_cust"))} (${offScope.length})</summary>
      <p class="muted">${esc(t(lang, "sugg_other_cust_hint"))}</p>
      ${offScope.map((s) => `<div class="suggrow">${s.docs.map((d) => addForm(d, t(lang, "sugg_review"), "mini warn")).join("")} <span class="muted">${esc(t(lang, "sugg_ref"))} "${esc(s.reference.raw)}"</span></div>`).join("")}
    </details>` : "";

  // Step 1 (F11): content-only — rendered inside the combined "SAP documents" card,
  // next to the manual attach-by-number form. Buttons and routes unchanged.
  return `<p class="muted hint">${esc(t(lang, "sugg_hint"))}</p>
      ${inHtml}${offHtml}`;
}

// --- FR-0002: at-a-glance customer summary + detail modal (READ-ONLY) --------------------
// Resolve the item's customer CardCode on the TRUSTED side only: compose_customer for a compose
// item, else the inbound sender via customerByEmail. Never derived from email content, so this can
// only ever read the email's own customer. Contact-form items (sender = Shopify's mailer) get none.
async function itemCardCode(w) {
  let cc = null; try { cc = JSON.parse(w.compose_customer || "null"); } catch (e) { cc = null; }
  if (cc && cc.cardCode) return cc.cardCode;
  if (w.origin !== "compose" && !isContactFormItem(w) && !isReturnNotificationItem(w) && w.sender_email) {
    try { const m = await SAPDOC.customerByEmail(w.sender_email); if (m && m.cardCode) return m.cardCode; }
    catch (e) { /* unknown sender -> no card */ }
  }
  return null;
}

// Compact money for the card/modal. EUR -> "€1,234.56"; any other currency is prefixed.
function fmtMoney(n, cur) {
  const v = (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (cur && cur !== "EUR") ? `${esc(cur)} ${v}` : `€${v}`;
}

// The at-a-glance customer card for the context pane (s = summary from customer-summary.js, or null).
// "View full customer" opens the detail dialog and htmx-loads /customer-modal into it.
function customerCard(s, lang, itemId) {
  if (!s) return "";
  const chip = (label, val) => `<div class="cuschip"><p class="cuslbl">${esc(label)}</p><p class="cusval">${val}</p></div>`;
  const tier = s.tier ? esc(s.tier) : "&mdash;";
  const orders = `${s.openOrders} <span class="muted">&middot;</span> ${fmtMoney(s.openOrdersVal, s.currency)}`;
  const invs = `${s.openInvoices} <span class="muted">&middot;</span> ${fmtMoney(s.openInvOutstanding, s.currency)}`;
  const sub = [s.cardCode, s.country, s.group].filter(Boolean).map(esc).join(" &middot; ");
  const frozen = s.frozen ? ` <span class="st-warn">${esc(t(lang, "cust_frozen"))}</span>` : "";
  return `<div class="box cuscard">
      <div class="boxhead"><h3>${esc(t(lang, "cust_card_title"))}</h3></div>
      <p class="cusname">${esc(s.cardName || s.cardCode)}${frozen}</p>
      <p class="muted cussub">${sub}</p>
      <div class="cusgrid">
        ${chip(t(lang, "cust_tier"), tier)}
        ${chip(t(lang, "cust_open_orders"), orders)}
        ${chip(t(lang, "cust_open_invoices"), invs)}
      </div>
      <button type="button" class="mini cusbtn" aria-haspopup="dialog"
        hx-get="/item/${itemId}/customer-modal" hx-target="#cusModalBody" hx-swap="innerHTML"
        onclick="var d=document.getElementById('cusModal'); if(d&&d.showModal) d.showModal();">${esc(t(lang, "cust_view_full"))}</button>
      <dialog id="cusModal" class="cusdialog" aria-label="${esc(t(lang, "cust_detail_title"))}">
        <form method="dialog" class="cusx"><button class="cusxbtn" aria-label="${esc(t(lang, "cust_close"))}">&times;</button></form>
        <div id="cusModalBody"><p class="muted"><span class="spin"></span> ${esc(t(lang, "cust_loading"))}</p></div>
        <script>(function(){var d=document.getElementById('cusModal');if(d&&!d._wired){d._wired=1;d.addEventListener('click',function(e){if(e.target===d)d.close();});}})();</script>
      </dialog>
    </div>`;
}

// The detail-modal body (loaded into #cusModalBody by the /customer-modal route). d = detail().
function customerModalBody(d, lang) {
  const s = d.summary;
  const stat = (label, val) => `<div class="cusstat"><p class="cuslbl">${esc(label)}</p><p class="cusval">${esc(val)}</p></div>`;
  const statusPill = (open, openLbl, doneLbl, extra) =>
    open ? `<span class="st-warn">${esc(openLbl)}${extra ? " " + esc(extra) : ""}</span>` : `<span class="st-ok">${esc(doneLbl)}</span>`;
  const ordRows = d.orders.length ? d.orders.map((o) =>
    `<tr><td>${esc(String(o.docNum))}</td><td>${esc(o.docDate || "")}</td><td class="num">${fmtMoney(o.total, s.currency)}</td>
       <td>${statusPill(o.open, t(lang, "cust_open"), t(lang, "cust_closed"))}</td></tr>`).join("")
    : `<tr><td colspan="4" class="muted">${esc(t(lang, "cust_none"))}</td></tr>`;
  const invRows = d.invoices.length ? d.invoices.map((i) =>
    `<tr><td>${esc(String(i.docNum))}</td><td>${esc(i.docDate || "")}</td><td class="num">${fmtMoney(i.total, s.currency)}</td>
       <td>${statusPill(i.open, t(lang, "cust_unpaid"), t(lang, "cust_paid"), i.open ? fmtMoney(i.outstanding, s.currency) : "")}</td></tr>`).join("")
    : `<tr><td colspan="4" class="muted">${esc(t(lang, "cust_none"))}</td></tr>`;
  const sub = [s.cardCode, s.country, s.group].filter(Boolean).map(esc).join(" &middot; ");
  return `<h3 class="cusmodttl">${esc(s.cardName || s.cardCode)}${s.frozen ? ` <span class="st-warn">${esc(t(lang, "cust_frozen"))}</span>` : ""}</h3>
    <p class="muted cussub">${sub}${s.tier ? " &middot; " + esc(s.tier) : ""}</p>
    <div class="cusstats">
      ${stat(t(lang, "cust_lifetime"), fmtMoney(d.stats.lifetimeInv, s.currency))}
      ${stat(t(lang, "cust_12m"), fmtMoney(d.stats.inv12m, s.currency))}
      ${stat(t(lang, "cust_balance"), fmtMoney(s.balance, s.currency))}
      ${stat(t(lang, "cust_since"), d.stats.firstInv || "—")}
      ${stat(t(lang, "cust_last_order"), d.stats.lastOrder || "—")}
    </div>
    <h4 class="cusmh">${esc(t(lang, "cust_recent_orders"))}</h4>
    <table class="custbl"><thead><tr><th>${esc(t(lang, "col_doc"))}</th><th>${esc(t(lang, "col_date"))}</th><th class="num">${esc(t(lang, "col_total"))}</th><th>${esc(t(lang, "col_status"))}</th></tr></thead><tbody>${ordRows}</tbody></table>
    <h4 class="cusmh">${esc(t(lang, "cust_recent_invoices"))}</h4>
    <table class="custbl"><thead><tr><th>${esc(t(lang, "col_doc"))}</th><th>${esc(t(lang, "col_date"))}</th><th class="num">${esc(t(lang, "col_total"))}</th><th>${esc(t(lang, "col_status"))}</th></tr></thead><tbody>${invRows}</tbody></table>`;
}

app.get("/item/:id", async (req, res) => {
  const lang = req.user.lang;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) {
    // An htmx queue-click gets a pane-shaped 404 so the swap stays tidy; a plain
    // navigation gets the full page exactly as before.
    if (req.get("HX-Request")) return res.status(404).send(workPanes(`<p>${esc(t(lang, "not_found"))}</p>`, ""));
    return res.status(404).send(page("Not found", req.user, `<p>${esc(t(lang, "not_found"))}</p>`));
  }
  audit(req.user.tailscale_login, "view_item", w.id, `lang=${lang}`);
  const isCompose = w.origin === "compose";   // a proactively-composed outbound item (no inbound email)
  const isContactForm = isContactFormItem(w);  // webshop contact-form msg: real recipient is in the body, not the sender
  const isRN = isReturnNotificationItem(w);    // Shopify "Return items" notification: reply goes to the order's customer

  // Contact-form enrichment (from ingest): parsed customer + candidate addresses. Parsed once
  // here so both the work form (subject) and the customer header below can use it.
  let cf = null;
  if (isContactForm) { try { cf = JSON.parse(w.contact_form_json || "null"); } catch (e) { cf = null; } }
  const cfSubjectDefault = isContactForm ? contactFormSubject(cf, w.language || lang) : "";

  // Return-notification enrichment (from ingest): parsed order ref + resolved customer + candidate
  // addresses. Same shape as the contact form so the header renders the same way.
  let rn = null;
  if (isRN) { try { rn = JSON.parse(w.return_json || "null"); } catch (e) { rn = null; } }
  const rnSubjectDefault = isRN ? returnSubject(rn, rn && rn.parsed && rn.parsed.orderRef, w.language || lang) : "";

  // AI reference drafts (source='ai'); human-sent drafts are kept separately for the audit
  // trail and must not be shown as "the AI draft".
  const fullRow = db.prepare("SELECT * FROM drafts WHERE work_item_id = ? AND is_interim = 0 AND source = 'ai' ORDER BY version DESC, id DESC LIMIT 1").get(w.id);
  const interimRow = db.prepare("SELECT * FROM drafts WHERE work_item_id = ? AND is_interim = 1 AND source = 'ai' ORDER BY version DESC, id DESC LIMIT 1").get(w.id);

  // A DRAFT WRITTEN BEFORE THE CURRENT EMAIL ARRIVED IS NOT THIS EMAIL'S DRAFT (2026-08-15, item
  // 1308). The item reopens on each new message in the thread, but a run that writes no draft row —
  // a no_reply outcome (suggest_close), or a run that errored — leaves the PREVIOUS round's draft as
  // the newest, and the queries above then present it as the current reply. See draft-staleness.js
  // for the full case and the reasoning behind the test.
  const fullStale = DS.isSupersededDraft(w, fullRow);
  const interimStale = DS.isSupersededDraft(w, interimRow);
  const interim = interimStale ? null : interimRow;

  // HELD ITEMS MUST NOT OFFER A SUPERSEDED DRAFT (2026-08-12, found live-verifying item 1249).
  // When a run holds the reply it emits no full draft, so ingest inserts no row — and this query
  // used to fall back to the PREVIOUS run's draft and present it as the current AI draft under
  // "this exact text goes to the customer". On 1249 that meant the very sentences the accuracy
  // gates had just refused ("it matches your VIN perfectly", "ships directly from our supplier")
  // sat in the send box, one click from the customer. Holding a draft is pointless if the
  // superseded one stays sendable.
  //
  // status='awaiting_input' is the invariant: a held run always clears result.draft (the
  // two-stage prompt rule, applyFitmentGate and holdDraft all do), so an awaiting_input item can
  // never have a CURRENT full draft — anything found is from an earlier run. Drop it, and let the
  // send box fall through to the INTERIM: the current run's only-what-we-know reply, which is
  // written to be safe to send exactly as-is. A human's own saved edit (draft_edit) always wins;
  // that is their text, not ours.
  const held = w.status === "awaiting_input" && !!fullRow;
  const full = (held || fullStale) ? null : fullRow;
  // The dropped draft is still worth seeing — it is the research from the previous round — but only
  // as read-only history, clearly labelled and out of the send path. Held drafts stay hidden (above).
  const supersededRow = fullStale ? fullRow : (interimStale ? interimRow : null);
  // Withdrawn drafts (source='withdrawn') are still recorded for the audit trail, but they are
  // NOT shown: a red "withdrawn" card next to a perfectly good reply reads as breakage rather
  // than as care. The reply the salesperson sees is simply the current, safe one.
  const latestVer = full ? full.version : (interim ? interim.version : 0);
  const questions = db.prepare("SELECT * FROM questions WHERE work_item_id = ? ORDER BY id").all(w.id);
  const open = questions.filter((q) => !q.answer);
  const busy = w.status === "investigating";
  const editable = !busy && !["done", "archived"].includes(w.status);
  const sentRow = db.prepare("SELECT * FROM sends WHERE work_item_id = ? AND status = 'sent' ORDER BY id DESC LIMIT 1").get(w.id);
  // Send is allowed any time the item isn't flagged (questions need not be answered first);
  // an injection-flagged item can NEVER send. The body is re-validated by send-guard on submit.
  // compose: action #3 OFF -> never a Send button. contact-form (action #4): the sender is
  // Shopify's mailer, not the customer, so a send is a NEW outbound to the code-held, confirmed
  // recipient - allowed only when action #4 is enabled AND a recipient has been confirmed.
  const cfCanSend = isContactForm && ACTION_CONTACTFORM_SEND && !!w.recipient;
  const composeCanSend = isCompose && ACTION_COMPOSE_SEND && !!w.recipient;
  const rnCanSend = isRN && ACTION_RETURN_SEND && !!w.recipient;
  // internal_forward: a colleague handed this customer email to us, so the thread sender is one of
  // OUR OWN mailboxes. Replying to the sender would mail ourselves, so send-guard refuses until a
  // recipient is confirmed - mirrored here so the button says "Confirm recipient" rather than
  // offering a Send that is going to be refused at the route.
  const fwdNeedsRecipient = SG.needsConfirmedRecipient(w);
  const canSend = editable && !w.injection_flag && !fwdNeedsRecipient
    && (!isCompose || composeCanSend) && (!isContactForm || cfCanSend) && (!isRN || rnCanSend);
  // The editable reply: the human's saved edit if any, else the AI full draft, else the holding reply.
  const replyText = w.draft_edit != null ? w.draft_edit : (full ? full.body : (interim ? interim.body : ""));
  const atts = db.prepare("SELECT id, name, content_type, size FROM draft_attachments WHERE work_item_id = ? ORDER BY id").all(w.id);

  // Auto-attach: SAP documents this inbound email references and that belong to its customer
  // (read-only; rendered/staged only when the human clicks Attach, via the existing /attach-doc
  // route). Skipped for compose/contact-form/injection-flagged items inside the helper. Step 1
  // (F11): rendered inside the combined "SAP documents" card below, not as its own box.
  const suggHtml = editable ? suggestionsPanel(w, (await computeItemSuggestions(w)).suggestions, lang) : "";

  // FR-0002: at-a-glance customer summary (read-only; 3-min cached). Shown whenever the item resolves
  // to a SAP customer (inbound sender or the compose customer). Wrapped so SAP slowness/errors can
  // never break the item page.
  let custHtml = "";
  let custName = "";   // used to name the customer in the typed-recipient send confirm
  try {
    const card = await itemCardCode(w);
    if (card) {
      const s = await CUSTSUM.summarise(card);
      custHtml = customerCard(s, lang, w.id);
      custName = (s && s.name) || "";
    }
  } catch (e) { audit("system", "cust_summary_error", w.id, String(e.message || e).slice(0, 150)); }

  // The recipient control's option set: the thread sender plus whatever the deterministic resolver
  // holds for THIS item's customer. Best-effort — recipient-set swallows a SAP failure, so a slow
  // or dead SAP costs a radio option, never the page. Not computed for items that can't be edited,
  // and never for an injection-flagged item (which must not be offered a redirect UI at all).
  const kind = itemKind(w);
  let knownAddrs = [];
  if (editable && !w.injection_flag) {
    try { knownAddrs = await RSET.knownAddressesFor(w, kind, RSET_DEPS); }
    catch (e) { audit("system", "recipient_set_error", w.id, String(e.message || e).slice(0, 150)); }
  }

  // --- On-view translation into the viewer's language (cached -> inline; uncached
  // -> ASYNC). UX round (2026-06-11): translating inline on first view stalled the
  // whole route for seconds ("click does nothing" territory). Now only CACHED
  // translations render inline (a sync DB hit); anything uncached renders a pending
  // placeholder and the browser fills it from POST /item/:id/translations in the
  // background. Every later view hits the cache and renders inline again.
  const custLang = (w.language || "").toLowerCase();
  const needContent = custLang && custLang !== lang;
  let emailTr = null, emailTrPending = false;
  if (needContent && !isCompose) {
    const top = splitQuoted(String(w.email_text || "")).top;
    if (top.trim()) { emailTr = TR.cached(lang, top); emailTrPending = !emailTr; }
  }
  const qTr = {};
  let qTrPending = false;
  if (lang !== "en") for (const q of questions) {
    const c = TR.cached(lang, q.question);
    if (c) qTr[q.id] = c; else qTrPending = true;
  }
  const qText = (q) => (lang !== "en" && qTr[q.id]) || q.question;
  // Marks the question text for the background fill (English shows until it lands).
  const qTrAttr = (q) => (lang !== "en" && !qTr[q.id]) ? ` data-trq="${q.id}"` : "";

  // --- chips (F5): one visual element per fact; the editable ones ARE the control.
  // Clicking the language/owner chip opens a dropdown; one click posts through the
  // SAME audited routes as before (/language, /owner) - no behaviour change.
  const scen = isCompose && w.scenario ? SCEN.byKey(w.scenario) : null;   // scenario chip for compose
  const LANGS = ["nl", "en", "de", "fr", "es"];
  const langChipHtml = `${esc(t(lang, "language"))}: ${esc((w.language || "?").toUpperCase())}`;
  const langChip = editable
    ? chipMenu({
        lang, chipClass: "", chipHtml: langChipHtml, title: t(lang, "lang_fix"),
        action: `/item/${w.id}/language`, field: "language", current: w.language || "",
        options: LANGS.map((l) => ({ value: l, label: `${l.toUpperCase()} — ${langDisplay(lang, l)}` })),
        note: isCompose ? t(lang, "relang_note") : "",
      })
    : `<span class="chip">${langChipHtml}</span>`;
  const ownerOpts = ownerChoices(w.mailbox);
  const ownerChipHtml = `${esc(t(lang, "owner"))}: ${esc(ownerLabel(w))}`;
  // An owner who works a DIFFERENT mailbox is a handover, not a relabel: picking them forwards
  // the email to their mailbox and closes this item. Those options say so in the label and ask
  // for confirmation first (rendered as data-confirm; read as data, never compiled as JS).
  // forward-guard is the single source of that decision, so the menu and the route agree.
  const ownerOption = (o) => {
    const target = ACTION_OWNER_FORWARD ? FG.forwardTargetFor(w.mailbox, o) : null;
    if (!target) return { value: o, label: o };
    return {
      value: o,
      label: `${o} — ${t(lang, "owner_handover_hint")}`,
      confirm: t(lang, "owner_handover_confirm").replace("{owner}", o).replace("{address}", target.address),
    };
  };
  const ownerChip = (editable && ownerOpts.some((o) => o !== (w.owner || "")))
    ? chipMenu({
        lang, chipClass: "", chipHtml: ownerChipHtml, title: t(lang, "owner_fix"),
        action: `/item/${w.id}/owner`, field: "owner", current: w.owner || "",
        options: ownerOpts.map(ownerOption),
      })
    : `<span class="chip">${ownerChipHtml}</span>`;
  const chips = [
    isCompose ? `<span class="chip origin">${esc(t(lang, "compose_origin_chip"))}</span>` : "",
    isContactForm ? `<span class="chip origin">${esc(t(lang, "contactform_chip"))}</span>` : "",
    `<span class="chip s-${esc(w.status)}">${esc(statusWithRes(lang, w))}</span>`,
    suggestCloseChip(lang, w),
    `<span class="chip p${w.priority || 2}">${esc(t(lang, "priority"))} ${w.priority || 2}</span>`,
    w.injection_flag ? `<span class="chip inj">${esc(t(lang, "injection_chip"))}</span>` : "",
    isCompose
      ? (scen ? `<span class="chip">${esc(lang === "nl" ? scen.label_nl : scen.label_en)}</span>` : "")
      : `<span class="chip">${esc(intentLabel(lang, w.intent))}</span>`,
    langChip,
    w.confidence ? `<span class="chip">${esc(t(lang, "confidence"))}: ${esc(w.confidence)}</span>` : "",
    ownerChip,
  ].filter(Boolean).join(" ");

  // Consolidated questions (2026-06-11): ONE compact numbered list, no per-question
  // answer boxes - the single response box below (the existing feedback field) answers
  // everything at once. Only physical checks keep a marker (a walk to the shelf is
  // needed); legacy items that carry old per-question answers still show them read-only.
  const qItems = questions.map((q, i) => `
    <li>${i + 1}. ${q.kind === "physical" ? `<span class="chip k-physical">${esc(kindLabel(lang, q.kind))}</span> ` : ""}<span${qTrAttr(q)}>${esc(qText(q))}</span>
    ${q.answer ? `<br><b>${esc(t(lang, "answer"))}:</b> ${esc(q.answer)} <span class="muted">(${esc(q.answered_by)}, ${esc(fmtDateTime(q.answered_at, lang))})</span>` : ""}</li>`).join("");

  const feedbackInner = editable
    ? `<textarea class="ans" name="feedback" placeholder="${esc(t(lang, "feedback_ph"))}">${esc(w.feedback || "")}</textarea>`
    : (w.feedback ? `<pre class="mail">${esc(w.feedback)}</pre>` : `<span class="muted">${esc(t(lang, "feedback_none"))}</span>`);
  const questionsInner = questions.length ? `<ul class="qs">${qItems}</ul>` : `<span class="muted">${esc(t(lang, "no_questions"))}</span>`;

  // --- questions + feedback as ONE card (F8): first and open when answers are the
  // blocking thing, collapsed after the reply when they're not. The single response
  // box posts as the existing feedback field, so /work and /send persist as before.
  // Questions lead only when they are the blocking thing (status awaiting_input);
  // a ready item leads with the reply even if an optional question is still open.
  const needsAnswers = editable && w.status === "awaiting_input" && open.length > 0;
  const qfTitle = `${esc(t(lang, "questions_for_you"))} (${open.length} ${esc(t(lang, "open_lc"))})`;
  const qfInner = `${questionsInner}
    <p class="sublabel">${esc(t(lang, "your_feedback"))}</p>${feedbackInner}`;
  const qfCard = needsAnswers
    ? `<div class="box"><h3>${qfTitle}</h3>${qfInner}</div>`
    : `<div class="box"><details><summary>${qfTitle} &middot; ${esc(t(lang, "your_feedback"))}</summary><div style="margin-top:8px">${qfInner}</div></details></div>`;

  // Staged outbound attachments (per item). Each row has a Remove submit button; the file
  // picker base64-encodes a chosen file into hidden fields and auto-submits (no multipart).
  const attRowsHtml = atts.length
    ? atts.map((a) => `<div class="attitem">&#128206; ${esc(a.name)} <span class="muted">(${fmtSize(a.size)})</span>${(editable && /^image\//i.test(a.content_type || "")) ? ` <button type="button" class="mini" onclick="insImg(${a.id})">${esc(t(lang, "img_inline_btn"))}</button>` : ""}${editable ? ` <button class="mini" name="remove_att" value="${a.id}" formnovalidate>${esc(t(lang, "remove"))}</button>` : ""}</div>`).join("")
    : `<span class="muted">${esc(t(lang, "no_attachments"))}</span>`;

  // --- ONE editable reply card (F6), seeded from the AI draft. "Reset to AI draft"
  // restores the reference (held in a hidden, name-less textarea so it never posts);
  // "Show translation" reuses the on-demand /translate-reply call. The subject field
  // for contact-form/compose lives at the top of the card (it is part of the send).
  const isEdited = w.draft_edit != null && (full ? w.draft_edit !== full.body : (interim ? w.draft_edit !== interim.body : w.draft_edit !== ""));
  const aiSeed = full || interim;
  const subjectField = (isContactForm || isCompose || isRN)
    ? `<p class="sublabel">${esc(t(lang, "cf_subject"))} <span class="muted">&mdash; ${esc(t(lang, "cf_subject_hint"))}</span></p>
       <input class="cfsubj" name="${isContactForm ? "cf_subject" : isRN ? "return_subject" : "compose_subject"}" value="${esc(isContactForm ? cfSubjectDefault : isRN ? rnSubjectDefault : (w.subject || ""))}">`
    : "";
  const replyTools = [
    isEdited ? `<span class="badge edited">${esc(t(lang, "edited_badge"))}</span>` : "",
    aiSeed ? `<button type="button" class="mini" onclick="resetReply()">${esc(t(lang, "reset_ai"))}${full ? ` (v${latestVer})` : ""}</button>` : "",
    needContent ? `<button type="button" class="mini" id="replytrbtn" onclick="translateReply()">${esc(t(lang, "show_translation"))}</button>` : "",
  ].filter(Boolean).join(" ");
  const replyCard = `<div class="box">
    <div class="boxhead"><h3>${esc(t(lang, "reply_to_send"))}</h3><span class="tools">${replyTools}</span></div>
    <p class="muted trnote">${esc(t(lang, "reply_hint"))}</p>
    ${subjectField}
    <textarea class="draft" id="replybox" name="reply">${esc(replyText)}</textarea>
    ${aiSeed ? `<textarea id="ai_seed" hidden readonly>${esc(aiSeed.body)}</textarea>` : ""}
    <div id="replytr" class="trbox replytr" style="display:none"><pre class="mail trbody"></pre></div>
  </div>`;
  const attCard = `<div class="box attzone" id="attzone"><h3>${esc(t(lang, "attachments"))}${atts.length ? ` (${atts.length})` : ""}</h3>
    <div id="attlist">${attRowsHtml}</div>
    <p class="muted attnote">${esc(t(lang, "attach_hint"))} ${esc(t(lang, "drop_hint"))}. ${esc(t(lang, "paste_hint"))} ${esc(t(lang, "paste_hint_inline"))}</p>
    <input type="file" id="att_file" multiple></div>`;

  // The previous round's draft, collapsed. Plain <details> — no JS, no interpolated strings in
  // attributes. It sits outside the work form, so its text can never be posted or sent.
  const supersededCard = supersededRow ? `<div class="box">
    <details class="fold prevdraft">
      <summary>${esc(t(lang, "prev_draft_summary"))}</summary>
      <p class="muted trnote">${esc(t(lang, "prev_draft_hint"))}</p>
      <textarea class="draft" readonly>${esc(supersededRow.body)}</textarea>
    </details>
  </div>` : "";

  // The work form (state-driven order, F8): when answers block progress the questions
  // card leads; otherwise the reply leads and questions sit collapsed beneath. The
  // buttons live in the sticky action bar below and submit THIS form via form=.
  const workSection = editable
    ? `<form method="post" action="/item/${w.id}/work" id="workform">
         ${needsAnswers ? qfCard : ""}
         ${replyCard}
         ${attCard}
         ${!needsAnswers ? qfCard : ""}
       </form>`
    : `${(sentRow && sentRow.body) || replyText
          ? `<div class="box"><h3>${esc(t(lang, "reply_to_send"))}</h3>${sentRow ? `<p class="sent">&#10003; ${esc(t(lang, "sent_to"))} ${esc(sentRow.to_addr)} ${esc(t(lang, "on_word"))} ${esc((sentRow.sent_at || "").slice(0, 16))} UTC</p>` : ""}<textarea class="draft" readonly>${esc((sentRow && sentRow.body) || replyText)}</textarea></div>`
          : ""}
       ${atts.length ? `<div class="box"><h3>${esc(t(lang, "attachments"))} (${atts.length})</h3><div id="attlist">${attRowsHtml}</div></div>` : ""}
       <div class="box"><h3>${esc(t(lang, "questions_for_you"))} (${open.length} ${esc(t(lang, "open_lc"))})</h3>${qfInner}</div>`;

  // --- combined "SAP documents" card (F11): suggested documents (one-click attach via
  // the proven /attach-doc route) + the manual attach-by-number form, together. Not for
  // contact-form items (/attach-doc refuses them, as before).
  const sapDocsCard = (editable && !isContactForm && !isRN) ? `<div class="box">
      <div class="boxhead"><h3>${esc(t(lang, "sap_docs"))}</h3></div>
      ${suggHtml}${suggHtml ? `<div class="subdiv"></div>` : ""}
      <p class="sublabel">${esc(t(lang, "attach_manual"))}</p>
      <p class="muted hint">${esc(t(lang, "attach_doc_hint"))}</p>
      <form method="post" action="/item/${w.id}/attach-doc" class="attdoc">
        <label>${esc(t(lang, "attach_doc_type"))}:
          <select name="doctype">
            <option value="order">${esc(t(lang, "doc_order"))}</option>
            <option value="invoice">${esc(t(lang, "doc_invoice"))}</option>
            <option value="quotation">${esc(t(lang, "doc_quotation"))}</option>
            <option value="delivery">${esc(t(lang, "doc_delivery"))}</option>
            <option value="creditnote">${esc(t(lang, "doc_creditnote"))}</option>
          </select></label>
        <input name="docnum" inputmode="numeric" placeholder="${esc(t(lang, "attach_doc_number"))}" style="width:8em">
        <button class="mini">${esc(t(lang, "attach_doc_btn"))}</button>
      </form>
    </div>` : "";

  // --- sticky action bar (F9): Send (confirm-click, same route + guard), Save,
  // Save & redraft, and the close actions in an overflow menu whose tooltips are
  // visible descriptions. Buttons submit the work form via form=; routes unchanged.
  // The recipient control (editable send recipient, 2026-07-10). One control for all four item
  // kinds, living IN the send button: the sticky action bar is guaranteed to be on screen at the
  // moment of sending, whereas a To: field 400px up the page is not. The amber "changed" pill is
  // the whole reason it lives here.
  //
  // The typed address is NEVER pre-filled from the email body, a tool result or any model output —
  // the input starts empty, every time. The model can never place an address in front of the
  // salesperson to click. The radios come only from knownAddressesFor().
  const sendTo = RSET.activeRecipient(w, kind);
  const redirected = RSET.isRedirected(w, kind);
  const typedTo = RSET.norm(w.recipient_source) === "typed";

  // A typed address gets a stronger confirm that names the customer it is NOT on file for. The
  // customer name comes from the trusted SAP summary, never from the email.
  const sendConfirm = (typedTo
      ? t(lang, "recip_typed_confirm").replace("{to}", sendTo).replace("{customer}", custName || t(lang, "recip_this_customer"))
      : t(lang, "send_confirm").replace("{to}", sendTo))
    + (atts.length ? " (" + t(lang, "with_atts").replace("{n}", atts.length) + ")" : "");

  const srcLabel = { sender: t(lang, "recip_from_sender"), onfile: t(lang, "recip_on_file"),
                     form: t(lang, "recip_from_form"), typed: t(lang, "recip_typed") };

  // Two forms, deliberately: the radios post mode=known, the free-text input posts mode=typed. One
  // form with both would collide on the `addr` field name and would need JS to disambiguate. This
  // way the control works with scripting off, and each path hits its own screen at the route.
  // A typed override is NOT a radio option. Rendering it as a checked-but-disabled radio (as this
  // first did) meant the radio group submitted nothing, so "Use address" posted an empty addr and
  // the route rejected it - a dead end with a confusing error. It belongs above the list, as a
  // read-only statement of where the reply is currently going. Only resolver-produced addresses
  // are pickable, which is also exactly what pickKnown() will accept.
  const pickable = knownAddrs.filter((e) => e.source !== "typed");
  const typedEntry = knownAddrs.find((e) => e.source === "typed");
  const checkedAddr = pickable.some((e) => e.addr === sendTo) ? sendTo : (pickable[0] || {}).addr;

  const recipPop = (editable && !w.injection_flag) ? `
    <details class="menu recip-pop">
      <summary class="btn send-caret" title="${esc(t(lang, "recip_change"))}" aria-label="${esc(t(lang, "recip_change"))}">&#9662;</summary>
      <div class="menu-list">
        ${typedEntry ? `<p class="recip-current muted">${esc(t(lang, "recip_current"))}: <b>${esc(typedEntry.addr)}</b> &mdash; ${esc(srcLabel.typed)}</p>` : ""}
        <form method="post" action="/item/${w.id}/recipient" class="recip-known">
          <input type="hidden" name="mode" value="known">
          ${pickable.map((e) => `<label class="cfopt"><input type="radio" name="addr" value="${esc(e.addr)}" ${e.addr === checkedAddr ? "checked" : ""}> ${esc(e.addr)} <span class="muted">&mdash; ${esc(srcLabel[e.source] || e.source)}</span></label>`).join("")}
          ${pickable.length ? `<p><button class="mini primary" name="use" value="1">${esc(t(lang, "recip_use"))}</button></p>` : ""}
        </form>
        <div class="subdiv"></div>
        <details class="recip-other">
          <summary class="muted">${esc(t(lang, "recip_other"))}</summary>
          <form method="post" action="/item/${w.id}/recipient">
            <input type="hidden" name="mode" value="typed">
            <input name="addr" type="email" autocomplete="off" spellcheck="false" placeholder="name@company.nl" required>
            <button class="mini primary" name="use" value="1">${esc(t(lang, "recip_use"))}</button>
          </form>
        </details>
        <div class="sheet-title m-only">${esc(t(lang, "send_to"))}</div>
        <button type="button" class="m-only" data-close>${esc(t(lang, "cancel"))}</button>
      </div>
    </details>` : "";

  const changedPill = redirected ? `<span class="recip-pill" title="${esc(t(lang, "recip_changed_title"))}">${esc(t(lang, "recip_changed_pill"))}</span>` : "";

  // No confirmed recipient yet on a new-outbound item: the button becomes "Confirm recipient" and
  // opens the same popover. One place recipients are decided, in every state.
  const needsRecipient = ((isContactForm || isCompose || isRN) && !w.recipient) || fwdNeedsRecipient;

  const sendBtn = canSend
    ? `<span class="send-split">
         <button class="send send-stack" form="workform" formaction="/item/${w.id}/send" formnovalidate data-confirm="${esc(sendConfirm)}" title="${esc(t(lang, "send_reply_to"))} ${esc(sendTo)}"><span class="send-now">${esc(t(lang, "send_now"))}</span><span class="send-to">${esc(sendTo)}</span></button>
         ${recipPop}
       </span>${changedPill}`
    : w.injection_flag ? `<span class="note">${esc(t(lang, "send_disabled_inj"))}</span>`
    : needsRecipient && recipPop
      ? `<span class="send-split"><span class="btn send-stack recip-needed"><span class="send-now">${esc(t(lang, "recip_confirm_btn"))}</span><span class="send-to">${esc(t(lang, "recip_none_yet"))}</span></span>${recipPop}</span>`
    : isContactForm ? `<span class="note">${esc(t(lang, w.recipient ? "cf_send_not_enabled" : "cf_confirm_first"))}</span>`
    : isRN ? `<span class="note">${esc(t(lang, w.recipient ? "cf_send_not_enabled" : "cf_confirm_first"))}</span>`
    : isCompose ? `<span class="note">${esc(t(lang, "compose_draft_only"))}</span>` : "";
  // Close the item: "Mark done" is the everyday close, so it's a visible button in the bar
  // (grouped on the right alongside the overflow, which keeps the rarer closes). Posts to the
  // same /status route as the old menu item — no route or safety change.
  const markDoneBtn = `<form method="post" action="/item/${w.id}/status"><button name="to" value="done" title="${esc(t(lang, "done_tip"))}">${esc(t(lang, "mark_done"))}</button></form>`;
  const closeMenu = `<details class="menu"><summary class="btn" title="${esc(t(lang, "more_actions"))}">&#8943;&nbsp;${esc(t(lang, "more_actions"))}</summary><div class="menu-list">
      <form method="post" action="/item/${w.id}/status"><button name="to" value="phone"><b>${esc(t(lang, "mark_phone"))}</b><span>${esc(t(lang, "phone_tip"))}</span></button></form>
      <form method="post" action="/item/${w.id}/status"><button name="to" value="archived"><b>${esc(t(lang, "archive"))}</b><span>${esc(t(lang, "archive_tip"))}</span></button></form>
      ${!isCompose ? `<form method="get" action="/item/${w.id}/block"><button><b>${esc(t(lang, "block_sender"))}</b><span>${esc(t(lang, require("../outlook-block.js").active() ? "block_tip_outlook" : "block_tip"))}</span></button></form>` : ""}
      <div class="sheet-title m-only">${esc(t(lang, "more_actions"))}</div>
      <button type="button" class="m-only" data-close>${esc(t(lang, "cancel"))}</button>
    </div></details>`;
  // Bar: left cluster works the reply (Send / Save / Save & redraft — the redraft note is now the
  // button's tooltip, so the bar no longer wraps on it); right cluster closes the item.
  const actionBar = busy ? "" : ["done", "archived"].includes(w.status)
    ? `<div class="actionbar"><form method="post" action="/item/${w.id}/status"><button name="to" value="reopen">${esc(t(lang, "reopen"))}</button></form></div>`
    : `<div class="actionbar">
        ${sendBtn}
        <button form="workform" name="action" value="save">${esc(t(lang, "save"))}</button>
        <button form="workform" class="primary" name="action" value="redraft" title="${esc(t(lang, "redraft_hint"))}">${esc(t(lang, "save_redraft"))}</button>
        <span class="spacer"></span>
        ${markDoneBtn}
        ${closeMenu}
      </div>`;

  // Compose items have no inbound email: show the trusted instruction, the resolved customer, and
  // the code-held confirmed recipient instead of the "Customer email" box. compose_customer carries
  // NO address (the recipient lives only in w.recipient), so nothing the model produced is shown here.
  // Step 1: the outbound-language control is the language CHIP now (same /language route);
  // the attach-SAP-document form lives in the combined "SAP documents" card.
  let cc = null;
  if (isCompose) { try { cc = JSON.parse(w.compose_customer || "null"); } catch (e) { cc = null; } }
  const custWho = cc
    ? (cc.name && cc.contactName && cc.contactName !== cc.name ? `${cc.name} (${cc.contactName})` : (cc.name || cc.contactName || ""))
    : "";
  const custBits = cc ? [
    custWho, cc.cardCode || "", cc.country || "",
    cc.knownAccount === false ? t(lang, "compose_guest") : "",
    cc.frozen ? t(lang, "compose_frozen") : "",
  ].filter(Boolean).map(esc).join(" &middot; ") : "";
  const custNotes = cc && Array.isArray(cc.notes) && cc.notes.length
    ? `<ul class="muted" style="margin:6px 0 0">${cc.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : "";
  const composeHeader = `
    <div class="box">
      <div class="boxhead"><h3>${esc(t(lang, "compose_customer_label"))}</h3></div>
      <p><b>${esc(t(lang, "compose_to"))}:</b> ${esc(w.recipient || w.sender_email || "")}</p>
      ${custBits ? `<p class="muted">${custBits}</p>` : ""}
      ${custNotes}
    </div>
    <div class="box">
      <div class="boxhead"><h3>${esc(t(lang, "compose_your_instruction"))}</h3></div>
      <pre class="mail">${esc(w.compose_instruction || "")}</pre>
      ${!ACTION_COMPOSE_SEND ? `<p class="muted trnote" style="margin:8px 0 0">${esc(t(lang, "compose_draft_only"))}</p>` : ""}
    </div>`;

  // Contact-form items: the real customer is in the body, not the sender. Show the parsed
  // customer and a confirmed-recipient picker over the DETERMINISTIC candidate set (form-typed
  // address first, SAP/Shopify addresses pickable). The chosen address is code-held in
  // w.recipient only after a human confirms it AND it passes pickRecipient at the route; nothing
  // here is model-derived. Send stays off until allow-list action #4. (cf parsed earlier.)
  let contactFormHeader = "";
  if (isContactForm) {
    const p = (cf && cf.parsed) || {};
    const rv = (cf && cf.resolved) || {};
    const cands = (cf && cf.candidateAddresses) || [];
    const who = [
      p.name || rv.name || "",
      rv.matched && rv.cardCode ? rv.cardCode : "",
      p.countryCode || rv.country || "",
      rv.frozen ? t(lang, "compose_frozen") : "",
    ].filter(Boolean).map(esc).join(" &middot; ");
    const matchLine = rv.matched
      ? `<p class="muted">${esc(t(lang, "cf_matched"))}${rv.name ? ` — ${esc(rv.name)}` : ""}</p>`
      : `<p class="muted">${esc(t(lang, "cf_not_matched"))}</p>`;
    const orderLine = p.orderRef ? `<p class="muted">${esc(t(lang, "cf_order"))}: ${esc(p.orderRef)}</p>` : "";
    const phoneLine = p.phone ? `<p class="muted">&#128222; ${esc(p.phone)}</p>` : "";
    // The radio picker that used to live here moved into the Send button's recipient popover
    // (2026-07-10) — one recipient control, in the one place guaranteed to be on screen when the
    // salesperson sends. This card keeps the customer identity and match lines; the To line is now
    // a read-only display of the code-held recipient.
    const toState = w.recipient
      ? `<p><b>${esc(t(lang, "compose_to"))}:</b> ${esc(w.recipient)} <span class="chip s-ready">&#10003; ${esc(t(lang, "cf_to_confirmed"))}</span></p>`
      : (cands.length ? `<p class="muted">${esc(t(lang, "recip_confirm_hint"))}</p>` : `<p class="muted">${esc(t(lang, "cf_no_address"))}</p>`);
    contactFormHeader = `
      <div class="box">
        <div class="boxhead"><h3>${esc(t(lang, "cf_customer_label"))}</h3></div>
        ${who ? `<p>${who}</p>` : ""}
        ${matchLine}${orderLine}${phoneLine}
        ${toState}
      </div>`;
  }

  // Return-notification items: the Shopify "Return items" mailer's sender is our own info@, so the
  // real recipient is the order's customer — resolved deterministically at ingest and code-held in
  // w.recipient (auto-set when a single address, else pickable here). Mirrors the contact-form header;
  // nothing here is model-derived. Send stays off until allow-list action AXLE_ACTION_RETURN_SEND.
  let returnHeader = "";
  if (isRN) {
    const p = (rn && rn.parsed) || {};
    const rv = (rn && rn.resolved) || {};
    const cands = (rn && rn.candidateAddresses) || [];
    const who = [
      rv.name || p.name || "",
      rv.matched && rv.cardCode ? rv.cardCode : "",
      rv.country || "",
      rv.frozen ? t(lang, "compose_frozen") : "",
    ].filter(Boolean).map(esc).join(" &middot; ");
    const matchLine = rv.matched
      ? `<p class="muted">${esc(t(lang, "cf_matched"))}${rv.name ? ` — ${esc(rv.name)}` : ""}</p>`
      : `<p class="muted">${esc(t(lang, "cf_not_matched"))}</p>`;
    const orderLine = p.orderRef ? `<p class="muted">${esc(t(lang, "cf_order"))}: ${esc(p.orderRef)}</p>` : "";
    // Radio picker moved into the Send button's recipient popover (2026-07-10), as above.
    const toState = w.recipient
      ? `<p><b>${esc(t(lang, "compose_to"))}:</b> ${esc(w.recipient)} <span class="chip s-ready">&#10003; ${esc(t(lang, "cf_to_confirmed"))}</span></p>`
      : (cands.length ? `<p class="muted">${esc(t(lang, "recip_confirm_hint"))}</p>` : `<p class="muted">${esc(t(lang, "cf_no_address"))}</p>`);
    returnHeader = `
      <div class="box">
        <div class="boxhead"><h3>${esc(t(lang, "cf_customer_label"))}</h3></div>
        ${who ? `<p>${who}</p>` : ""}
        ${matchLine}${orderLine}
        ${toState}
      </div>`;
  }

  // --- Step 2: three-pane split. The CENTRE pane is the conversation + reply
  // (everything the salesperson reads, answers and edits); the CONTEXT pane holds
  // the SAP-documents card + the investigation brief — the right pane's contents
  // until Step 3 builds the full context panel (F10). Markup inside each block is
  // unchanged from Step 1; only the placement moved.
  const center = `
    <p class="backrow"><a href="&#47;">${esc(t(lang, "back_inbox"))}</a></p>
    <h2>#${w.id} ${esc(w.subject || t(lang, "no_subject"))}</h2>
    <div class="chips-row">${chips}</div>
    ${isCompose
      ? `<p class="muted">${esc(t(lang, "compose_from"))}: ${esc(w.mailbox)}@ &middot; ${esc(fmtDateTime(w.created_at, lang))}</p>`
      : `<p class="muted">${esc(t(lang, "from"))} ${esc(w.sender_name || w.sender_email)}${w.sender_name ? ` (${esc(w.sender_email)})` : ""} &middot; ${esc(fmtDateTime(w.email_received, lang))} &middot; ${esc(w.mailbox)}@</p>`}
    ${w.caller_info ? `<p class="muted">&#128222; ${esc(w.caller_info)}</p>` : ""}
    ${busy ? `<div class="banner busy">${esc(t(lang, "investigating_banner"))}</div>` : ""}

    ${isCompose ? composeHeader : (isContactForm ? contactFormHeader : isRN ? returnHeader : "") + `<div class="box">
      <div class="boxhead"><h3>${esc(t(lang, "customer_email"))}</h3>
        <span><input id="mq" type="search" placeholder="${esc(t(lang, "search_in_email"))}" autocomplete="off"><span class="qcount" id="mqcount"></span></span></div>
      <div id="mailwrap">${renderTimeline(w, lang, emailTr, emailTrPending)}${renderAttachments(w)}</div>
    </div>`}
    <script>
    (function () {
      var mq = document.getElementById("mq"), c = document.getElementById("mqcount"),
          wrap = document.getElementById("mailwrap");
      if (!mq || !c || !wrap) return;   // compose items have no inbound-email search box - nothing to wire
      function clearMarks() {
        wrap.querySelectorAll("mark.hit").forEach(function (m) {
          var p = m.parentNode;
          p.replaceChild(document.createTextNode(m.textContent), m);
          p.normalize();
        });
      }
      function markAll(v) {
        var n = 0, texts = [],
            walker = document.createTreeWalker(wrap, NodeFilter.SHOW_TEXT, null);
        while (walker.nextNode()) texts.push(walker.currentNode);
        texts.forEach(function (t) {
          var s = t.nodeValue, l = s.toLowerCase(), i = l.indexOf(v);
          if (i < 0) return;
          var frag = document.createDocumentFragment(), pos = 0;
          while (i >= 0) {
            frag.appendChild(document.createTextNode(s.slice(pos, i)));
            var m = document.createElement("mark");
            m.className = "hit";
            m.textContent = s.slice(i, i + v.length);
            frag.appendChild(m);
            pos = i + v.length;
            i = l.indexOf(v, pos);
            n++;
          }
          frag.appendChild(document.createTextNode(s.slice(pos)));
          t.parentNode.replaceChild(frag, t);
        });
        return n;
      }
      mq.addEventListener("input", function () {
        clearMarks();
        var v = mq.value.trim().toLowerCase();
        if (v.length < 2) { c.textContent = ""; return; }
        var n = markAll(v);
        wrap.querySelectorAll("details").forEach(function (d) {
          if (d.querySelector("mark.hit")) d.open = true;
        });
        c.textContent = n + " " + (n === 1 ? "${t(lang, "match")}" : "${t(lang, "matches")}");
        var first = wrap.querySelector("mark.hit");
        if (first) first.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    })();
    </script>

    ${busy && !full && !interim ? `<div class="box"><span class="muted">${esc(t(lang, "no_draft_busy"))}</span></div>` : ""}
    ${workSection}
    ${supersededCard}
    ${actionBar}
    <script>
    // Reset the editable reply to the original AI draft (the hidden, name-less seed).
    function resetReply() {
      var s = document.getElementById("ai_seed"), r = document.getElementById("replybox");
      if (s && r && confirm(${JSON.stringify(t(lang, "reset_ai_confirm"))})) { r.value = s.value; r.focus(); }
    }
    // Per-message translation toggle on the newest inbound message (pre-rendered, cached).
    function toggleEmailTr() {
      var el = document.getElementById("emailtr"), b = document.getElementById("emailtrbtn");
      if (!el || !b) return;
      var show = el.style.display === "none";
      el.style.display = show ? "block" : "none";
      b.textContent = show ? ${JSON.stringify(t(lang, "hide_translation"))} : ${JSON.stringify(t(lang, "show_translation"))};
    }
    // On-demand translation of the CURRENT (possibly edited) reply - now a toggle.
    function translateReply() {
      var r = document.getElementById("replybox"), out = document.getElementById("replytr"), btn = document.getElementById("replytrbtn");
      if (!r || !out) return;
      if (out.style.display !== "none") {
        out.style.display = "none";
        if (btn) btn.textContent = ${JSON.stringify(t(lang, "show_translation"))};
        return;
      }
      var b = out.querySelector(".trbody");
      out.style.display = "block";
      if (btn) btn.textContent = ${JSON.stringify(t(lang, "hide_translation"))};
      b.textContent = ${JSON.stringify(t(lang, "translating"))};
      fetch("/item/${w.id}/translate-reply", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "text=" + encodeURIComponent(r.value) })
        .then(function (x) { return x.json(); })
        .then(function (d) { b.textContent = d.text || d.error || ""; })
        .catch(function () { b.textContent = "(error)"; });
    }
    // Insert text at the caret of a textarea (used for [image:N] inline tokens).
    function insAt(ta, txt) {
      var s = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
      var e = ta.selectionEnd == null ? s : ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + txt + ta.value.slice(e);
      ta.selectionStart = ta.selectionEnd = s + txt.length;
      ta.focus();
    }
    // "Insert in text" button on an image attachment row: place its inline token at the caret.
    function insImg(id) {
      var ta = document.getElementById("replybox");
      if (ta) insAt(ta, "[image:" + id + "]");
    }
    (function () {
      var form = document.getElementById("workform");
      if (!form) return;
      var MAX = ${MAX_ATTACH_BYTES};
      // Add one or more files (picker, drag-drop or paste) via AJAX, persisting the current
      // form inputs first, then reload once all are stored. When tokenTa is a textarea
      // (paste into the reply box), each stored IMAGE also drops its [image:id] token at the
      // caret; the token-edited reply is then persisted with one final no-file call so the
      // reload renders it back.
      function addFiles(files, tokenTa) {
        if (!files || !files.length) return;
        // Upload feedback: a spinner row under the attachment list + the top progress
        // bar (the flow ends in a reload, which replaces the page and clears both).
        var alist = document.getElementById("attlist");
        if (alist && !document.getElementById("attbusy")) {
          var bz = document.createElement("div");
          bz.id = "attbusy"; bz.className = "attbusy";
          bz.innerHTML = '<span class="spin"></span> ' + ${JSON.stringify(t(lang, "uploading"))};
          alist.parentNode.insertBefore(bz, alist.nextSibling);
        }
        document.body.classList.add("ax-nav");
        var base = new URLSearchParams(new FormData(form)); // reply, feedback, answers
        var arr = [].slice.call(files), tokensAdded = false;
        (function next(i) {
          if (i >= arr.length) {
            if (!tokensAdded) { location.reload(); return; }
            var p2 = new URLSearchParams(new FormData(form));   // now includes the tokens
            fetch("/item/${w.id}/attach-add", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: p2.toString() })
              .then(function () { location.reload(); }).catch(function () { location.reload(); });
            return;
          }
          var file = arr[i];
          if (file.size > MAX) { alert(${JSON.stringify(t(lang, "file_too_big"))}); return next(i + 1); }
          var rd = new FileReader();
          rd.onload = function () {
            var p = new URLSearchParams(base.toString());
            p.set("name", file.name); p.set("ctype", file.type || "application/octet-stream");
            p.set("data", String(rd.result).split(",")[1] || "");
            fetch("/item/${w.id}/attach-add", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: p.toString() })
              .then(function (x) { return x.json(); })
              .then(function (d) {
                if (d && d.error) { alert(d.error); }
                else if (tokenTa && d && d.id && /^image\\//i.test(file.type || "")) { insAt(tokenTa, "[image:" + d.id + "]"); tokensAdded = true; }
                next(i + 1);
              })
              .catch(function () { alert(${JSON.stringify(t(lang, "attach_failed"))}); next(i + 1); });
          };
          rd.readAsDataURL(file);
        })(0);
      }
      var picker = document.getElementById("att_file");
      if (picker) picker.addEventListener("change", function () { addFiles(this.files); this.value = ""; });
      var zone = document.getElementById("attzone");
      if (zone) {
        ["dragenter", "dragover"].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add("drag"); }); });
        zone.addEventListener("dragleave", function (e) { if (e.target === zone) zone.classList.remove("drag"); });
        zone.addEventListener("drop", function (e) { e.preventDefault(); zone.classList.remove("drag"); addFiles(e.dataTransfer.files); });
      }
      // Document-level paste/drag guards are installed ONCE per browser page and
      // always act through the freshest render: htmx swaps the work panes in place
      // (Step 2), so a per-render registration would stack stale closures posting
      // to a previously-open item. window.__axAddFiles is re-pointed every render;
      // the singleton handlers resolve the drop zone at event time.
      window.__axAddFiles = addFiles;
      if (!window.__axDocWired) {
        window.__axDocWired = 1;
        // Stop the browser navigating away if a file is dropped outside the zone.
        ["dragover", "drop"].forEach(function (ev) { document.addEventListener(ev, function (e) { e.preventDefault(); }, false); });
        // Paste-to-attach: a screenshot snipped to the clipboard (Win+Shift+S) is attached with
        // a single Ctrl+V - no save-to-file step. Pasted into the reply box, it also places its
        // inline [image:N] token at the caret. A paste that carries TEXT into a text field is
        // left alone (e.g. an Excel range copies both text and a picture - the text wins).
        document.addEventListener("paste", function (e) {
          function extOf(type) { var m = /^image\\/(png|jpe?g|gif|webp)/i.exec(type || ""); return m ? m[1].replace("jpeg", "jpg") : "png"; }
          if (!document.getElementById("attzone") || !e.clipboardData || !window.__axAddFiles) return;
          var items = e.clipboardData.items || [], imgs = [];
          for (var i = 0; i < items.length; i++) {
            if (items[i].kind === "file" && /^image\\//i.test(items[i].type)) { var f = items[i].getAsFile(); if (f) imgs.push(f); }
          }
          if (!imgs.length) return;
          var tg = e.target, inField = tg && (tg.tagName === "TEXTAREA" || tg.tagName === "INPUT");
          if (inField && (e.clipboardData.getData("text/plain") || "").length) return;
          e.preventDefault();
          var stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
          var renamed = imgs.map(function (f, i2) {
            return new File([f], "snippet-" + stamp + (imgs.length > 1 ? "-" + (i2 + 1) : "") + "." + extOf(f.type), { type: f.type || "image/png" });
          });
          window.__axAddFiles(renamed, (tg && tg.id === "replybox") ? tg : null);
        });
      }
    })();
    // Background translation fill (UX round): the page rendered instantly; anything
    // uncached (email translation panel, question texts) is fetched once here and
    // filled via textContent (escaped by construction). Server-cached, so the next
    // view renders it inline with no fetch at all.
    (function () {
      var pre = document.getElementById("emailtrpre");
      var emailPending = pre && pre.hasAttribute("data-pending");
      var qPend = document.querySelectorAll("[data-trq]");
      if (!emailPending && !qPend.length) return;
      fetch("/item/${w.id}/translations", { method: "POST" })
        .then(function (x) { return x.json(); })
        .then(function (d) {
          if (emailPending) {
            if (d.email) { pre.textContent = d.email; pre.removeAttribute("data-pending"); }
            else {
              // Translation unavailable (degraded) - hide the toggle rather than show an error.
              var box = document.getElementById("emailtr"), btn = document.getElementById("emailtrbtn");
              if (box) box.style.display = "none";
              if (btn) btn.style.display = "none";
            }
          }
          qPend.forEach(function (el) {
            var v = d.questions && d.questions[el.getAttribute("data-trq")];
            if (v) el.textContent = v;
          });
        })
        .catch(function () {
          if (emailPending) pre.textContent = "(error)";   // English original stays above it
        });
    })();
    </script>`;

  const context = `
    ${custHtml}
    ${sapDocsCard}
    <div class="box"><details><summary>${esc(t(lang, "what_checked"))}</summary><pre class="mail">${esc(w.brief_md || t(lang, "none_paren"))}</pre></details></div>`;
  const panes = workPanes(center, context, { back: t(lang, "back_inbox") });

  // htmx queue-card click: swap only the work panes (the queue stays put). While
  // the item is busy, a small self-poller re-swaps the panes every 10s — a
  // fragment cannot carry the <meta> refresh, and a busy item renders no edit
  // surface, so the swap can never lose typed work.
  // Busy self-poller: used by BOTH branches now. The full-shell render previously used a
  // <meta> refresh instead — but a declarative refresh navigates to the document's address
  // as parsed, so after an htmx card-click had pushed a different URL it yanked the user
  // away from what they were reading. The htmx poller targets #workpane only.
  const busyPoll = busy ? `<div hx-get="/item/${w.id}" hx-target="#workpane" hx-swap="innerHTML" hx-trigger="load delay:10s"></div>` : "";
  if (req.get("HX-Request")) {
    return res.send(panes
      + `<script>document.title = ${JSON.stringify(`Item ${w.id} - Axle`)};</script>`
      + busyPoll);
  }
  // Plain navigation (deep link / old link): the full shell. The queue pane is
  // lazy-loaded from /queue, so this route keeps exactly its old side effects —
  // and without JS the item still renders standalone, back-link included.
  res.send(page(`Item ${w.id}`, req.user, shell(lazyQueue(lang, "sel=" + w.id), panes + busyPoll), 0, { shell: true }));
});

// Open an attachment: fetched from Graph on demand, streamed to the browser.
// Untrusted content rules: PDFs/images render inline; everything else (incl.
// HTML/SVG, which can carry active content) is forced to download; nosniff always.
app.get("/item/:id/attachment/:idx", async (req, res) => {
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(req.user.lang, "not_found"))}</p>`));
  let atts = [];
  try { atts = JSON.parse(w.attachments_json || "[]"); } catch (e) { /* ignore */ }
  const a = atts[parseInt(req.params.idx, 10)];
  if (!a) return res.status(404).send(page("Not found", req.user, "<p>No such attachment on this item.</p>"));
  try {
    const file = await C.getAttachment(MAILBOX_OF[w.mailbox], w.latest_message_id, a.id);
    audit(req.user.tailscale_login, "open_attachment", w.id, `${a.name} (${fmtSize(file.size)})`);
    const ct = String(file.contentType || "application/octet-stream").split(";")[0].trim().toLowerCase();
    const inlineOk = ct === "application/pdf" || /^image\/(png|jpe?g|gif|webp)$/.test(ct);
    const fname = String(file.name || a.name || "attachment").replace(/[^\w. ()\[\]-]/g, "_");
    res.set({
      "Content-Type": inlineOk ? ct : "application/octet-stream",
      "Content-Disposition": `${inlineOk ? "inline" : "attachment"}; filename="${fname}"`,
      "X-Content-Type-Options": "nosniff",
    });
    res.send(Buffer.from(file.contentBytes, "base64"));
  } catch (e) {
    audit(req.user.tailscale_login, "attachment_error", w.id, e.message.slice(0, 200));
    res.status(502).send(page("Error", req.user, `<p>Could not fetch attachment: ${esc(e.message)}</p><p class="muted">It may have expired or the email may have been moved.</p>`));
  }
});

// Save reply/feedback/answers; add/remove an attachment; optionally kick off a redraft.
app.post("/item/:id/work", (req, res) => {
  const lang = req.user.lang;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(lang, "not_found"))}</p>`));

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
  res.redirect("/item/" + w.id);
});

// Change an item's language.
//  - Compose item: this is the OUTBOUND draft language the salesperson chose, so re-draft in it
//    (reuses the redraft loop, which already honours w.language).
//  - Inbound item: this CORRECTS the detected customer language when Axle got it wrong (e.g. an
//    image-only reply mis-tagged EN). It only re-tags the item — fixing the translation panel and
//    the language chip — and does NOT re-draft, since the reply already follows the customer's own
//    email. A fresh draft remains one click away via "Save & redraft".
app.post("/item/:id/language", (req, res) => {
  const lang = req.user.lang;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(lang, "not_found"))}</p>`));
  const newLang = ["en", "nl", "de", "fr", "es"].includes(req.body.language) ? req.body.language : null;
  if (!newLang || newLang === w.language) return res.redirect("/item/" + w.id);

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
  res.redirect("/item/" + w.id);
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
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(req.user.lang, "not_found"))}</p>`));
  const to = String(req.body.owner || "");
  const allowed = ownerChoices(w.mailbox).includes(to) && to !== (w.owner || "") && !["done", "archived"].includes(w.status);
  if (!allowed) return res.redirect("/item/" + w.id);

  const relabel = () => {
    db.prepare("UPDATE work_items SET owner = ?, updated_at = datetime('now') WHERE id = ?").run(to, w.id);
    audit(login, "owner_changed", w.id, `${ownerLabel(w)} -> ${to}`);
  };

  const target = FG.forwardTargetFor(w.mailbox, to);
  if (!target) { relabel(); return res.redirect("/item/" + w.id); }

  if (!ACTION_OWNER_FORWARD) {
    relabel();
    audit(login, "owner_forward_skipped", w.id, `${to} <${target.address}> - AXLE_ACTION_OWNER_FORWARD not enabled`);
    return res.redirect("/item/" + w.id);
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
  res.redirect("/item/" + w.id);
});

// On-demand: translate the salesperson's CURRENT (possibly edited) reply into their own
// language so they can read what they're about to send. Returns JSON; cached like all
// translations. The text is treated strictly as data by the translator.
app.post("/item/:id/translate-reply", async (req, res) => {
  const text = String(req.body.text || "");
  if (!text.trim()) return res.json({ text: "" });
  try { res.json({ text: await TR.translate(anthropic, req.user.lang, text) }); }
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
app.post("/item/:id/attach-doc", async (req, res) => {
  const lang = req.user.lang;
  const login = req.user.tailscale_login;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(lang, "not_found"))}</p>`));
  const back = `<p><a href="/item/${w.id}">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`;
  const small = (html, code) => res.status(code || 200).send(page(t(lang, "attach_doc_title"), req.user,
    `<div class="box"><h3>${esc(t(lang, "attach_doc_title"))}</h3>${html}${back}</div>`));

  if (isContactFormItem(w) || isReturnNotificationItem(w)) { audit(login, "attach_doc_refused", w.id, "new-outbound item"); return small(`<p>${esc(t(lang, "attach_doc_compose_only"))}</p>`, 400); }

  const type = String(req.body.doctype || "order").toLowerCase();
  const num = String(req.body.docnum || "").trim();
  if (!SAPDOC.DOC_TYPES[type] || !num) return small(`<p>${esc(t(lang, "attach_doc_none"))}</p>`, 400);

  let resolved;
  try { resolved = await SAPDOC.resolveDocument(type, num); }
  catch (e) { audit(login, "attach_doc_error", w.id, e.message.slice(0, 180)); return small(`<p>${esc(t(lang, "attach_doc_render_failed"))}</p>`, 502); }
  if (!resolved.ok || !resolved.candidates.length) { audit(login, "attach_doc_notfound", w.id, `${type} ${num}`); return small(`<p>${esc(t(lang, "attach_doc_none"))}</p>`, 404); }

  // Choose the document: the unique match, or the candidate the human picked - validated to be IN
  // the resolver's own set (an out-of-set DocEntry is rejected, mirroring the recipient gate).
  let doc;
  const pick = parseInt(req.body.docentry, 10);
  if (resolved.candidates.length === 1) doc = resolved.candidates[0];
  else if (Number.isInteger(pick)) {
    doc = resolved.candidates.find((c) => c.docEntry === pick);
    if (!doc) { audit(login, "attach_doc_pick_rejected", w.id, `entry ${pick} not in set`); return small(`<p>${esc(t(lang, "attach_doc_none"))}</p>`, 400); }
  } else {
    const opts = resolved.candidates.map((c) => `
      <form method="post" action="/item/${w.id}/attach-doc" style="margin:4px 0">
        <input type="hidden" name="doctype" value="${esc(type)}"><input type="hidden" name="docnum" value="${esc(num)}"><input type="hidden" name="docentry" value="${c.docEntry}">
        <button class="mini">${esc(c.type)} ${esc(String(c.docNum))} &middot; ${esc(c.cardCode || "")} ${esc(c.cardName || "")} &middot; ${esc(String(c.docTotal))} ${esc(c.docCur || "")} &middot; ${esc(c.docDate ? new Date(c.docDate).toISOString().slice(0, 10) : "")}</button>
      </form>`).join("");
    return small(`<p>${esc(t(lang, "attach_doc_ambiguous"))}</p>${opts}`, 200);
  }

  // Customer-scope guard: attach straight away only when the document's customer matches the
  // email's resolved customer; otherwise hold for an explicit confirm.
  // The email's customer, to scope the document against. For compose it's the resolved compose
  // customer; for an inbound reply it's the sender resolved to a SINGLE active SAP customer (else
  // "", which forces the explicit show-and-confirm below).
  let cc = null; try { cc = JSON.parse(w.compose_customer || "null"); } catch (e) { cc = null; }
  let itemCard = (cc && cc.cardCode) || "";
  let itemName = (cc && cc.name) || "";
  if (w.origin !== "compose" && !itemCard && w.sender_email) {
    try { const m = await SAPDOC.customerByEmail(w.sender_email); if (m && m.cardCode) { itemCard = m.cardCode; itemName = m.cardName || ""; } }
    catch (e) { audit(login, "attach_doc_scope_lookup_failed", w.id, e.message.slice(0, 120)); }
  }
  if ((!itemCard || itemCard !== doc.cardCode) && req.body.confirm !== "1") {
    audit(login, "attach_doc_scope_warn", w.id, `doc ${doc.cardCode || "?"} vs item ${itemCard || "?"}`);
    return small(`<p>${esc(t(lang, "attach_doc_scope_warn"))}</p>
      <p class="muted">${esc(t(lang, "attach_doc_doc_cust"))}: ${esc(doc.cardCode || "")} ${esc(doc.cardName || "")}<br>
      ${esc(t(lang, "attach_doc_email_cust"))}: ${esc(itemCard || "-")} ${esc(itemName)}</p>
      <form method="post" action="/item/${w.id}/attach-doc">
        <input type="hidden" name="doctype" value="${esc(type)}"><input type="hidden" name="docnum" value="${esc(String(doc.docNum))}"><input type="hidden" name="docentry" value="${doc.docEntry}"><input type="hidden" name="confirm" value="1">
        <button class="primary">${esc(t(lang, "attach_doc_scope_confirm"))}</button>
      </form>`, 200);
  }

  // Render (READ-ONLY) + stage in draft_attachments (capped, base64) - just like a hand-attached file.
  let r;
  try { r = await SAPDOC.renderPdf(doc.objectId, doc.docEntry); }
  catch (e) { audit(login, "attach_doc_error", w.id, e.message.slice(0, 180)); return small(`<p>${esc(t(lang, "attach_doc_render_failed"))}</p>`, 502); }
  if (!r.ok) { audit(login, "attach_doc_render_failed", w.id, String(r.error).slice(0, 180)); return small(`<p>${esc(t(lang, "attach_doc_render_failed"))}</p>`, 502); }

  const filename = SAPDOC.docTypeInfo(type).prefix + "-" + doc.docNum + ".pdf";
  const ares = addAttachment(w, { data: r.buffer.toString("base64"), name: filename, ctype: "application/pdf" }, login, lang);
  if (ares.error) return small(`<p>${esc(ares.error)}</p>`, 413);
  const override = !(itemCard && itemCard === doc.cardCode);
  audit(login, "doc_pdf_attached", w.id, `${doc.type} ${doc.docNum} DocEntry ${doc.docEntry} cust ${doc.cardCode || "?"} ${r.bytes}b${override ? " SCOPE-OVERRIDE" : ""}`);
  res.redirect("/item/" + w.id);
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
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(lang, "not_found"))}</p>`));
  const back = `<p><a href="/item/${w.id}">&larr; ${esc(t(lang, "back_inbox"))}</a></p>`;
  const small = (html, code) => res.status(code || 200).send(page(t(lang, "attach_doc_title"), req.user,
    `<div class="box"><h3>${esc(t(lang, "sugg_preview"))}</h3>${html}${back}</div>`));

  const type = String(req.query.doctype || "order").toLowerCase();
  const num = String(req.query.docnum || "").trim();
  if (!SAPDOC.DOC_TYPES[type] || !num) return small(`<p>${esc(t(lang, "attach_doc_none"))}</p>`, 400);

  let resolved;
  try { resolved = await SAPDOC.resolveDocument(type, num); }
  catch (e) { audit(login, "preview_doc_error", w.id, e.message.slice(0, 180)); return small(`<p>${esc(t(lang, "attach_doc_render_failed"))}</p>`, 502); }
  if (!resolved.ok || !resolved.candidates.length) { audit(login, "preview_doc_notfound", w.id, `${type} ${num}`); return small(`<p>${esc(t(lang, "attach_doc_none"))}</p>`, 404); }

  // Pick the document: the unique match, or the candidate whose DocEntry is in the resolver's set.
  let doc;
  const pick = parseInt(req.query.docentry, 10);
  if (resolved.candidates.length === 1) doc = resolved.candidates[0];
  else if (Number.isInteger(pick)) {
    doc = resolved.candidates.find((c) => c.docEntry === pick);
    if (!doc) { audit(login, "preview_doc_pick_rejected", w.id, `entry ${pick} not in set`); return small(`<p>${esc(t(lang, "attach_doc_none"))}</p>`, 400); }
  } else {
    audit(login, "preview_doc_ambiguous", w.id, `${type} ${num}`);
    return small(`<p>${esc(t(lang, "attach_doc_ambiguous"))}</p>`, 400);
  }

  // Scope is recorded for the audit only - preview never crosses the attach boundary, so it does
  // not block on customer scope (attach still does, via /attach-doc's scope-warn + confirm).
  let cc = null; try { cc = JSON.parse(w.compose_customer || "null"); } catch (e) { cc = null; }
  let itemCard = (cc && cc.cardCode) || "";
  if (w.origin !== "compose" && !itemCard && w.sender_email) {
    try { const m = await SAPDOC.customerByEmail(w.sender_email); if (m && m.cardCode) itemCard = m.cardCode; }
    catch (e) { /* scope note best-effort */ }
  }
  const offScope = !(itemCard && itemCard === doc.cardCode);

  let r;
  try { r = await SAPDOC.renderPdf(doc.objectId, doc.docEntry); }
  catch (e) { audit(login, "preview_doc_error", w.id, e.message.slice(0, 180)); return small(`<p>${esc(t(lang, "attach_doc_render_failed"))}</p>`, 502); }
  if (!r.ok) { audit(login, "preview_doc_render_failed", w.id, String(r.error).slice(0, 180)); return small(`<p>${esc(t(lang, "attach_doc_render_failed"))}</p>`, 502); }

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
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(req.user.lang, "not_found"))}</p>`));
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
  res.redirect(req.body.to === "reopen" ? "/item/" + w.id : "/");
});

};
