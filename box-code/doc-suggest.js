// doc-suggest.js - Step 2 of auto-attach: resolve extracted references + customer-scope filter.
//
// Takes the email text (untrusted) and the EMAIL'S customer (resolved on the trusted side -
// compose_customer.cardCode for a compose item, or customerByEmail(sender) for an inbound reply),
// and returns a list of SUGGESTIONS the salesperson can one-click attach.
//
// Every reference the extractor finds is RESOLVED against live SAP deterministically (the number
// is data, never an instruction) and then SCOPE-CHECKED: a document is "in scope" only when its
// CardCode equals the email's customer. This is the load-bearing guard - it stops a mistaken or
// malicious email from pulling in another customer's invoice (their pricing, address, totals).
//
//   status 'in_scope'     - one real document, belongs to this customer  -> clean one-click add
//   status 'ambiguous'    - several in-scope docs share the number       -> reuse the in-set picker
//   status 'out_of_scope' - resolved, but a DIFFERENT customer (or the email's customer is unknown)
//                           -> shown only behind an explicit "attach anyway" confirm, never one-click
//   status 'unresolved'   - the number matches no real document          -> DROPPED, never shown
//
// READ-ONLY: this only calls the read-only resolvers. It renders nothing and stages nothing - the
// surface (Step 3) reuses the existing /attach-doc render+staging behind the approval gate.

"use strict";

// Default deps wire to the box's read-only SAP resolvers; tests inject mocks.
function defaultDeps() {
  const SAPDOC = require("./sap-doc-pdf.js");
  return {
    resolveDocument: SAPDOC.resolveDocument,
    resolveShopifyOrder: SAPDOC.resolveShopifyOrder,
    customerByEmail: SAPDOC.customerByEmail,
  };
}

// Resolve ONE extracted reference to its candidate document(s). Returns { docs:[...] } (possibly
// empty). For a bare number (type 'unknown') we try order first, then invoice (Brad's locked
// inference). A keyword/shopify reference resolves on its single known path.
async function resolveReference(ref, deps) {
  if (ref.numberKind === "shopify") {
    const r = await deps.resolveShopifyOrder(ref.number);
    return { docs: (r && r.ok && r.candidates) || [] };
  }
  const tryTypes = ref.type === "unknown" ? ["order", "invoice"] : [ref.type];
  for (const type of tryTypes) {
    const r = await deps.resolveDocument(type, ref.number);
    if (r && r.ok && r.candidates && r.candidates.length) return { docs: r.candidates };
  }
  return { docs: [] };
}

// Classify a resolved reference against the email's customer card.
function classify(ref, docs, scopeCard) {
  if (!docs.length) return { reference: ref, status: "unresolved", docs: [] };
  const card = scopeCard || "";
  const inScope = card ? docs.filter((d) => d.cardCode === card) : [];
  if (inScope.length === 1) return { reference: ref, status: "in_scope", docs: inScope };
  if (inScope.length > 1) return { reference: ref, status: "ambiguous", docs: inScope };
  // No in-scope match: either the email's customer is unknown (card === "") or every resolved
  // doc belongs to someone else. Both require an explicit human confirm - never a one-click.
  return { reference: ref, status: "out_of_scope", docs };
}

// Normalise model-hinted references (opts.extraRefs = [{type, number}] from the draft model) into
// the same candidate shape as the deterministic extractor. The model's number is JUST a candidate:
// it is resolved + scope-checked here exactly like any other, so a wrong or hostile hint simply
// fails to resolve or is scope-blocked. Anything not a clean {type, number} is dropped.
const VALID_TYPES = new Set(["order", "invoice", "quotation", "delivery", "creditnote"]);
function normaliseModelRefs(extraRefs) {
  const out = [];
  for (const r of Array.isArray(extraRefs) ? extraRefs.slice(0, 6) : []) {
    const raw = String((r && r.number) != null ? r.number : "").trim();
    const sMatch = raw.match(/^#?S(\d{3,6})$/i);            // a Shopify order name
    if (sMatch) { out.push({ type: "order", number: "S" + sMatch[1], numberKind: "shopify", basis: "model", raw: raw.slice(0, 60) }); continue; }
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 3 || digits.length > 7) continue;   // not a plausible DocNum
    const type = VALID_TYPES.has(String(r && r.type).toLowerCase()) ? String(r.type).toLowerCase() : "unknown";
    out.push({ type, number: digits, numberKind: "docnum", basis: "model", raw: raw.slice(0, 60) });
  }
  return out;
}

// Build the suggestion list for an email. `scope` = { cardCode, cardName } of the email's customer
// (cardCode may be "" / null when the sender couldn't be resolved to a single active customer).
// opts.maxResolve caps how many references we hit SAP for; opts.max caps suggestions returned;
// opts.extraRefs are model-hinted references merged in AFTER the deterministic ones (same gate).
async function buildSuggestions(text, scope, opts, deps) {
  deps = deps || defaultDeps();
  opts = opts || {};
  const maxResolve = opts.maxResolve || 8;
  const max = opts.max || 6;
  const scopeCard = (scope && scope.cardCode) || "";

  const { extractReferences } = require("./doc-references.js");
  // Deterministic-from-text candidates lead; model hints are appended, then de-duped (a keyword/
  // bare hit on the same number+kind wins over the model hint). The whole set hits the same gate.
  const textRefs = extractReferences(text, { max: maxResolve });
  const modelRefs = normaliseModelRefs(opts.extraRefs);
  const merged = [];
  const seenRef = new Set();
  for (const r of textRefs.concat(modelRefs)) {
    const k = r.numberKind + "|" + r.number.toLowerCase();   // ignore type so unknown/order on same number collapse
    if (seenRef.has(k)) continue;
    seenRef.add(k);
    merged.push(r);
  }
  const refs = merged.slice(0, maxResolve);

  const out = [];
  const seenDoc = new Set();   // de-dupe across references that resolve to the same document
  for (const ref of refs) {
    let docs;
    try { ({ docs } = await resolveReference(ref, deps)); }
    catch (e) { out.push({ reference: ref, status: "error", docs: [], error: String(e.message || e).slice(0, 120) }); continue; }
    const s = classify(ref, docs, scopeCard);
    if (s.status === "unresolved") continue;   // never surface a number that resolves to nothing

    // Drop docs already represented by an earlier (higher-confidence) suggestion.
    s.docs = s.docs.filter((d) => {
      const k = d.objectId + ":" + d.docEntry;
      if (seenDoc.has(k)) return false;
      seenDoc.add(k);
      return true;
    });
    if (!s.docs.length) continue;
    // Re-classify length-sensitive statuses after de-dup (an in-scope set could have shrunk).
    if (s.status === "ambiguous" && s.docs.length === 1) s.status = "in_scope";
    out.push(s);
  }

  // Order: in_scope first (the clean one-click adds), then ambiguous, then out_of_scope.
  const rank = { in_scope: 0, ambiguous: 1, out_of_scope: 2, error: 3 };
  out.sort((a, b) => (rank[a.status] - rank[b.status]));
  return out.slice(0, max);
}

// Convenience: resolve an inbound email's customer scope from its sender, then build suggestions.
// Used by both ingest (store on the item) and the server (lazy fallback) so they agree exactly.
// An unresolvable sender => empty scope => every match is out_of_scope (explicit confirm), never
// a silent one-click. READ-ONLY throughout.
async function suggestForEmail(senderEmail, text, opts, deps) {
  deps = deps || defaultDeps();
  let scope = { cardCode: "", cardName: "" };
  try {
    const m = await deps.customerByEmail(senderEmail);
    if (m && m.cardCode) scope = { cardCode: m.cardCode, cardName: m.cardName || "" };
  } catch (e) { /* unknown customer -> empty scope */ }
  return buildSuggestions(text, scope, opts, deps);
}

module.exports = { buildSuggestions, suggestForEmail, resolveReference, classify };
