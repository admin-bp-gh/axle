// return-dossier.test.js — unit tests for the pure helpers of the return dossier.
// The full returnDossier() reaches SAP + Shopify (live, on-prem) so it is verified on the
// box; here we lock the deterministic reason/business/electrical/refund logic the model relies
// on as hints. Run: node return-dossier.test.js
const assert = require("assert");
const C = require("./connectors.js");

let pass = 0;
const ok = (name, fn) => { fn(); pass++; console.log("  ok -", name); };

// --- who pays return shipping, by Shopify returnReason ---
ok("our-fault reasons => we pay", () => {
  for (const r of ["DEFECTIVE", "WRONG_ITEM", "NOT_AS_DESCRIBED", "defective"]) {
    assert.strictEqual(C.whoPaysForReason(r), "us");
  }
});
ok("change-of-mind reasons => customer pays", () => {
  for (const r of ["UNWANTED", "SIZE_TOO_SMALL", "SIZE_TOO_LARGE", "STYLE", "COLOR"]) {
    assert.strictEqual(C.whoPaysForReason(r), "customer");
  }
});
ok("ambiguous/blank => confirm", () => {
  for (const r of ["OTHER", "UNKNOWN", "", null, undefined, "weird"]) {
    assert.strictEqual(C.whoPaysForReason(r), "confirm");
  }
});

// --- business vs consumer signal ---
ok("VAT number present => likely business", () => {
  const s = C.businessSignal("Jan Jansen", "NL812345678B01");
  assert.strictEqual(s.likely_business, true);
  assert.strictEqual(s.has_vat, true);
});
ok("business marker in name => likely business", () => {
  for (const n of ["Garage Troch", "SVE Automotive", "Komplot BV", "Rover Service", "Autobedrijf Jansen"]) {
    assert.strictEqual(C.businessSignal(n, "").likely_business, true, n);
  }
});
ok("plain personal name, no VAT => consumer", () => {
  const s = C.businessSignal("Nick Weerts", "");
  assert.strictEqual(s.likely_business, false);
  assert.strictEqual(s.name_marker, false);
});

// --- electrical hint from name/category ---
ok("electrical items flagged", () => {
  assert.strictEqual(C.electricalHint("ABS Sensor Front", "Sensor"), true);
  assert.strictEqual(C.electricalHint("Headlamp LH", "Lighting"), true);
  assert.strictEqual(C.electricalHint("Fuel Pump", "Fuel System"), true);
});
ok("mechanical items not flagged", () => {
  assert.strictEqual(C.electricalHint("Body to Chassis Bracket – Rear", "Body Mount Bracket"), false);
  assert.strictEqual(C.electricalHint("Spare Wheel Carrier – Half Door", "Spare Wheel Carrier"), false);
});

// --- refund route from SAP payment letter ---
ok("refund route by payment method", () => {
  assert.match(C.refundRoute("S"), /Shopify/);
  assert.match(C.refundRoute("B"), /IBAN/);
  assert.match(C.refundRoute("P"), /IBAN/);
  assert.match(C.refundRoute("A"), /account/);
  assert.match(C.refundRoute("N"), /verify payment/);
});

console.log(`\n${pass} checks passed`);
