// send-guard.js - DETERMINISTIC send guardrails for Axle (Phase 5, allow-list action #1).
// Pure and model-independent: no LLM, no network. Given a work item and the approved
// draft row, it either returns a validated send payload or throws with a clear reason.
// Everything an attacker could influence (the draft text) is checked here in code, so a
// hostile email that slipped past the model still cannot send to a third party, leak a
// link, or be altered between approval and send.
//
// RECIPIENT MODEL (changed 2026-07-10, "editable send recipient"). Until this date the reply
// recipient was HARD-LOCKED to the work item's sender address. It no longer is: a salesperson
// may redirect a reply to another address (a customer's work address, a colleague at the same
// account, a corrected contact-form typo). The guarantee that replaced the hard lock is:
//
//     A HUMAN, AND ONLY A HUMAN, MAY REDIRECT A REPLY - deliberately, visibly, and in the
//     audit log. No model output, no email body, and no tool result can set the recipient.
//
// What still holds that up, in code rather than in prompt text:
//   * the To can only come from workItem.recipient (written solely by POST /item/:id/recipient,
//     from either the resolver's own address set or a human's keystrokes) or, absent that, the
//     thread's sender_email. The model has no route to either;
//   * whatever the source, the final address is re-screened HERE by acceptTypedRecipient:
//     one address, no comma/semicolon/angle-bracket/whitespace, so no multi-recipient
//     smuggling and no display-name injection can reach Graph;
//   * an injection-flagged item can NEVER send, whatever the recipient.
// The residual risk is a hostile email socially-engineering a salesperson into typing an
// address. No code stops that; the send confirm is the mitigation and the audit is detection.
//
// Invariants enforced:
//   * exactly ONE To, screened as above; no BCC ever; Cc only the addresses a human put on the item
//     (work_items.cc_json, round 2), each re-screened here at send time (itemCc);
//   * every URL in the body is on the domain allowlist (else the send is refused);
//   * the body is sent verbatim - the SHA-256 ties the approved text to what goes out;
//   * HTML is generated from the escaped plain text, so href always equals its visible
//     URL (no href/text mismatch) and no <img> or other tags can be injected;
//   * one send per approved draft is enforced by the caller via the sends table (UNIQUE).
const crypto = require("crypto");
const R = require("./rules.js");             // our three mailbox addresses (rules.js reads env lazily, no IO)
const FMT = require("./reply-format.js");   // the formatting markers (**bold**, *italic*, __underline__, "- " lists)

// Domain allowlist for any URL allowed to appear in an outgoing reply. Kept in sync with
// engine.js URL_ALLOW by intent; duplicated deliberately so the send path has its own
// independent check (defence in depth). roverparts.eu = webshop/product pages,
// budget-parts.nl = company, the rest = MyParcel + carrier tracking.
const URL_ALLOW = [
  "roverparts.eu", "budget-parts.nl", "myparcel.nl", "sendmyparcel.me", "myparcel.me",
  "postnl.nl", "dhlparcel.nl", "dhl.com", "dpd.com", "gls-group.com",
  "ups.com",   // live MyParcel tracking links use www.ups.com (verified 2026-06-10)
];
function hostAllowed(h) { h = (h || "").toLowerCase(); return URL_ALLOW.some((d) => h === d || h.endsWith("." + d)); }
function urlAllowed(u) { try { return hostAllowed(new URL(u).host); } catch { return false; } }

const URL_RE = /https?:\/\/[^\s)<>"']+/gi;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- recipient screening -------------------------------------------------------------------
// The single gate every outbound To passes through, whether it came from the resolver's address
// set, a human's typing, or the inbound thread's sender. Returns the clean address, or "" - it
// never throws and never "fixes up" a bad address.
//
// The character screen is the load-bearing part. EMAIL_RE alone is not enough: "a@b.nl,cd.nl"
// satisfies it (one @, no whitespace) and would hand Graph a header it may read as two
// recipients. So , ; < > and any internal whitespace are rejected outright. That kills
// multi-recipient smuggling ("jan@dekker4x4.nl, attacker@evil.com") and display-name injection
// ("Jan <attacker@evil.com>") at the only place it matters - just before the send.
//
// Leading/trailing whitespace is TRIMMED, not rejected: a pasted address routinely carries it,
// and once trimmed it is exactly the address the human meant. Internal whitespace is still fatal.
// 254 chars is the RFC 5321 maximum for a forward-path address.
const ADDR_FORBIDDEN_RE = /[,;<>\s]/;
const MAX_ADDR_LEN = 254;
function acceptTypedRecipient(addr) {
  const a = String(addr == null ? "" : addr).trim();
  if (!a || a.length > MAX_ADDR_LEN) return "";
  if (ADDR_FORBIDDEN_RE.test(a)) return "";
  const lower = a.toLowerCase();
  return EMAIL_RE.test(lower) ? lower : "";
}

// ---- Cc (round 2, request 8) ------------------------------------------------------------------
// The Cc a human put on the item (work_items.cc_json, written only by POST /item/:id/cc through
// cc-list.js), screened again here at send time. Nothing is dropped silently: an address that no
// longer passes the screen, equals the To, is on our own domains (other than the internal copies
// below), a duplicate, or a list over the cap refuses the send with the reason, so the salesperson
// fixes the Cc and sends again.
// Our own domains: the same list as outlook-block.js OUR_DOMAINS, kept here as well (like URL_ALLOW)
// so this pure module needs no database and the send path has its own check.
// Internal copies (round 3): our three mailboxes (info@, drachten@, admin@: rules.js
// ourMailboxAddresses, env with fallbacks) may be copied, except the one the reply is sent from.
const OWN_DOMAINS = ["budget-parts.nl", "roverparts.eu"];
const MAX_CC = 5;
// The domain is compared without trailing dots ("x@budget-parts.nl." is ours too).
function isOwnAddress(addr) {
  const d = (String(addr || "").trim().toLowerCase().split("@")[1] || "").replace(/\.+$/, "");
  return OWN_DOMAINS.some((x) => d === x || d.endsWith("." + x));
}
// A Cc address: the To's screen, and no domain ending in a dot ("" when refused).
const acceptCcAddress = (addr) => { const a = acceptTypedRecipient(addr); return a.endsWith(".") ? "" : a; };
// The address the item's replies are sent from ("" for a mailbox outside OWNER_HOME).
function sendingAddress(mailbox) {
  const label = Object.keys(R.OWNER_HOME).find((k) => R.OWNER_HOME[k].box === mailbox);
  return label ? R.ownerHome(label).address : "";
}
// The own-domain addresses a Cc on an item of this mailbox may hold.
const internalCc = (mailbox) => R.ourMailboxAddresses().filter((a) => a !== sendingAddress(mailbox));
function itemCc(workItem, to) {
  let list;
  try { list = JSON.parse(workItem.cc_json || "[]") ?? []; } catch (e) { list = null; }   // a stored "null" is no Cc
  if (!Array.isArray(list)) throw new Error("refused: the Cc list could not be read - remove the Cc addresses and add them again");
  const out = [];
  for (const e of list) {
    const raw = String((e && e.addr) || "").slice(0, 80);
    const a = acceptCcAddress(e && e.addr);
    if (!a) throw new Error(`refused: the Cc address ${raw} is not a valid email address - remove it from Cc`);
    if (a === to) throw new Error(`refused: the Cc address ${a} is the same as the To - remove it from Cc`);
    if (a === sendingAddress(workItem.mailbox)) throw new Error(`refused: the Cc address ${a} is the mailbox this reply is sent from - remove it from Cc`);
    if (isOwnAddress(a) && !internalCc(workItem.mailbox).includes(a)) throw new Error(`refused: the Cc address ${a} is on our own domain, and only info@, drachten@ and admin@ may be copied - remove it from Cc`);
    if (out.includes(a)) throw new Error(`refused: the Cc address ${a} is listed twice - remove one`);
    out.push(a);
  }
  if (out.length > MAX_CC) throw new Error(`refused: Cc holds more than ${MAX_CC} addresses - remove some`);
  return out;
}

// Strip trailing punctuation a writer might butt against a URL (".", ",", ")", etc.).
function cleanUrl(u) { return u.replace(/[).,;:!?'"]+$/, ""); }

function findUrls(text) { return (String(text || "").match(URL_RE) || []).map(cleanUrl); }
function findDisallowedUrls(text) { return findUrls(text).filter((u) => !urlAllowed(u)); }
// A webshop product link with no product behind it (item 2044, send 480: a draft linked
// "https://www.roverparts.eu/products/" because the handle lookup came back empty).
function findEmptyProductLinks(text) {
  return findUrls(text).filter((u) => {
    try { const x = new URL(u); return hostAllowed(x.host) && /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?products\/?$/i.test(x.pathname); }
    catch { return false; }
  });
}
function screenLinks(text) {
  const bad = findDisallowedUrls(text);
  if (bad.length) throw new Error("refused: off-allowlist URL(s) in reply: " + bad.join(", "));
  const empty = findEmptyProductLinks(text);
  if (empty.length) throw new Error("refused: a product link in the reply points to no product page - fix the link or remove it");
}

function sha256(s) { return crypto.createHash("sha256").update(String(s), "utf8").digest("hex"); }

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Convert the approved PLAIN-TEXT draft to safe HTML. We escape the whole string and only
// ever inject our own <a> and <br>, so no attacker tag (<img>, <script>, style) can survive.
// Two link forms are produced, and BOTH are safe because every URL is on the domain
// allowlist (checked here and in assembleSend):
//   * markdown links [visible text](url) -> a clean anchor whose text is the product code/
//     name. An href/text mismatch is harmless here: the href can only be one of OUR own
//     allowlisted domains, so it can never be used to disguise a link to an attacker site.
//   * bare URLs -> rendered as themselves (href === visible text).
// Throws if any off-allowlist URL is present.
// Round 2 (request 3): the stored text may carry formatting markers (**bold**, *italic*, __underline__
// (round 3), "- " list lines; grammar in reply-format.js). They become <b>, <i>, <u> and <ul><li> here, still escape-first:
// the markers are read from the plain text, never HTML from anywhere. Text without a marker gives
// exactly the HTML it gave before.
// Links, bare URLs and image tokens are found by reply-format.js tokens(), the one tokeniser the
// display and the editor use too. An image token stays text here (applyInlineImages swaps it).
function linkHtml(tok) {
  if (tok.type === "image") return escapeHtml(tok.raw);
  if (!urlAllowed(tok.url)) throw new Error(`refused: off-allowlist URL in ${tok.type === "link" ? "link" : "body"}: ` + tok.url);
  return `<a href="${escapeHtml(tok.url)}">${escapeHtml(tok.type === "link" ? tok.text : tok.url)}</a>`;
}
function toSafeHtml(plainText) {
  const text = String(plainText || "");
  const bad = findDisallowedUrls(text);
  if (bad.length) throw new Error("refused: off-allowlist URL in body: " + bad.join(", "));
  const html = FMT.emailHtml(text, { esc: escapeHtml, atom: linkHtml });
  return `<div style="font-family:system-ui,Arial,sans-serif;font-size:14px;white-space:normal">${html}</div>`;
}

function replySubject(subject) {
  const s = String(subject || "").trim();
  return /^re\s*:/i.test(s) ? s : "Re: " + (s || "(no subject)");
}

// ---- Inline snippet images ----------------------------------------------------------------
// A staged attachment can be placed INSIDE the reply with a HUMAN-typed token
// [image:<draft_attachment id>]. The swap to <img src="cid:..."> happens here in code, only
// for ids actually staged on THIS work item (the caller passes its own staged rows) and only
// for image/* content - so the model can never place an image, and a token can never reach
// another item's bytes. Validation is strict: a token with no matching staged attachment, a
// non-image target, or a token that didn't survive into the HTML intact (e.g. wrapped in a
// markdown link) REFUSES the send with a clear reason - we never leak literal placeholder
// text or a broken image to a customer. The swap runs ONLY over our own reply's HTML, never
// the quoted history, so a customer writing "[image:1]" in their email can't summon anything.
// The sha256 integrity tie stays over the raw approved text INCLUDING tokens.
const IMG_TOKEN_RE = /\[image:(\d+)\]/g;
const contentIdFor = (id) => `att${id}@axle`;   // cid scheme; send.js receives it ready-made

function findImageTokens(text) {
  const ids = []; let m;
  IMG_TOKEN_RE.lastIndex = 0;
  while ((m = IMG_TOKEN_RE.exec(String(text || ""))) !== null) ids.push(parseInt(m[1], 10));
  return ids;
}

// Validate every [image:N] in the approved text against the staged attachments, then swap
// them inside the (already escaped) reply HTML. Returns { html, inlineIds }; throws on any
// invalid token. The text-vs-html occurrence count must match exactly - a mismatch means the
// escaped token was consumed by other rendering (markdown link), so WYSIWYG is broken: refuse.
function applyInlineImages(html, text, stagedAtts) {
  const tokens = findImageTokens(text);
  if (!tokens.length) return { html, inlineIds: [] };
  const byId = new Map((stagedAtts || []).map((a) => [Number(a.id), a]));
  const inlineIds = [];
  let out = html;
  for (const id of new Set(tokens)) {
    const att = byId.get(id);
    if (!att) throw new Error(`refused: [image:${id}] does not match an attachment staged on this email - remove the token or re-add the file`);
    if (!/^image\//i.test(String(att.content_type || ""))) throw new Error(`refused: [image:${id}] (${att.name}) is not an image and cannot be placed in the text`);
    const token = `[image:${id}]`;
    const wantCount = String(text).split(token).length - 1;
    const parts = out.split(token);
    if (parts.length - 1 !== wantCount) throw new Error(`refused: [image:${id}] is wrapped in a link or otherwise malformed - place the token on its own`);
    out = parts.join(`<img src="cid:${contentIdFor(id)}" alt="${escapeHtml(String(att.name || "image"))}" style="max-width:100%">`);
    inlineIds.push(id);
  }
  return { html: out, inlineIds };
}

// Build the quoted original beneath our reply, like a normal email client. The original
// inbound (workItem.email_text) is the newest message, which already contains the earlier
// thread quoted within it - so this preserves the full conversation history. It is the
// customer's own content going back to them: we escape it (no tags survive) and render it
// as plain text in a blockquote - deliberately NOT linkified, so we never turn
// customer-supplied URLs into clickable links in our outbound mail. URL allowlisting
// applies only to OUR draft, never to the quoted history.
function quotedHistory(workItem) {
  const orig = String(workItem.email_text || "");
  if (!orig.trim()) return "";
  const who = workItem.sender_name
    ? `${workItem.sender_name} <${workItem.sender_email}>` : String(workItem.sender_email || "");
  const nl = String(workItem.language || "").toLowerCase() === "nl";
  let when = String(workItem.email_received || "");
  const d = new Date(workItem.email_received);
  if (!isNaN(d)) {
    when = d.toLocaleString(nl ? "nl-NL" : "en-GB",
      { timeZone: "Europe/Amsterdam", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  const header = nl ? `Op ${when} schreef ${who}:` : `On ${when}, ${who} wrote:`;
  const bodyHtml = escapeHtml(orig).replace(/\r?\n/g, "<br>\n");
  return `<br><br><div style="border-left:2px solid #ccc;padding-left:10px;color:#555;font-size:13px">`
    + `${escapeHtml(header)}<br><br>${bodyHtml}</div>`;
}

// Assemble and validate a send from a work item + the FINAL reply body the human approved.
// Returns { to, cc, subject, text, html, sha256, workItemId } or throws.
// The body is whatever the salesperson chose to send (AI draft, edited, or hand-written) -
// it is passed in explicitly and sent verbatim; the sha256 ties the approved text to what
// goes out. The body is validated here in code regardless of who wrote it: an injection-
// flagged item can NEVER send, the body must be non-empty, and every URL must be on the domain
// allowlist. We deliberately do NOT require a particular item status - the salesperson may send
// at any time (e.g. a holding reply while questions are still open), the one hard exception
// being a flagged item.
//
// The recipient DEFAULTS to the thread's sender - the overwhelmingly common case, and what you
// get when nobody touches the control. A human-confirmed workItem.recipient overrides it (see
// the RECIPIENT MODEL note at the top of this file). Either way the final address is screened
// by acceptTypedRecipient before it can reach Graph.
// One extra refusal, added with the handover forward (2026-08-08). An item created from an
// INTERNAL FORWARD (rule 'internal_forward' - Drachten handed a customer email to Gouda, or a
// colleague pressed Forward in Outlook) has a thread sender that is one of OUR OWN mailboxes.
// The default recipient for a reply is the thread sender, so without this the obvious click would
// send a customer-facing reply straight back to drachten@ instead of to the customer. Nothing is
// harmed by that - it is internal mail - but it is a silent non-delivery, which is worse than a
// clear refusal. So these items must have a human-confirmed recipient before they can send.
// Deliberately narrow: keyed on the rule id, so every pre-existing item behaves exactly as before.
//
// Widened 2026-10-10 (draft review): two customer replies (sends 578 and 603) went to drachten@
// because the colleague's email matched catch_all, not internal_forward, so nothing asked who the
// reply was for. Now ANY inbound reply item whose thread sender is one of our own addresses needs a
// confirmed recipient. Exempt: the Shopify return notification (sent from info@, answered on its own
// new-outbound path) and items carrying return or contact-form data. Choosing our own mailbox as the
// recipient stays possible for a genuinely internal reply; the item page then says so plainly.
const INTERNAL_FORWARD_RULE = "internal_forward";
const OWN_SENDER_EXEMPT_RULES = ["shopify_return_request"];
function needsConfirmedRecipient(workItem) {
  if (String(workItem.recipient || "").trim()) return false;
  if (String(workItem.rule_id || "") === INTERNAL_FORWARD_RULE) return true;
  if (workItem.origin && workItem.origin !== "inbound") return false;
  if (OWN_SENDER_EXEMPT_RULES.includes(String(workItem.rule_id || ""))) return false;
  if (workItem.return_json || workItem.contact_form_json) return false;
  return isOwnAddress(workItem.sender_email);
}

// A KPN voicemail item (rule 'voicemail', sender voicemail@hipservice.nl) has nobody to email: the
// thread sender is KPN's notification address, so a reply would vanish without a trace. Voicemail
// items are phone only (Change A, 2026-10-05): the send is ALWAYS refused, whatever the recipient,
// and the item page shows a call-back notice instead of a Send button.
const VOICEMAIL_RULE = "voicemail";
const VOICEMAIL_SENDER = "voicemail@hipservice.nl";
function isVoicemailItem(workItem) {
  return String(workItem.rule_id || "") === VOICEMAIL_RULE
    || String(workItem.sender_email || "").trim().toLowerCase() === VOICEMAIL_SENDER;
}

function assembleSend(workItem, body, stagedAtts = []) {
  if (!workItem) throw new Error("refused: no work item");
  if (workItem.injection_flag) throw new Error("refused: item is flagged as possible injection - resolve before sending");
  if (isVoicemailItem(workItem)) {
    throw new Error("refused: this is a voicemail, so there is nobody to email. Call the customer back and close the item as handled by phone.");
  }
  if (needsConfirmedRecipient(workItem)) {
    throw new Error("refused: this email was forwarded to us internally, so replying to the sender would reply to our own mailbox - confirm the customer's address first");
  }

  const to = acceptTypedRecipient(workItem.recipient || workItem.sender_email);
  if (!to) throw new Error("refused: work item has no valid recipient address to reply to");
  const cc = itemCc(workItem, to);

  const text = String(body == null ? "" : body);
  if (!text.trim()) throw new Error("refused: reply body is empty");
  screenLinks(text);

  // Inline tokens are resolved over OUR reply's HTML only - the quoted history is appended
  // afterwards, so customer text can never be swapped.
  const inline = applyInlineImages(toSafeHtml(text), text, stagedAtts);

  return {
    workItemId: workItem.id,
    to,                                   // single screened recipient: w.recipient, else the sender
    cc, bcc: [],                          // the item's Cc, re-screened (itemCc); never any BCC
    subject: replySubject(workItem.subject),
    text,                                              // verbatim plain text (our reply, tokens included)
    html: inline.html + quotedHistory(workItem),       // our reply (tokens -> cid imgs) + quoted thread
    inlineIds: inline.inlineIds,                       // staged-attachment ids to send as inline cids
    sha256: sha256(text),                              // integrity tie over OUR reply only
  };
}

// New-outbound send - used for BOTH allow-list action #4 (contact-form replies) and action #3
// (composed emails). Unlike assembleSend (an in-thread reply hard-locked to the inbound sender),
// this sends a FRESH email to the CODE-HELD, human-confirmed recipient (workItem.recipient) - set
// only by the deterministic resolver + pickRecipient at the route, never by the model, the email
// body, or any inbound "sender". Same deterministic guarantees: a flagged item can never send,
// single To / only the human-set Cc / no BCC, every URL allowlisted, body verbatim (sha256), HTML from escaped text.
// There is NO quoted history (a composed email and a Shopify-mailer notification are both things we
// must never quote back to the customer). The subject is the human-approved one (fresh, not "Re:").
function assembleNewOutboundSend(workItem, body, subject, stagedAtts = []) {
  if (!workItem) throw new Error("refused: no work item");
  if (workItem.injection_flag) throw new Error("refused: item is flagged as possible injection - resolve before sending");

  // Recipient is the code-held, human-confirmed address (set only via POST /item/:id/recipient,
  // from the resolver's set or a human's typing) - never the Shopify-mailer sender, never
  // anything the model or the email body produced. There is no sender fallback here: a new
  // outbound with no confirmed recipient must refuse rather than guess.
  const to = acceptTypedRecipient(workItem.recipient);
  if (!to) throw new Error("refused: no confirmed recipient - confirm the recipient first");
  const cc = itemCc(workItem, to);

  const subj = String(subject == null ? "" : subject).trim().slice(0, 200);
  if (!subj) throw new Error("refused: subject is empty");

  const text = String(body == null ? "" : body);
  if (!text.trim()) throw new Error("refused: reply body is empty");
  screenLinks(text);

  const inline = applyInlineImages(toSafeHtml(text), text, stagedAtts);

  return {
    workItemId: workItem.id,
    to,                       // single recipient: the code-held, human-confirmed customer address
    cc, bcc: [],              // the item's Cc, re-screened (itemCc); never any BCC
    subject: subj,            // fresh, human-approved subject (NOT "Re:")
    text,                     // verbatim plain text (our reply, tokens included)
    html: inline.html,        // our reply only (tokens -> cid imgs); NO quoted history
    inlineIds: inline.inlineIds,
    sha256: sha256(text),     // integrity tie over our reply
  };
}

// Back-compat alias: assembleContactFormSend === the generalised new-outbound assembler.
const assembleContactFormSend = assembleNewOutboundSend;

module.exports = {
  URL_ALLOW, urlAllowed, findUrls, findDisallowedUrls, sha256, acceptTypedRecipient,
  escapeHtml, toSafeHtml, replySubject, quotedHistory, assembleSend, needsConfirmedRecipient, isVoicemailItem,
  MAX_CC, isOwnAddress, acceptCcAddress, sendingAddress, internalCc, itemCc,
  assembleNewOutboundSend, assembleContactFormSend,
  findImageTokens, applyInlineImages, contentIdFor, findEmptyProductLinks,
};
