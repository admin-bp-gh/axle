// customer-price.test.js - tier pricing (2026-10-09): the price list on the customer card and the
// customer price the part tools carry when the customer is on a discount tier.
// Run: node customer-price.test.js
const assert = require("assert");
const C = require("./connectors.js");

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };

console.log("customer-price");

test("priceListInfo: list 1 is the standard list, the others are tiers, Brad's sort prefix dropped", () => {
  assert.deepStrictEqual(C.priceListInfo(1, "11. Sales - Standard"), { num: 1, name: "Sales - Standard", tier: false });
  assert.deepStrictEqual(C.priceListInfo(2, "13. Sales - Pro (10%)"), { num: 2, name: "Sales - Pro (10%)", tier: true });
  assert.deepStrictEqual(C.priceListInfo(null, null), { num: null, name: null, tier: false });
});

test("assembleDossier carries customer_price_excl_vat only when the row has one", () => {
  const rows = [{ ItemCode: "A1", ItemName: "Pad", OnHand: 3, WebPrice: 100, CustPrice: 90 },
                { ItemCode: "A2", ItemName: "Pad B", OnHand: 0, WebPrice: 80 }];
  const out = C.assembleDossier(rows, new Set(["A1"]));
  assert.strictEqual(out[0].web_price_excl_vat, 100);
  assert.strictEqual(out[0].customer_price_excl_vat, 90);
  assert.strictEqual(out[1].customer_price_excl_vat, undefined);
  assert.ok(!("customer_price_excl_vat" in JSON.parse(JSON.stringify(out[1]))));
});

test("rankCandidates carries customer_price_excl_vat the same way", () => {
  const out = C.rankCandidates([{ ItemCode: "B1", ItemName: "front disc", OnHand: 1, WebPrice: 50, CustPrice: 42.5, U_ABC: "A" }], ["front"], {});
  assert.strictEqual(out[0].customer_price_excl_vat, 42.5);
});

console.log(`\n${pass} passed`);
