// thread-read.test.js - the whole-thread mark-read decision table. Run: node thread-read.test.js
const assert = require("assert");
const { planThreadRead, MAX_SIBLINGS } = require("./thread-read.js");

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };

const item = (o = {}) => ({ id: 1308, mailbox: "info", status: "done", latest_message_id: "newest", ...o });
const sib = (id, key) => ({ id, key: key || "customer@example.com|package damaged" });
// Default lookup: every key belongs to the item being closed.
const mine = () => ({ id: 1308, status: "done" });
const none = () => null;

console.log("thread-read");

test("item 1308: the earlier unread mail in the same thread is marked read", () => {
  const p = planThreadRead(item(), [sib("older")], mine);
  assert.deepStrictEqual(p.mark, ["older"]);
  assert.deepStrictEqual(p.skip, []);
});

test("the item's own newest message is never re-marked", () => {
  const p = planThreadRead(item(), [sib("newest"), sib("older")], mine);
  assert.deepStrictEqual(p.mark, ["older"]);
});

test("duplicates collapse", () => {
  const p = planThreadRead(item(), [sib("older"), sib("older")], mine);
  assert.deepStrictEqual(p.mark, ["older"]);
});

test("a sibling that maps to no work item is ours to mark", () => {
  // Mail Axle never ingested (arrived after the last sync, or filtered out) is still this
  // conversation's mail - nobody else is working it.
  assert.deepStrictEqual(planThreadRead(item(), [sib("older")], none).mark, ["older"]);
  assert.deepStrictEqual(planThreadRead(item(), [{ id: "nokey" }], none).mark, ["nokey"]);
});

test("THE GUARD: a different OPEN item's mail is left unread", () => {
  // A supplier or colleague writing into the same Outlook conversation is a separate Axle item.
  // Marking it read would hide live work, and with AXLE_ACTION_OUTLOOK_CLOSE on, close it.
  const lookup = (key) => (key === "supplier@allmakes.co.uk|package damaged" ? { id: 1400, status: "ready" } : mine());
  const p = planThreadRead(item(), [sib("mine2"), sib("theirs", "supplier@allmakes.co.uk|package damaged")], lookup);
  assert.deepStrictEqual(p.mark, ["mine2"]);
  assert.deepStrictEqual(p.skip, [{ id: "theirs", why: "open item #1400" }]);
});

test("a different CLOSED item's mail is marked read", () => {
  for (const status of ["done", "archived"]) {
    const p = planThreadRead(item(), [sib("theirs", "other|x")], () => ({ id: 1400, status }));
    assert.deepStrictEqual(p.mark, ["theirs"], status);
  }
});

test("every open status counts as open", () => {
  for (const status of ["new", "investigating", "awaiting_input", "ready"]) {
    const p = planThreadRead(item(), [sib("theirs", "other|x")], () => ({ id: 1400, status }));
    assert.deepStrictEqual(p.mark, [], status);
  }
});

test("the cap bounds one close to MAX_SIBLINGS patches", () => {
  const many = Array.from({ length: MAX_SIBLINGS + 5 }, (_, i) => sib("m" + i));
  const p = planThreadRead(item(), many, mine);
  assert.strictEqual(p.mark.length, MAX_SIBLINGS);
  assert.strictEqual(p.skip.length, 5);
  assert.ok(p.skip.every((s) => s.why === "cap"));
});

test("bad input is inert", () => {
  assert.deepStrictEqual(planThreadRead(null, [sib("older")], mine), { mark: [], skip: [] });
  assert.deepStrictEqual(planThreadRead(item(), null, mine), { mark: [], skip: [] });
  assert.deepStrictEqual(planThreadRead(item(), [null, { id: "" }], mine), { mark: [], skip: [] });
});

test("an item with no stored message id still plans its siblings", () => {
  assert.deepStrictEqual(planThreadRead(item({ latest_message_id: null }), [sib("older")], mine).mark, ["older"]);
});

console.log(`\n${pass} passed`);
