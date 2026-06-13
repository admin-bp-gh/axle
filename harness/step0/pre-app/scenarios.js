// scenarios.js - Axle Compose: the seeded quick-start scenario library.
//
// A free-text instruction always works in Compose. Scenarios are OPTIONAL starters: a chip
// pre-fills a plain-language prompt skeleton (the salesperson edits it) and carries hints to
// compose-mode about which lookups and which business-knowledge policy apply. They are DATA,
// not code - Brad can add/edit/remove entries here (git-tracked, maintained by the same
// "patch file + mirror" process as business-knowledge.md), no engine change needed.
//
// Shape (brief sec7): { key, label_en, label_nl, prompt_skeleton, required_identifiers,
//                       suggested_lookups, knowledge_refs }.
// Launch set = Tier 1 (Brad-confirmed) + Tier 2 (strong, evidence-based) = 6 scenarios.
// Placeholders in {curly braces} are for the salesperson to fill in before drafting.

const SCENARIOS = [
  // ---- Tier 1 (Brad-confirmed) --------------------------------------------------------
  {
    key: "awaiting_payment",
    label_en: "Awaiting payment",
    label_nl: "Betaling in afwachting",
    prompt_skeleton:
      "Situation: we have not received payment for order {order} yet.\n" +
      "Stock: we have already ordered it from our supplier - check the expected arrival and mention it.\n" +
      "Ask: ask the customer to pay at their earliest convenience; we will ship as soon as the stock arrives.\n" +
      "Must include: our IBAN and the order number as the payment reference.",
    required_identifiers: ["sales order number or AR-invoice number"],
    suggested_lookups: "Order + U_Paid payment status; supplier ETA via an A/P reserve invoice " +
      "(OPCH.isIns='Y', posting date + 1-2 weeks) or an open PO; our IBAN + the order number as reference.",
    knowledge_refs: ["Payments & accounts", "Awaiting payment: always cite our IBAN + order number; a payment total is never labelled 'excl. VAT'"],
  },
  {
    key: "stock_shortfall",
    label_en: "Stock shortfall / our mistake",
    label_nl: "Voorraadtekort / onze fout",
    prompt_skeleton:
      "Situation: we cannot fulfil all of order {order} right now - {item} is short.\n" +
      "Be honest: explain it plainly; if this was our mistake, own it briefly.\n" +
      "Offer: suggest a sensible alternative if there is one, and give the lead time / ETA if it is already on order.",
    required_identifiers: ["sales order number or item code"],
    suggested_lookups: "Stock on hand (OITM.OnHand); alternatives (U_Alternatives); supplier ETA via a " +
      "reserve invoice or an open PO.",
    knowledge_refs: ["Stock & availability", "Backorder / our-mistake exception"],
  },
  {
    key: "order_eta_update",
    label_en: "Order / ETA update",
    label_nl: "Order- / levertijdupdate",
    prompt_skeleton:
      "Situation: proactive status update on order {order}.\n" +
      "Outstanding: say what is still outstanding and when we expect it.\n" +
      "ETA: base it on the linked purchase order / reserve invoice and word it as an estimate - never a promise.",
    required_identifiers: ["sales order number"],
    suggested_lookups: "Order lines + open quantity; supplier ETA via a reserve invoice (posting date + " +
      "1-2 weeks) or an open PO (OPOR.DocDueDate).",
    knowledge_refs: ["Supplier ETA rule", "Never promise delivery dates - relay an ETA only as an estimate"],
  },

  // ---- Tier 2 (strong adds, seen repeatedly in real outbound) -------------------------
  {
    key: "missing_details",
    label_en: "Missing details to dispatch",
    label_nl: "Ontbrekende gegevens",
    prompt_skeleton:
      "Situation: we are ready to dispatch order {order} but need {missing detail} to complete it.\n" +
      "Ask: ask the customer clearly for exactly what is missing (for example the street name, a VIN, or a photo).",
    required_identifiers: ["sales order number"],
    suggested_lookups: "Order ship-to address (RDR12) to see what is present vs missing; the VIN/photo the " +
      "fitment or dispatch needs.",
    knowledge_refs: ["Order fulfilment", "Part identification & fitment (VIN / photo policy)"],
  },
  {
    key: "part_superseded",
    label_en: "Part discontinued / superseded",
    label_nl: "Onderdeel vervallen / opgevolgd",
    prompt_skeleton:
      "Situation: part {old part} is no longer available or has been renumbered.\n" +
      "New part: give the customer the new number - we can supply {new part}, or explain it is dealer-only.\n" +
      "Link: include the product page if we sell it.",
    required_identifiers: ["part number"],
    suggested_lookups: "OITM by old/new code; U_Alternatives / superseded codes; fitment; webshop handle via " +
      "shopify_query for the product link.",
    knowledge_refs: ["Part identification & fitment", "Sourcing hierarchy / non-EU advice"],
  },
  {
    key: "quote_offer",
    label_en: "Quote / sourcing offer",
    label_nl: "Offerte / onderdeel aanbieden",
    prompt_skeleton:
      "Offer: proactively offer {part} to the customer.\n" +
      "Include: the price (ex VAT) and the product link, plus the lead time if we have to buy it in.\n" +
      "Keep it: short and concrete.",
    required_identifiers: ["part number and/or customer"],
    suggested_lookups: "Price + stock (OITM); webshop handle for the product link; supplier lead time if not in stock.",
    knowledge_refs: ["Quotes & sourcing (always ex VAT, product hyperlinks)", "A formal Klantofferte stays a human action"],
  },
];

const BY_KEY = new Map(SCENARIOS.map((s) => [s.key, s]));

// Full config for a chip key (used to seed the prompt skeleton in the UI).
function byKey(key) {
  return key ? BY_KEY.get(String(key)) || null : null;
}

// The trimmed object compose-mode sees as a hint (NOT the skeleton again - that is already in
// the edited instruction; passing it twice just wastes tokens). label in English for the model.
function forModel(key) {
  const s = byKey(key);
  if (!s) return null;
  return { key: s.key, label: s.label_en, suggested_lookups: s.suggested_lookups, knowledge_refs: s.knowledge_refs };
}

// Chip list for the modal, label resolved to the viewer's UI language.
function chips(uiLang) {
  return SCENARIOS.map((s) => ({ key: s.key, label: (uiLang === "nl" ? s.label_nl : s.label_en), skeleton: s.prompt_skeleton }));
}

module.exports = { SCENARIOS, byKey, forModel, chips };
