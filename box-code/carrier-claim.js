// carrier-claim.js - Step 1 of the MyParcel claim automation.
//
// A carrier claim is the one email type where the sender is NOT the customer. MyParcel's service
// desk writes to us about a parcel that has gone missing, opens an investigation with the carrier,
// and asks us for the documents that prove what was in the box and what it was worth. Item 1316
// (Aug 2026) is the worked example: barcode 1ZRJ71190404069255, stuck in distribution since 30
// June, "Graag ontvang ik een inkoop- en verkoopfactuur."
//
// Axle's existing attachment path could not help there. It scopes every document to the customer
// resolved from the SENDER's address, and the sender is info@myparcel.nl, so both correct hits -
// the order and the AR invoice - were pushed into "different customer, review before attaching"
// and the salesperson was told to go and find them by hand.
//
// This module establishes the alternative scope, and it is the load-bearing safety boundary of
// the whole feature:
//
//   the scope of a carrier-claim email is THE ORDER THAT ITS BARCODE RESOLVES TO
//   IN OUR OWN MYPARCEL ACCOUNT - never anything the email body asserts.
//
// Why that is safe. A barcode in the body is a candidate string and nothing more. We hand it to
// the MyParcel API using OUR keys, which can only ever return OUR shipments (Gouda + Drachten).
// A barcode belonging to someone else's parcel, or invented outright, returns nothing and the
// email gets no claim scope at all. The order number is then read from the SHIPMENT's own label
// reference - a field we wrote when we created the label - not from the email. So no wording in
// an inbound email can widen what a claim reply is allowed to reach: the worst a hostile email
// can do is name a real barcode of ours, which surfaces that parcel's own documents.
//
// Two further guards live here rather than downstream, because they are cheap and absolute:
//   * the sender must be an EXACT address on the carrier allow-list, never a domain match -
//     facturen@myparcel.nl is their accounts department (rules.js already routes it as a supplier
//     invoice) and must never be able to open a claim scope;
//   * the email must actually be asking us for documents. A delivery confirmation or a status
//     update from the same desk is not a claim and gets no attachments.
//
// READ-ONLY: one MyParcel read. No SAP write, no send, nothing staged. The documents themselves
// are resolved, rendered and staged downstream, all behind the existing human approval gate.

"use strict";

// ---------------------------------------------------------------- carrier senders
// Exact addresses only. Add a carrier here deliberately; a domain would sweep in their billing,
// marketing and no-reply desks, and a claim scope is not something to grant by accident.
const CLAIM_SENDERS = new Set([
  "info@myparcel.nl",
]);

function isClaimSender(address) {
  return CLAIM_SENDERS.has(String(address || "").trim().toLowerCase());
}

// ---------------------------------------------------------------- what they are asking for
// MyParcel's request list is boilerplate off their Salesforce templates, in Dutch or English.
// We only need to know WHICH documents were asked for; the wording itself is untrusted data.
const WANT_SALES = /\b(verkoopfactuur|verkoop-?\s*en|sales\s+invoice|commercial\s+invoice)\b/i;
const WANT_PURCHASE = /\b(inkoopfactuur|inkoop-?\s*en|purchase\s+invoice)\b/i;
// The generic ask ("graag ontvang ik de factuur") only counts as a claim when it sits beside
// investigation language - otherwise every invoice-copy request would look like a claim.
const WANT_GENERIC = /\b(factuur|facturen|invoice|invoices)\b/i;
const CLAIM_CONTEXT =
  /\b(onderzoek|vermist|kwijt|zoekgeraakt|niet\s+(?:meer\s+)?trace(?:erbaar|able)|lost\s*&?\s*found|claim|schade|uitgekeerd|uitkering|depot)\b/i;

function documentsWanted(text) {
  const s = String(text || "");
  const sales = WANT_SALES.test(s);
  const purchase = WANT_PURCHASE.test(s);
  // "inkoop- en verkoopfactuur" is one hyphenated phrase; either half matching means both.
  const compound = /\b(inkoop|verkoop)-\s*en\s+(inkoop|verkoop)?factuur\b/i.test(s);
  if (compound) return { sales: true, purchase: true, basis: "compound" };
  if (sales || purchase) return { sales, purchase, basis: "explicit" };
  if (WANT_GENERIC.test(s) && CLAIM_CONTEXT.test(s)) {
    // They want documents but did not name them. Treat as the full pack - that is what the
    // investigation always needs, and offering too much is recoverable where too little is not.
    return { sales: true, purchase: true, basis: "generic" };
  }
  return { sales: false, purchase: false, basis: "none" };
}

// ---------------------------------------------------------------- barcode extraction
// Deterministic, structured patterns only. A bare run of digits is deliberately NOT a candidate:
// it collides with our own order and invoice numbers, and a wrong candidate costs a pointless
// API round trip at best. Every candidate is validated by RESOLVING it, so a pattern that lets
// something odd through cannot do harm - it simply fails to resolve.
const BARCODE_PATTERNS = [
  /\b1Z[0-9A-Z]{16}\b/gi,            // UPS  - 1ZRJ71190404069255
  /\b3S[0-9A-Z]{6,20}\b/gi,          // PostNL / MyParcel - 3SMYPA6954778
  /\bJV[A-Z]{2}\d{6,20}\b/gi,        // DHL Parcel - JVGL...
  /\b[A-Z]{2}\d{9}[A-Z]{2}\b/g,      // UPU S10 international - CD903568767NL
];

// Pull every plausible carrier barcode out of a text, de-duplicated, original order preserved.
// `max` caps how many we will spend a lookup on.
function extractBarcodes(text, opts = {}) {
  const max = opts.max || 4;
  const s = String(text || "");
  const seen = new Set();
  const out = [];
  for (const re of BARCODE_PATTERNS) {
    re.lastIndex = 0;
    for (const m of s.match(re) || []) {
      const code = m.toUpperCase();
      if (seen.has(code)) continue;
      seen.add(code);
      out.push(code);
    }
  }
  // The subject line usually carries the barcode ("1ZRJ71190404069255 naar Benjamin Bourgois"),
  // and callers pass subject + body joined, so document order already favours it.
  return out.slice(0, max);
}

// ---------------------------------------------------------------- label reference -> our orders
// We write the label reference ourselves at dispatch: "227148 - #S18422" (SAP order number,
// often the Shopify name too). It is OUR data, read back off OUR shipment - which is exactly why
// the order number is taken from here and never from the email.
const SHOPIFY_NAME_RE = /#?\b(S\d{3,6})\b/gi;
const SAP_DOCNUM_RE = /\b(\d{5,7})\b/g;

function ordersFromReference(reference) {
  const s = String(reference || "");
  const shopifyNames = [];
  const sapOrderNums = [];
  for (const m of s.matchAll(SHOPIFY_NAME_RE)) {
    const name = m[1].toUpperCase();
    if (!shopifyNames.includes(name)) shopifyNames.push(name);
  }
  // Strip the Shopify tokens first so their digits are not also read as a SAP DocNum.
  for (const m of s.replace(SHOPIFY_NAME_RE, " ").matchAll(SAP_DOCNUM_RE)) {
    if (!sapOrderNums.includes(m[1])) sapOrderNums.push(m[1]);
  }
  return { sapOrderNums, shopifyNames };
}

// ---------------------------------------------------------------- shipment resolution
// MyParcel's /shipments?q= is a fuzzy search, so a returned row is a CANDIDATE, not an answer.
// We keep only a row whose barcode matches the one we asked about exactly - otherwise a near
// miss on someone else's parcel could set the scope for the whole reply.
function defaultDeps() {
  const C = require("./connectors.js");
  return { myparcelSearch: C.myparcelSearch };
}

async function resolveShipment(barcode, deps) {
  deps = deps || defaultDeps();
  const want = String(barcode || "").trim().toUpperCase();
  if (!want) return null;
  let rows;
  try { rows = await deps.myparcelSearch(want, 5); }
  catch { return null; }                       // a MyParcel outage withholds scope; it never invents one
  const hit = (rows || []).find((r) => String(r && r.barcode || "").toUpperCase() === want);
  if (!hit) return null;                       // not one of our parcels -> no claim scope
  const { sapOrderNums, shopifyNames } = ordersFromReference(hit.reference);
  return {
    barcode: want,
    shop: hit.shop,                            // gouda | drachten - which branch dispatched it
    shipment_id: hit.id,
    status: hit.status,
    carrier: hit.carrier,
    created: hit.created,
    reference: hit.reference,
    insurance_eur: hit.insurance_eur,
    weight_g: hit.weight_g,
    recipient: hit.recipient,
    sap_order_numbers: sapOrderNums,
    shopify_order_names: shopifyNames,
  };
}

// ---------------------------------------------------------------- the detector
// Given an email, decide whether this is a carrier claim and, if so, what its scope is.
// `flagged` short-circuits everything: an injection-flagged email must never acquire a document
// scope, exactly as it never contributes attachment hints anywhere else in the pipeline.
async function detectClaim(email, opts = {}, deps) {
  const senderAddress = (email && email.senderAddress) || "";
  const text = [(email && email.subject) || "", (email && email.text) || ""].join("\n");

  if (opts.flagged) return { is_claim: false, reason: "flagged" };
  if (!isClaimSender(senderAddress)) return { is_claim: false, reason: "sender_not_carrier" };

  const wants = documentsWanted(text);
  if (!wants.sales && !wants.purchase) return { is_claim: false, reason: "no_document_request" };

  const barcodes = extractBarcodes(text, { max: opts.maxBarcodes || 4 });
  if (!barcodes.length) return { is_claim: false, reason: "no_barcode", wants };

  const shipments = [];
  for (const b of barcodes) {
    const s = await resolveShipment(b, deps);
    if (s) shipments.push(s);
  }
  if (!shipments.length) {
    // The barcode did not match any parcel of ours. This is the case that must NOT fall back to
    // some looser scope: no shipment, no documents. The salesperson still gets the email.
    return { is_claim: false, reason: "barcode_not_ours", wants, barcodes };
  }

  const sapOrderNumbers = [];
  for (const s of shipments) {
    for (const n of s.sap_order_numbers) if (!sapOrderNumbers.includes(n)) sapOrderNumbers.push(n);
  }

  return {
    is_claim: true,
    reason: "ok",
    wants,
    barcodes,
    shipments,
    // The whole scope of the reply, in one field, derived only from our own shipment records.
    sap_order_numbers: sapOrderNumbers,
    shopify_order_names: shipments.flatMap((s) => s.shopify_order_names),
  };
}

module.exports = {
  CLAIM_SENDERS, isClaimSender, documentsWanted, extractBarcodes,
  ordersFromReference, resolveShipment, detectClaim,
};
