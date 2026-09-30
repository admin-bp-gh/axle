// withdrawn-attempt.test.js - item #2368 (2026-09-30). Run: node withdrawn-attempt.test.js
const assert = require("assert");
const { previousAttempt, withdrawnNotice, analyse } = require("./withdrawn-attempt.js");

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };

const item = (o = {}) => ({ origin: "inbound", email_received: "2026-09-30T16:51:00Z", ...o });
const row = (body, version = 3, created_at = "2026-09-30T18:23:41Z") => ({ body, version, created_at, source: "withdrawn" });
const VIN_TEXT = "Hi Edgar,\n\nBased on your VIN the headlamps for your Discovery are no longer available from any supplier.\n\nKind regards";

console.log("withdrawn-attempt");

test("VIN claim in the latest run's withdrawn draft -> reason 'vin' with the fragment", () => {
  const a = analyse(item(), row(VIN_TEXT), 3, []);
  assert.deepStrictEqual(a.reasons, ["vin"]);
  assert.strictEqual(a.offending.length, 1);
  assert.ok(/based on your vin/i.test(a.offending[0]));
});

test("previousAttempt builds the seed block", () => {
  const p = previousAttempt(item(), row(VIN_TEXT), 3, []);
  assert.ok(/WITHDRAWN/.test(p.note));
  assert.ok(/VIN/.test(p.note));
  assert.strictEqual(p.withdrawn_text, VIN_TEXT);
  assert.deepStrictEqual(p.offending_fragments.length, 1);
});

test("sourcing claim -> 'sourcing'", () => {
  const a = analyse(item(), row("It ships directly from our supplier in the UK."), 3, []);
  assert.deepStrictEqual(a.reasons, ["sourcing"]);
});

test("availability gate is read off the open questions", () => {
  const a = analyse(item(), row("We can get XBC001650 for you within a week."), 3,
    [{ question: "Check availability with the supplier for XBC001650 before replying — it is out of stock" }]);
  assert.deepStrictEqual(a.reasons, ["availability"]);
  assert.strictEqual(a.offending.length, 0);
});

test("a withdrawn row from an EARLIER run than the latest draft is ignored", () => {
  assert.strictEqual(analyse(item(), row(VIN_TEXT, 2), 3, []), null);
  assert.strictEqual(withdrawnNotice(item(), row(VIN_TEXT, 2), 3, []), null);
});

test("a withdrawn row older than the current email is ignored", () => {
  assert.strictEqual(analyse(item(), row(VIN_TEXT, 3, "2026-09-30T10:00:00Z"), 3, []), null);
});

test("no row, or a row that trips no known pattern -> nothing to say", () => {
  assert.strictEqual(analyse(item(), null, 3, []), null);
  assert.strictEqual(analyse(item(), row("Thanks for the VIN, we will check and come back to you."), 3, []), null);
});

test("notice carries reason codes + text only", () => {
  const n = withdrawnNotice(item(), row(VIN_TEXT), 3, []);
  assert.deepStrictEqual(Object.keys(n).sort(), ["reasons", "text"]);
});

console.log(`\n${pass} passed`);
