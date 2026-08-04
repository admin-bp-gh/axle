// compose-suggest.test.js - FR-0004: prove the buildSuggestions(refText, scope, opts) call that
// shared.js makes for a COMPOSE item classifies correctly. Run: node compose-suggest.test.js
// Uses the real (unedited) doc-suggest.js with mock SAP deps - no live SAP, no network.
"use strict";
const DS = require("./doc-suggest.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("  FAIL:", m); } };

const CARD = "C0001";
// Mock the read-only resolvers: order 226108 + invoice 426407 belong to OUR compose customer;
// invoice 999001 belongs to a DIFFERENT customer (the scope-guard's crown-jewel case).
const deps = {
  async resolveDocument(type, num) {
    const map = {
      "order:226108":   [{ objectId: 17, type: "Order",   docNum: 226108, docEntry: 5108, cardCode: CARD,    cardName: "Garage Bulcke", docTotal: 100, docCur: "EUR", docDate: "2026-06-01" }],
      "invoice:426407": [{ objectId: 13, type: "Invoice", docNum: 426407, docEntry: 6407, cardCode: CARD,    cardName: "Garage Bulcke", docTotal: 50,  docCur: "EUR" }],
      "invoice:999001": [{ objectId: 13, type: "Invoice", docNum: 999001, docEntry: 9001, cardCode: "OTHER", cardName: "Someone Else",  docTotal: 80,  docCur: "EUR" }],
    };
    return { ok: true, candidates: map[type + ":" + num] || [] };
  },
  async resolveShopifyOrder() { return { ok: true, candidates: [] }; },
  async customerByEmail() { return null; },
};

(async () => {
  // 1) Known compose customer + an order number in the instruction -> clean in_scope one-click.
  const instr = "Tell the customer we haven't received payment for order 226108 (TF534). Ask them to pay.";
  let s = await DS.buildSuggestions(instr, { cardCode: CARD, cardName: "Garage Bulcke" }, {}, deps);
  ok(s.length === 1 && s[0].status === "in_scope" && s[0].docs[0].docNum === 226108, "compose + known card: order 226108 -> in_scope");

  // 2) Guest compose (no resolved card) -> the same number can only be out_of_scope (explicit confirm).
  s = await DS.buildSuggestions(instr, { cardCode: "" }, {}, deps);
  ok(s.length === 1 && s[0].status === "out_of_scope", "compose guest (no card): out_of_scope, never a silent one-click");

  // 3) A foreign customer's invoice referenced in the draft text is NEVER in_scope.
  s = await DS.buildSuggestions("Please also see invoice 999001.", { cardCode: CARD }, {}, deps);
  ok(s.length === 1 && s[0].status === "out_of_scope", "foreign invoice 999001 -> out_of_scope");

  // 4) Model hint (result.referenced_documents) goes through the SAME gate; in-scope resolves clean.
  s = await DS.buildSuggestions("resend my last invoice", { cardCode: CARD }, { extraRefs: [{ type: "invoice", number: "426407" }] }, deps);
  ok(s.length === 1 && s[0].status === "in_scope" && s[0].reference.basis === "model", "compose model-hint 426407 -> in_scope");

  // 5) No references in the instruction/draft -> no suggestions (and no crash).
  s = await DS.buildSuggestions("Thanks, that's all sorted.", { cardCode: CARD }, {}, deps);
  ok(s.length === 0, "no references -> empty");

  console.log(`\n${pass}/${pass + fail} asserts passed` + (fail ? `  (${fail} FAILED)` : "  ✓"));
  process.exit(fail ? 1 : 0);
})();
