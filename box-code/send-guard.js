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
//   * exactly ONE recipient, screened as above (one To, never any CC/BCC);
//   * every URL in the body is on the domain allowlist (else the send is refused);
//   * the body is sent verbatim - the SHA-256 ties the approved text to what goes out;
//   * HTML is generated from the escaped plain text, so href always equals its visible
//     URL (no href/text mismatch) and no <img> or other tags can be injected;
//   * one send per approved draft is enforced by the caller via the sends table (UNIQUE).
const crypto = require("crypto");

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

// Strip trailing punctuation a writer might butt against a URL (".", ",", ")", etc.).
function cleanUrl(u) { return u.replace(/[).,;:!?'"]+$/, ""); }

function findUrls(text) { return (String(text || "").match(URL_RE) || []).map(cleanUrl); }
function findDisallowedUrls(text) { return findUrls(text).filter((u) => !urlAllowed(u)); }

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
const MD_OR_URL = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)<>"']+)/g;
function toSafeHtml(plainText) {
  const text = String(plainText || "");
  const bad = findDisallowedUrls(text);
  if (bad.length) throw new Error("refused: off-allowlist URL in body: " + bad.join(", "));
  let out = "", last = 0, m;
  MD_OR_URL.lastIndex = 0;
  while ((m = MD_OR_URL.exec(text)) !== null) {
    out += escapeHtml(text.slice(last, m.index));
    if (m[1] !== undefined) {                              // markdown link: m[1]=text, m[2]=url
      const url = cleanUrl(m[2]);
      if (!urlAllowed(url)) throw new Error("refused: off-allowlist URL in link: " + url);
      out += `<a href="${escapeHtml(url)}">${escapeHtml(m[1])}</a>`;
    } else {                                               // bare URL: m[3]
      const raw = m[3], url = cleanUrl(raw);
      if (!urlAllowed(url)) throw new Error("refused: off-allowlist URL in body: " + url);
      out += `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
      out += escapeHtml(raw.slice(url.length));            // any trailing punctuation we trimmed
    }
    last = m.index + m[0].length;
  }
  out += escapeHtml(text.slice(last));
  const withBreaks = out.replace(/\r?\n/g, "<br>\n");
  return `<div style="font-family:system-ui,Arial,sans-serif;font-size:14px;white-space:normal">${withBreaks}</div>`;
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
// Returns { to, subject, text, html, sha256, workItemId } or throws.
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
function assembleSend(workItem, body, stagedAtts = []) {
  if (!workItem) throw new Error("refused: no work item");
  if (workItem.injection_flag) throw new Error("refused: item is flagged as possible injection - resolve before sending");

  const to = acceptTypedRecipient(workItem.recipient || workItem.sender_email);
  if (!to) throw new Error("refused: work item has no valid recipient address to reply to");

  const text = String(body == null ? "" : body);
  if (!text.trim()) throw new Error("refused: reply body is empty");
  const bad = findDisallowedUrls(text);
  if (bad.length) throw new Error("refused: off-allowlist URL(s) in reply: " + bad.join(", "));

  // Inline tokens are resolved over OUR reply's HTML only - the quoted history is appended
  // afterwards, so customer text can never be swapped.
  const inline = applyInlineImages(toSafeHtml(text), text, stagedAtts);

  return {
    workItemId: workItem.id,
    to,                                   // single screened recipient: w.recipient, else the sender
    cc: [], bcc: [],                      // never any CC/BCC
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
// single To / no CC-BCC, every URL allowlisted, body verbatim (sha256), HTML from escaped text.
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

  const subj = String(subject == null ? "" : subject).trim().slice(0, 200);
  if (!subj) throw new Error("refused: subject is empty");

  const text = String(body == null ? "" : body);
  if (!text.trim()) throw new Error("refused: reply body is empty");
  const bad = findDisallowedUrls(text);
  if (bad.length) throw new Error("refused: off-allowlist URL(s) in reply: " + bad.join(", "));

  const inline = applyInlineImages(toSafeHtml(text), text, stagedAtts);

  return {
    workItemId: workItem.id,
    to,                       // single recipient: the code-held, human-confirmed customer address
    cc: [], bcc: [],          // never any CC/BCC
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
  escapeHtml, toSafeHtml, replySubject, quotedHistory, assembleSend,
  assembleNewOutboundSend, assembleContactFormSend,
  findImageTokens, applyInlineImages, contentIdFor,
};
