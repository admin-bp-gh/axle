// doc-references.js - extract referenced SAP document numbers from an email (READ-ONLY, no model).
//
// The first stage of the "auto-attach relevant SAP documents" feature. Given an email's text
// (UNTRUSTED data), it returns a list of CANDIDATE document references the salesperson's email
// appears to mention - an order, invoice, quotation, delivery or credit note number.
//
// Hard safety rule (mirrors the recipient/DocEntry gates elsewhere in Axle): a number found here
// is ONLY ever a candidate to LOOK UP. It is never trusted, never attached, never acted on by
// itself. The next stage (resolve + customer-scope check against live SAP) is the real gate -
// a candidate that doesn't resolve to a real document for THIS email's customer is dropped.
// This module does pure, deterministic regex matching: it follows no instructions in the text,
// runs no model, and reaches no system. It only reads the string it is handed.
//
// Output: an array of { type, number, numberKind, basis, raw } objects, de-duplicated and capped.
//   type       - 'order' | 'invoice' | 'quotation' | 'delivery' | 'creditnote' | 'unknown'
//                ('unknown' = a bare number with no nearby keyword; the resolver will try order,
//                 then invoice, per Brad's locked type-inference rule.)
//   number     - the digits (for a DocNum) or the full Shopify name token (for numberKind 'shopify').
//   numberKind - 'docnum'  (a SAP DocNum -> resolved via ORDR/OINV/... DocNum lookup)
//                'shopify' (a Shopify order name like S17878 -> resolved via ORDR.NumAtCard)
//   basis      - 'keyword' | 'shopify' | 'bare'  (how it was found; drives confidence/ordering)
//   raw        - the matched snippet, for the audit trail / human display.

"use strict";

// Keyword -> document type. Dutch + English. Word-boundary anchored at match time. Order matters
// only for readability; each alternative is its own capture so the matched keyword is known.
// NB: 'inv'/'fact' style abbreviations are deliberately NOT matched alone - too noisy; we require
// a recognisable word so a bare "inv" inside another word can't trigger.
const KEYWORDS = [
  { type: "invoice",    words: ["invoice", "factuur", "factuurnr", "factuurnummer", "rekening", "rekeningnr"] },
  { type: "creditnote", words: ["credit note", "creditnote", "creditnota", "credit nota", "creditnotanr"] },
  { type: "quotation",  words: ["quotation", "quote", "offerte", "offertenr", "offertenummer"] },
  { type: "delivery",   words: ["delivery note", "delivery", "levering", "leveringsbon", "pakbon", "vrachtbrief"] },
  { type: "order",      words: ["order", "ordernr", "ordernummer", "bestelling", "bestelnr", "bestelnummer", "sales order", "purchase order"] },
];

// A SAP DocNum at RoverParts is a 4-7 digit integer (orders ~226xxx, invoices ~426xxx, etc.).
// Keep the band tight enough to skip years/quantities but wide enough for every live series.
const DOCNUM = "\\d{4,7}";

// Build one regex per keyword type: <keyword> [optional separators: # no. nr. : -] <docnum>.
// The number may sit up to a few separator characters after the keyword (e.g. "invoice no. 426407",
// "factuurnummer: 426407", "order #226108"). We do NOT span arbitrary words - the number must be
// adjacent so an unrelated figure later in the sentence isn't captured.
const SEP = "[\\s:#.\\-]{0,4}(?:nr\\.?|no\\.?|number|nummer)?[\\s:#.\\-]{0,4}";
function keywordRegexes() {
  const out = [];
  for (const k of KEYWORDS) {
    for (const w of k.words) {
      const ww = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
      out.push({ type: k.type, re: new RegExp("\\b" + ww + SEP + "(" + DOCNUM + ")\\b", "ig") });
    }
  }
  return out;
}
const KEYWORD_RES = keywordRegexes();

// Shopify order name: "#S17878", "S17878", "order S17878". Case-insensitive S + 4-6 digits.
// These are ORDR.NumAtCard values, not DocNums, so they carry numberKind 'shopify'.
const SHOPIFY_RE = /(?:#|\border\s+)?\bS(\d{4,6})\b/ig;

// A bare DocNum that no keyword explains. Matched only when NOT glued to a letter, a decimal
// point, a currency symbol, a percent sign or a '+' (so prices, phone numbers, VAT ids, version
// strings and quantities are skipped). The resolver still has the final say.
const BARE_RE = /(?<![\w.,+€$£%/-])(\d{5,7})(?![\w/xX×%])(?![.,]\d)/g;

// Things a 5-7 digit run is more likely to be than a DocNum - dropped at the bare stage.
function looksLikeNoise(numStr, ctxBefore, ctxAfter) {
  const n = parseInt(numStr, 10);
  if (numStr.length === 4 && n >= 1900 && n <= 2099) return true; // a year (only 4-digit; bare is 5-7 anyway)
  const before = ctxBefore.toLowerCase();
  // Postcode, VAT/BTW, phone, IBAN, tracking, PO-box style context near the number.
  if (/\b(btw|vat|tel|phone|gsm|mob|iban|tracking|track|zip|postcode|postcer|kvk|coc)\b[\s:.#-]*$/.test(before)) return true;
  if (/[+]\s*\d?\s*$/.test(ctxBefore)) return true; // a phone number continuation
  // A trailing unit/quantity word makes this a count, not a DocNum (e.g. "226108 stuks", "5000 pcs").
  if (/^\s*(?:x\b|stuks?\b|stk\b|pcs\b|pieces?\b|units?\b|st\b|kg\b|gr\b|mm\b|cm\b|ltr\b)/i.test(ctxAfter)) return true;
  return false;
}

function clip(s, n) { return s.length > n ? s.slice(0, n) : s; }

// Extract candidate references from email text. Pure + deterministic.
// Options: { max = 12 } - hard cap on candidates returned (defence against a number-stuffed body).
function extractReferences(text, opts) {
  const max = (opts && opts.max) || 12;
  const src = String(text == null ? "" : text);
  const found = [];
  const seen = new Set();
  const add = (cand) => {
    const key = cand.type + "|" + cand.numberKind + "|" + cand.number.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(cand);
  };

  // 1. Keyword-typed references (highest confidence).
  for (const { type, re } of KEYWORD_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      add({ type, number: m[1], numberKind: "docnum", basis: "keyword", raw: clip(m[0].trim(), 60) });
      if (found.length >= max * 3) break;
    }
  }

  // 2. Shopify order names (their own resolution path).
  SHOPIFY_RE.lastIndex = 0;
  let sm;
  while ((sm = SHOPIFY_RE.exec(src))) {
    add({ type: "order", number: "S" + sm[1], numberKind: "shopify", basis: "shopify", raw: clip(sm[0].trim(), 60) });
    if (found.length >= max * 3) break;
  }

  // 3. Bare DocNum-shaped numbers with no nearby keyword (lowest confidence; resolver is the gate).
  //    Skip any number already captured above (a keyword/shopify hit on the same digits wins).
  const claimed = new Set(found.filter((f) => f.numberKind === "docnum").map((f) => f.number));
  BARE_RE.lastIndex = 0;
  let bm;
  while ((bm = BARE_RE.exec(src))) {
    const num = bm[1];
    if (claimed.has(num)) continue;
    const start = bm.index;
    const before = src.slice(Math.max(0, start - 24), start);
    const after = src.slice(start + num.length, start + num.length + 8);
    if (looksLikeNoise(num, before, after)) continue;
    add({ type: "unknown", number: num, numberKind: "docnum", basis: "bare", raw: clip((before.slice(-12) + num).trim(), 60) });
    if (found.length >= max * 3) break;
  }

  // Order: keyword first, then shopify, then bare; stable within each by appearance. Cap.
  const rank = { keyword: 0, shopify: 1, bare: 2 };
  found.sort((a, b) => (rank[a.basis] - rank[b.basis]));
  return found.slice(0, max);
}

module.exports = { extractReferences, KEYWORDS };

// --- CLI: node doc-references.js "some email text"  (prints the extracted candidates) ---
if (require.main === module) {
  const text = process.argv.slice(2).join(" ") || "Graag de factuur 426407 en order #226108 toesturen. Zie ook #S17878.";
  console.log(JSON.stringify(extractReferences(text), null, 2));
}
