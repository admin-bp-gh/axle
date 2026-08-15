// acknowledgement.test.js - the no_reply courtesy line: when it is offered, and what may be in it.
// Run: node acknowledgement.test.js
const assert = require("assert");
const { shouldAcknowledge, isCourtesyOnly, keepAcknowledgement, MAX_CHARS } = require("./acknowledgement.js");

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };

console.log("acknowledgement — policy (were we in this exchange?)");

test("a reopened item qualifies", () => {
  assert.strictEqual(shouldAcknowledge({ isReopen: true, priorSends: 0 }), true);
});

test("a recorded send qualifies even on a first pass", () => {
  assert.strictEqual(shouldAcknowledge({ isReopen: false, priorSends: 1 }), true);
});

test("first contact with no send does not", () => {
  assert.strictEqual(shouldAcknowledge({ isReopen: false, priorSends: 0 }), false);
  assert.strictEqual(shouldAcknowledge({}), false);
  assert.strictEqual(shouldAcknowledge(), false);
});

console.log("\nacknowledgement — content (is it really just good manners?)");

// The reply item 1308 should have offered.
const ack1308 = `Hans Petter,

Great to hear it turned up — thanks for letting us know, and sorry for the delay on PostNL's side.

Have a good weekend.

Kind regards,
Team Budget Parts`;

const ackNl = `Beste Jeroen,

Fijn om te horen dat het is opgelost, en bedankt voor het laten weten.

Met vriendelijke groet,
Team Budget Parts`;

test("the courtesy lines we want are allowed", () => {
  assert.strictEqual(isCourtesyOnly(ack1308), true);
  assert.strictEqual(isCourtesyOnly(ackNl), true);
});

test("empty is not an acknowledgement", () => {
  assert.strictEqual(isCourtesyOnly(""), false);
  assert.strictEqual(isCourtesyOnly("   \n  "), false);
  assert.strictEqual(isCourtesyOnly(null), false);
  assert.strictEqual(isCourtesyOnly(undefined), false);
});

test("anything longer than a courtesy line is refused", () => {
  assert.strictEqual(isCourtesyOnly("Thanks for letting us know. ".repeat(30).slice(0, MAX_CHARS + 1)), false);
});

test("promises of future action are refused (EN + NL)", () => {
  assert.strictEqual(isCourtesyOnly("Thanks for confirming. We will send the replacement tomorrow."), false);
  assert.strictEqual(isCourtesyOnly("Thanks — we'll get that sorted for you."), false);
  assert.strictEqual(isCourtesyOnly("Bedankt voor het laten weten. Wij zullen het pakket opnieuw versturen."), false);
  assert.strictEqual(isCourtesyOnly("Fijn! We sturen morgen de nieuwe onderdelen."), false);
});

test("money, refunds and paperwork are refused", () => {
  assert.strictEqual(isCourtesyOnly("Glad it arrived. Your refund has been processed."), false);
  assert.strictEqual(isCourtesyOnly("Bedankt. De terugbetaling is in orde gemaakt."), false);
  assert.strictEqual(isCourtesyOnly("Thanks — the credit note follows."), false);
  assert.strictEqual(isCourtesyOnly("Good to hear. The invoice is attached."), false);
  assert.strictEqual(isCourtesyOnly("Great news. We have applied a €10 discount."), false);
});

test("shipping facts are refused — the parcel belongs on the normal drafting path", () => {
  assert.strictEqual(isCourtesyOnly("Glad it arrived. Here is the tracking link for the second parcel."), false);
  assert.strictEqual(isCourtesyOnly("Thanks. The barcode is LA843449235NL."), false);
});

test("lead times and deadlines are refused", () => {
  assert.strictEqual(isCourtesyOnly("Thanks. We will be in touch within 5 working days."), false);
  assert.strictEqual(isCourtesyOnly("Bedankt. U hoort binnen 3 werkdagen van ons."), false);
});

test("ordinary words that merely resemble the blocked ones still pass", () => {
  // "credit" only trips as "credit note"; "we were" is not "we will".
  assert.strictEqual(isCourtesyOnly("Thanks — credit where it is due, you spotted that faster than we did."), true);
  assert.strictEqual(isCourtesyOnly("Good to hear it is sorted. We were glad to help."), true);
  assert.strictEqual(isCourtesyOnly("Thanks for the update — glad all is well again."), true);
});

console.log("\nacknowledgement — the combined gate");

test("item 1308: reopened, prior send, courtesy text — kept", () => {
  assert.strictEqual(keepAcknowledgement(ack1308, { isReopen: true, priorSends: 1 }), true);
});

test("right text, but we were never in the exchange — dropped", () => {
  assert.strictEqual(keepAcknowledgement(ack1308, { isReopen: false, priorSends: 0 }), false);
});

test("right context, but the text makes a promise — dropped", () => {
  assert.strictEqual(keepAcknowledgement("Thanks! We will ship the replacement today.", { isReopen: true }), false);
});

test("no draft at all — nothing to keep", () => {
  assert.strictEqual(keepAcknowledgement("", { isReopen: true, priorSends: 3 }), false);
});

console.log(`\n${pass} passed`);
