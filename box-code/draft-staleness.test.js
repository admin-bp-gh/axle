// draft-staleness.test.js - the superseded-draft test. Run: node draft-staleness.test.js
const assert = require("assert");
const { isSupersededDraft, parseUtc } = require("./draft-staleness.js");

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };

const item = (o = {}) => ({ origin: "inbound", email_received: "2026-08-14T15:34:29Z", ...o });
const draft = (created_at) => ({ created_at, body: "x" });

console.log("draft-staleness");

test("item 1308: draft from the earlier round is superseded", () => {
  // The real numbers: draft v3 at 14:06:33 UTC, the "package was in my mailbox now" email at 15:34:29Z.
  assert.strictEqual(isSupersededDraft(item(), draft("2026-08-14 14:06:33")), true);
});

test("a draft written after the email is current", () => {
  assert.strictEqual(isSupersededDraft(item(), draft("2026-08-14 15:36:10")), false);
});

test("SQLite timestamps are read as UTC, not local time", () => {
  // Same instant on both sides. If created_at were parsed as local time, a box on CEST (UTC+2)
  // would read it as 13:34:29Z and wrongly call every fresh draft superseded.
  assert.strictEqual(isSupersededDraft(item(), draft("2026-08-14 15:34:29")), false);
  assert.strictEqual(parseUtc("2026-08-14 15:34:29"), Date.parse("2026-08-14T15:34:29Z"));
});

test("one second either side of the email", () => {
  assert.strictEqual(isSupersededDraft(item(), draft("2026-08-14 15:34:28")), true);
  assert.strictEqual(isSupersededDraft(item(), draft("2026-08-14 15:34:30")), false);
});

test("compose items have no inbound email and are never superseded", () => {
  assert.strictEqual(isSupersededDraft(item({ origin: "compose", email_received: null }), draft("2020-01-01 00:00:00")), false);
  // Even if a compose item somehow carried a received stamp, origin decides.
  assert.strictEqual(isSupersededDraft(item({ origin: "compose" }), draft("2026-08-14 14:06:33")), false);
});

test("unparseable or missing timestamps keep the existing behaviour (not stale)", () => {
  assert.strictEqual(isSupersededDraft(item({ email_received: null }), draft("2026-08-14 14:06:33")), false);
  assert.strictEqual(isSupersededDraft(item({ email_received: "" }), draft("2026-08-14 14:06:33")), false);
  assert.strictEqual(isSupersededDraft(item({ email_received: "not a date" }), draft("2026-08-14 14:06:33")), false);
  assert.strictEqual(isSupersededDraft(item(), draft(null)), false);
  assert.strictEqual(isSupersededDraft(item(), draft("nonsense")), false);
});

test("missing rows are safe", () => {
  assert.strictEqual(isSupersededDraft(null, draft("2026-08-14 14:06:33")), false);
  assert.strictEqual(isSupersededDraft(item(), null), false);
  assert.strictEqual(isSupersededDraft(item(), undefined), false);
});

test("an item with no origin recorded still gets the test", () => {
  // origin defaults to 'inbound' in the schema; treat an absent value the same way.
  assert.strictEqual(isSupersededDraft(item({ origin: null }), draft("2026-08-14 14:06:33")), true);
});

test("ISO created_at (should it ever be written that way) parses too", () => {
  assert.strictEqual(isSupersededDraft(item(), draft("2026-08-14T14:06:33Z")), true);
});

console.log(`\n${pass} passed`);
