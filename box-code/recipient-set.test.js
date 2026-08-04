"use strict";
// Tests for recipient-set.js — run: node recipient-set.test.js
//
// What matters here is not that the right addresses appear, but that the WRONG ones cannot. The
// address set is the menu a salesperson clicks without thinking; anything an attacker can get onto
// it is as good as a delivered redirect. So the poisoning cases below are the point of the file.
const test = require("node:test");
const assert = require("node:assert");
const RS = require("./recipient-set");

const { knownAddressesFor, pickKnown, defaultRecipient, activeRecipient, isRedirected } = RS;

const addrs = (entries) => entries.map((e) => e.addr);
const sourceOf = (entries, a) => (entries.find((e) => e.addr === a) || {}).source;

// Deps that would be a live SAP read in production.
const sapByEmail = (map) => ({ async addressesByEmail(e) { return map[e.toLowerCase()] || []; } });
const sapByCard = (map) => ({ async addressesByCardCode(c) { return map[c] || []; } });
const deadSap = { async addressesByEmail() { throw new Error("SAP down"); },
                  async addressesByCardCode() { throw new Error("SAP down"); } };

// ---- reply items -----------------------------------------------------------------------------

test("reply: the thread sender is always present and always first", async () => {
  const w = { sender_email: "Jan@Dekker4x4.nl", recipient: null };
  const e = await knownAddressesFor(w, "reply", sapByEmail({ "jan@dekker4x4.nl": ["sales@dekker4x4.nl"] }));
  assert.equal(e[0].addr, "jan@dekker4x4.nl", "sender leads the radio list");
  assert.equal(e[0].source, "sender");
  assert.equal(sourceOf(e, "sales@dekker4x4.nl"), "onfile");
});

test("reply: the sender is normalised, so a mixed-case thread cannot double-list him", async () => {
  const w = { sender_email: "Jan@Dekker4x4.nl", recipient: null };
  const e = await knownAddressesFor(w, "reply", sapByEmail({ "jan@dekker4x4.nl": ["JAN@dekker4x4.nl", "sales@dekker4x4.nl"] }));
  assert.deepEqual(addrs(e), ["jan@dekker4x4.nl", "sales@dekker4x4.nl"], "one entry per address, sender's label wins");
  assert.equal(sourceOf(e, "jan@dekker4x4.nl"), "sender");
});

test("reply: a dead SAP costs a radio option, never the item", async () => {
  const w = { sender_email: "jan@dekker4x4.nl", recipient: null };
  const e = await knownAddressesFor(w, "reply", deadSap);
  assert.deepEqual(addrs(e), ["jan@dekker4x4.nl"], "degrades to the sender alone");
});

test("reply: no deps at all still yields the sender", async () => {
  const e = await knownAddressesFor({ sender_email: "jan@dekker4x4.nl" }, "reply");
  assert.deepEqual(addrs(e), ["jan@dekker4x4.nl"]);
});

// ---- the poisoning cases: what must NOT reach the radio list ---------------------------------

test("a poisoned SAP contact NAME cannot become a radio option", async () => {
  // The resolver reads sendableAddresses only. A CardName of "Jan <attacker@evil.com>" is never
  // consulted here, so the attacker address has no route onto the menu.
  const w = { sender_email: "jan@dekker4x4.nl", recipient: null };
  const e = await knownAddressesFor(w, "reply", sapByEmail({ "jan@dekker4x4.nl": ["sales@dekker4x4.nl"] }));
  assert.ok(!addrs(e).some((a) => a.includes("evil.com")), "no attacker address on the menu");
  assert.deepEqual(addrs(e), ["jan@dekker4x4.nl", "sales@dekker4x4.nl"]);
});

test("an address the resolver never produced is rejected by pickKnown", async () => {
  const e = await knownAddressesFor({ sender_email: "jan@dekker4x4.nl" }, "reply", sapByEmail({}));
  assert.equal(pickKnown(e, "attacker@evil.com"), "", "out-of-set pick rejected with no fallback");
  assert.equal(pickKnown(e, "jan@dekker4x4.nl"), "jan@dekker4x4.nl");
});

test("pickKnown is case-insensitive but never invents an address", async () => {
  const e = await knownAddressesFor({ sender_email: "jan@dekker4x4.nl" }, "reply", sapByEmail({}));
  assert.equal(pickKnown(e, "  JAN@Dekker4x4.NL  "), "jan@dekker4x4.nl");
  assert.equal(pickKnown(e, ""), "");
  assert.equal(pickKnown(e, null), "");
  assert.equal(pickKnown([], "jan@dekker4x4.nl"), "");
});

test("a typed override is displayed but is NOT a known address you can re-pick", async () => {
  // It shows in the UI so the operator sees what is selected; pickKnown still refuses it, so the
  // free-text path (acceptTypedRecipient) stays the only way an off-set address is ever accepted.
  const w = { sender_email: "jan@dekker4x4.nl", recipient: "jan@gmail.com", recipient_source: "typed" };
  const e = await knownAddressesFor(w, "reply", sapByEmail({}));
  assert.equal(sourceOf(e, "jan@gmail.com"), "typed");
  assert.equal(pickKnown(e, "jan@gmail.com"), "", "mode=known cannot launder a typed address");
});

// ---- contact-form items ----------------------------------------------------------------------

test("contactform: the form-typed address is labelled 'form', the rest 'onfile'", async () => {
  const w = { contact_form_json: JSON.stringify({
    parsed: { email: "buyer@example.com" },
    candidateAddresses: ["buyer@example.com", "sales@newcraft.nl"],
    defaultRecipient: "buyer@example.com",
  }) };
  const e = await knownAddressesFor(w, "contactform");
  assert.equal(sourceOf(e, "buyer@example.com"), "form");
  assert.equal(sourceOf(e, "sales@newcraft.nl"), "onfile");
});

test("contactform: a corrupt JSON blob yields an empty set, not a throw", async () => {
  const e = await knownAddressesFor({ contact_form_json: "{ not json" }, "contactform");
  assert.deepEqual(e, []);
});

// ---- return items ------------------------------------------------------------------------------

test("return: candidates come from the stored resolver set", async () => {
  const w = { return_json: JSON.stringify({ candidateAddresses: ["kees@vanloon.nl"], defaultRecipient: "kees@vanloon.nl" }) };
  const e = await knownAddressesFor(w, "return");
  assert.deepEqual(addrs(e), ["kees@vanloon.nl"]);
  assert.equal(e[0].source, "onfile");
});

// ---- compose items -----------------------------------------------------------------------------

test("compose: on-file addresses are re-read by CardCode, since compose_customer holds none", async () => {
  const w = { recipient: "sales@dekker4x4.nl", compose_customer: JSON.stringify({ cardCode: "K107034" }) };
  const e = await knownAddressesFor(w, "compose", sapByCard({ K107034: ["sales@dekker4x4.nl", "jan@dekker4x4.nl"] }));
  assert.deepEqual(addrs(e), ["sales@dekker4x4.nl", "jan@dekker4x4.nl"]);
  assert.ok(e.every((x) => x.source === "onfile"));
});

test("compose: a dead SAP still leaves the resolver-chosen recipient pickable", async () => {
  const w = { recipient: "sales@dekker4x4.nl", compose_customer: JSON.stringify({ cardCode: "K107034" }) };
  const e = await knownAddressesFor(w, "compose", deadSap);
  assert.deepEqual(addrs(e), ["sales@dekker4x4.nl"], "safety net, so the item is never un-sendable");
});

test("compose: a typed recipient is not laundered into the on-file safety net", async () => {
  const w = { recipient: "jan@gmail.com", recipient_source: "typed", compose_customer: JSON.stringify({ cardCode: "K107034" }) };
  const e = await knownAddressesFor(w, "compose", sapByCard({ K107034: ["sales@dekker4x4.nl"] }));
  assert.equal(sourceOf(e, "jan@gmail.com"), "typed");
  assert.equal(sourceOf(e, "sales@dekker4x4.nl"), "onfile");
  assert.equal(pickKnown(e, "jan@gmail.com"), "");
});

// ---- default / active / redirected --------------------------------------------------------------

test("reply: default is the sender; active falls back to it; no pill when untouched", () => {
  const w = { sender_email: "jan@dekker4x4.nl", recipient: null };
  assert.equal(defaultRecipient(w, "reply"), "jan@dekker4x4.nl");
  assert.equal(activeRecipient(w, "reply"), "jan@dekker4x4.nl");
  assert.equal(isRedirected(w, "reply"), false);
});

test("reply: an override to a different address raises the pill", () => {
  const w = { sender_email: "jan@dekker4x4.nl", recipient: "jan@gmail.com", recipient_source: "typed" };
  assert.equal(activeRecipient(w, "reply"), "jan@gmail.com");
  assert.equal(isRedirected(w, "reply"), true);
});

test("reply: an override back to the sender's own address raises no pill", () => {
  const w = { sender_email: "jan@dekker4x4.nl", recipient: "Jan@Dekker4x4.nl" };
  assert.equal(isRedirected(w, "reply"), false, "same address, different case, is not a redirect");
});

test("contactform: the pill tracks the resolver's default, not the sender (Shopify's mailer)", () => {
  const w = { sender_email: "mailer@shopify.com",
    contact_form_json: JSON.stringify({ candidateAddresses: ["a@b.nl", "c@d.nl"], defaultRecipient: "a@b.nl" }),
    recipient: "c@d.nl" };
  assert.equal(defaultRecipient(w, "contactform"), "a@b.nl");
  assert.equal(isRedirected(w, "contactform"), true);
  assert.equal(isRedirected({ ...w, recipient: "a@b.nl" }, "contactform"), false);
});

test("compose: the chosen recipient is never itself a redirect", () => {
  const w = { recipient: "sales@dekker4x4.nl", compose_customer: "{}" };
  assert.equal(isRedirected(w, "compose"), false, "compose has no default to deviate from");
});

test("an unknown kind is a programming error, not a silent empty set", async () => {
  await assert.rejects(() => knownAddressesFor({}, "sms"), /unknown item kind/);
});
