"use strict";
// contact-form-parser.js
// ---------------------------------------------------------------------------------------
// Deterministic parser for Shopify webshop contact-form notification emails (the ones that
// land in info@'s "Shopify Contact Form" folder, from mailer@shopify.com). It turns the
// structured form body into { countryCode, name, email, phone, message, orderRef }.
//
// SECURITY (the whole point of this module):
//   * This is PURE, DETERMINISTIC label-matching. It NEVER interprets the body as
//     instructions and never calls a model. The free-text Message is captured as data only.
//   * The `email` it returns is a *candidate recipient* only. It is NOT a send target.
//     The recipient is still gated downstream by resolve-customer.pickRecipient + explicit
//     human confirmation (recipient code-held, SHA-tied) before any outbound send. A parsed
//     address that does not pass that gate can never become a To.
//
// The Shopify template is dead-stable. In HTML each field is:
//     <div class="form-section"><b>LABEL:</b> <pre ...>VALUE</pre></div>
// and the "You can enable spam filtering..." footer lives in a separate <h2> OUTSIDE any
// <pre>, so the HTML-structural parse below excludes it for free. The text rendering
// (Exchange-converted) is "LABEL:\n\nVALUE\n\n..."; the text fallback handles that shape.
//
// Labels actually emitted by Shopify (verified against real info@ samples):
//   EN template:  Country Code | Name | Email | Phone | Message
//   NL template:  Landcode     | Name | E-mail | Phone | Message   (only Landcode/E-mail differ)

// label literal (lower-cased, trimmed) -> canonical field
const LABEL_TO_FIELD = {
  "country code": "countryCode",
  "landcode": "countryCode",
  "name": "name",
  "email": "email",
  "e-mail": "email",
  "phone": "phone",
  "message": "message",
};

// Footer sentinels Shopify appends after the message (English even on NL templates). Used
// only by the text fallback; the HTML parse never sees them inside the message <pre>.
const FOOTER_SENTINELS = [
  "You can enable spam filtering for contact forms in online store preferences.",
];

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function htmlUnescape(s) {
  return String(s == null ? "" : s)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return _; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return _; } });
}

function looksLikeHtml(s) {
  return /<\s*(?:div|pre|table|html|body|b)\b/i.test(String(s || ""));
}

// Does this body look like a Shopify contact-form notification at all? (Belt-and-braces for
// ingest; routing is already done by the rule, but a parser that self-checks is safer.)
function isContactFormBody(body) {
  const s = String(body || "");
  if (/online store's contact form|contactformulier van je webshop/i.test(s)) return true;
  // Both an address label and the message label present => almost certainly the form.
  const hasAddr = /(?:^|>|\n)\s*(?:Country Code|Landcode|E-?mail)\s*:/i.test(s);
  const hasMsg = /(?:^|>|\n)\s*Message\s*:/i.test(s);
  return hasAddr && hasMsg;
}

// ---- field normalisers ---------------------------------------------------------------
function normCountry(v) {
  const c = String(v || "").trim().toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : null;
}
function normName(v) {
  const n = String(v || "").replace(/\s+/g, " ").trim();
  return n ? n.slice(0, 200) : null;
}
function normEmail(v) {
  let e = String(v || "").trim().replace(/^<|>$/g, "").trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;        // invalid => null; never a half-parsed address
}
function normPhone(v) {
  const p = String(v || "").trim();
  return p ? p.slice(0, 60) : null;
}
function stripFooter(msg) {
  let m = String(msg || "");
  for (const s of FOOTER_SENTINELS) {
    const i = m.indexOf(s);
    if (i >= 0) m = m.slice(0, i);
  }
  return m.replace(/\s+$/g, "").replace(/^\s+/g, "");
}
function extractOrderRef(message) {
  // Same #?S##### shape used by connectors.extractEntities; first occurrence wins.
  const m = String(message || "").match(/#?\s*S\d{5}\b/i);
  return m ? m[0].replace(/[#\s]/g, "").toUpperCase() : null;
}

// ---- HTML-structural parse (primary) -------------------------------------------------
// Walk every <b>LABEL:</b> <pre>VALUE</pre> pair. Robust to the inline styles Shopify adds.
function parseHtml(html) {
  const out = {};
  const re = /<b>\s*([^<:]{1,40}?)\s*:\s*<\/b>\s*<pre\b[^>]*>([\s\S]*?)<\/pre>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const field = LABEL_TO_FIELD[m[1].trim().toLowerCase()];
    if (!field || out[field] !== undefined) continue;         // unknown label or first-wins
    out[field] = htmlUnescape(m[2]).replace(/ /g, " ").trim();
  }
  return out;
}

// ---- text fallback -------------------------------------------------------------------
// Exchange-converted shape: each label on its own line, value in the following line(s),
// up to the next known label (or the footer for the message). Resilient to the inline
// "LABEL: value" shape too.
function parseText(text) {
  const t = String(text || "").replace(/\r\n?/g, "\n");
  const labelAlt = "Country Code|Landcode|Name|E-?mail|Phone|Message";
  const re = new RegExp("^[ \\t]*(" + labelAlt + ")[ \\t]*:[ \\t]*(.*)$", "gim");
  const hits = [];
  let m;
  while ((m = re.exec(t)) !== null) {
    hits.push({ label: m[1], inline: m[2] || "", from: m.index, valStart: re.lastIndex });
  }
  const out = {};
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    const field = LABEL_TO_FIELD[h.label.trim().toLowerCase()];
    if (!field || out[field] !== undefined) continue;
    const end = i + 1 < hits.length ? hits[i + 1].from : t.length;
    const block = (h.inline + "\n" + t.slice(h.valStart, end)).trim();
    out[field] = block;
  }
  return out;
}

// ---- public entry --------------------------------------------------------------------
// Returns { isContactForm, countryCode, name, email, phone, message, orderRef, templateLang, raw }.
// All fields are null when absent/invalid. `email` is a CANDIDATE only (see security note).
function parseContactForm(body) {
  const src = String(body == null ? "" : body);
  const fields = looksLikeHtml(src) ? parseHtml(src) : parseText(src);

  const countryCode = normCountry(fields.countryCode);
  const name = normName(fields.name);
  const email = normEmail(fields.email);
  const phone = normPhone(fields.phone);
  const message = stripFooter(fields.message || "");
  const orderRef = extractOrderRef(message) || extractOrderRef(src);

  // template language hint (NOT used to choose recipient; country map drives language).
  const templateLang = /(?:^|>|\n)\s*(?:Landcode|E-mail)\s*:/i.test(src) ? "nl" : "en";

  // "is contact form" if it self-identifies OR we got the structured fields we need.
  const isContactForm = isContactFormBody(src) || (email != null && message !== "");

  return {
    isContactForm,
    countryCode,
    name,
    email,                 // candidate recipient only — gated by pickRecipient + human confirm
    phone,
    message: message || null,
    orderRef,
    templateLang,
  };
}

module.exports = {
  parseContactForm,
  isContactFormBody,
  // exported for unit tests / reuse:
  parseHtml, parseText, htmlUnescape, extractOrderRef, normEmail, normCountry, normName, normPhone, stripFooter,
};
