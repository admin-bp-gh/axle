// unread-sweep.test.js - the ingest unread-sweep decision table. Run: node unread-sweep.test.js
const assert = require("assert");
const { sweepAdditions, MAX_ADDED } = require("./unread-sweep.js");

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };

const msg = (id, received = "2026-08-14T14:32:00Z", key = "admin@budget-parts.nl|allmakes 0001") =>
  ({ id, received, key });
const keyOf = (m) => m.key;
const none = () => null;
const ids = (r) => r.add.map((m) => m.id);

console.log("unread-sweep");

test("the live case: mail moved into a watched folder, on a thread Axle has never seen", () => {
  const r = sweepAdditions([msg("MOVED")], new Set(), keyOf, none);
  assert.deepStrictEqual(ids(r), ["MOVED"]);
  assert.deepStrictEqual(r.skip, []);
});

test("mail the watermark fetch already returned is never added twice", () => {
  const r = sweepAdditions([msg("SEEN")], new Set(["SEEN"]), keyOf, none);
  assert.deepStrictEqual(ids(r), []);
  assert.deepStrictEqual(r.skip, []);
});

test("THE GUARD: old unread mail on a known thread is left to the reopen mirror", () => {
  // The #992 shape — the unread message is the customer's ORIGINAL mail, several replies back.
  // Adding it would make ingest treat it as the thread's newest and re-draft from stale text.
  const item = { id: 992, email_received: "2026-08-14T16:00:00Z" };
  const r = sweepAdditions([msg("ORIGINAL", "2026-08-10T09:00:00Z")], new Set(), keyOf, () => item);
  assert.deepStrictEqual(ids(r), []);
  assert.strictEqual(r.skip.length, 1);
  assert.match(r.skip[0].why, /reopen mirror/);
});

test("...but genuinely newer mail on a known thread IS added", () => {
  const item = { id: 992, email_received: "2026-08-10T09:00:00Z" };
  const r = sweepAdditions([msg("NEWER", "2026-08-14T16:00:00Z")], new Set(), keyOf, () => item);
  assert.deepStrictEqual(ids(r), ["NEWER"]);
});

test("equal timestamps are not newer (the same message, re-fetched)", () => {
  const item = { id: 992, email_received: "2026-08-14T14:32:00Z" };
  assert.deepStrictEqual(ids(sweepAdditions([msg("SAME")], new Set(), keyOf, () => item)), []);
});

test("an item with no recorded email_received counts as having nothing", () => {
  // Anything dated beats nothing, so the sweep heals an item whose received stamp was never set.
  for (const missing of [null, undefined, "", "not a date"]) {
    const r = sweepAdditions([msg("M")], new Set(), keyOf, () => ({ id: 7, email_received: missing }));
    assert.deepStrictEqual(ids(r), ["M"], String(missing));
  }
});

test("an undated message never displaces what an item already holds", () => {
  const item = { id: 7, email_received: "2026-08-14T14:32:00Z" };
  assert.deepStrictEqual(ids(sweepAdditions([msg("M", null)], new Set(), keyOf, () => item)), []);
});

test("the cap bounds one run, and the overflow is reported not dropped silently", () => {
  const many = Array.from({ length: MAX_ADDED + 3 }, (_, i) => msg("m" + i));
  const r = sweepAdditions(many, new Set(), keyOf, none);
  assert.strictEqual(r.add.length, MAX_ADDED);
  assert.strictEqual(r.skip.length, 3);
  assert.ok(r.skip.every((s) => s.why === "cap"));
});

test("bad input is inert", () => {
  assert.deepStrictEqual(sweepAdditions(null, new Set(), keyOf, none), { add: [], skip: [] });
  assert.deepStrictEqual(sweepAdditions([null, { received: "x" }], new Set(), keyOf, none), { add: [], skip: [] });
});

console.log(`\n${pass} passed`);
