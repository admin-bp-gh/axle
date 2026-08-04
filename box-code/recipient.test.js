"use strict";
// Tests for the editable send recipient — run: node --test recipient.test.js
//
// Two units, both pure:
//   * acceptTypedRecipient — the screen every outbound To passes through. Its job is to stop a
//     free-text field from becoming a way to address mail to somebody else.
//   * assembleSend — the reply assembler, whose recipient is no longer hard-locked to the
//     thread sender but falls back to it.
//
// The header-injection cases are the point of this file. A single To field that accepts a comma,
// a semicolon or an angle bracket is a multi-recipient field wearing a disguise.
const test = require("node:test");
const assert = require("node:assert");
const SG = require("./send-guard.js");

const { acceptTypedRecipient: accept } = SG;

// A normal inbound reply item: sender known, nothing flagged, no recipient override.
const base = {
  id: 5,
  sender_email: "jan@dekker4x4.nl",
  sender_name: "Jan Dekker",
  subject: "Order 226574",
  email_text: "Hoi, wanneer wordt mijn order verzonden?",
  email_received: "2026-07-09T09:14:00Z",
  language: "nl",
  injection_flag: 0,
};
const BODY = "Hallo Jan,\n\nJe order gaat morgen weg.\n\nGroet, RoverParts.eu";

// An address of exactly N characters that is otherwise well-formed.
const addrOfLength = (n) => "a".repeat(n - "@example.com".length) + "@example.com";

// ---- acceptTypedRecipient: the rejects ------------------------------------------------------

test("rejects a second address smuggled after a comma", () => {
  assert.equal(accept("jan@dekker4x4.nl, attacker@evil.com"), "");
  assert.equal(accept("jan@dekker4x4.nl,attacker@evil.com"), "");
});

test("rejects a second address smuggled after a semicolon", () => {
  assert.equal(accept("jan@dekker4x4.nl; attacker@evil.com"), "");
  assert.equal(accept("jan@dekker4x4.nl;attacker@evil.com"), "");
});

test("rejects display-name / angle-bracket forms", () => {
  assert.equal(accept("Jan <jan@dekker4x4.nl>"), "");
  assert.equal(accept("<jan@dekker4x4.nl>"), "");
  assert.equal(accept('"Jan Dekker" <attacker@evil.com>'), "");
});

test("rejects the address EMAIL_RE alone would have let through", () => {
  // One '@', no whitespace — this satisfies /^[^\s@]+@[^\s@]+\.[^\s@]+$/ and would reach Graph
  // as something it may parse as two recipients. The character screen is what stops it, so if
  // this test ever goes green by accident the screen has been removed.
  assert.ok(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test("a@b.nl,cd.nl"), "precondition: the regex accepts it");
  assert.equal(accept("a@b.nl,cd.nl"), "", "the screen must reject it anyway");
});

test("rejects embedded newlines and tabs (header injection)", () => {
  assert.equal(accept("jan@dekker4x4.nl\nBcc: attacker@evil.com"), "");
  assert.equal(accept("jan@dekker4x4.nl\r\nBcc: attacker@evil.com"), "");
  assert.equal(accept("jan\t@dekker4x4.nl"), "");
  assert.equal(accept("jan @dekker4x4.nl"), "", "internal whitespace is fatal");
});

test("rejects malformed addresses", () => {
  assert.equal(accept("a@b"), "", "no TLD dot");
  assert.equal(accept("nodomain"), "");
  assert.equal(accept("@example.com"), "");
  assert.equal(accept("two@at@example.com"), "");
});

test("rejects empty and non-string input without throwing", () => {
  assert.equal(accept(""), "");
  assert.equal(accept("   "), "");
  assert.equal(accept(null), "");
  assert.equal(accept(undefined), "");
  assert.equal(accept(42), "");
  assert.equal(accept({}), "");
});

test("rejects an over-long address at the RFC 5321 boundary", () => {
  assert.equal(accept(addrOfLength(300)), "", "300 chars");
  assert.equal(accept(addrOfLength(255)), "", "255 chars — one over");
  assert.equal(accept(addrOfLength(254)), addrOfLength(254), "254 chars — the maximum, accepted");
});

// ---- acceptTypedRecipient: the accepts ------------------------------------------------------

test("trims surrounding whitespace rather than rejecting it", () => {
  // Decision (Brad, 2026-07-10): a pasted address routinely carries surrounding whitespace, and
  // once trimmed it is unambiguously the address the human meant. Internal whitespace stays fatal.
  assert.equal(accept("  jan@dekker4x4.nl  "), "jan@dekker4x4.nl");
  assert.equal(accept("\tjan@dekker4x4.nl\n"), "jan@dekker4x4.nl");
});

test("lowercases, so the sends dedup index sees one address not two", () => {
  assert.equal(accept("JAN@Dekker4x4.NL"), "jan@dekker4x4.nl");
  assert.equal(accept("Jan.Dekker@Dekker4x4.nl"), "jan.dekker@dekker4x4.nl");
});

test("accepts the ordinary shapes a salesperson will actually type", () => {
  assert.equal(accept("jan@dekker4x4.nl"), "jan@dekker4x4.nl");
  assert.equal(accept("jan.de-vries+parts@sub.dekker4x4.co.uk"), "jan.de-vries+parts@sub.dekker4x4.co.uk");
  assert.equal(accept("j@d.nl"), "j@d.nl");
});

// ---- assembleSend: recipient precedence -----------------------------------------------------

test("no recipient set → replies to the thread sender (unchanged default behaviour)", () => {
  assert.equal(SG.assembleSend(base, BODY).to, "jan@dekker4x4.nl");
  assert.equal(SG.assembleSend({ ...base, recipient: null }, BODY).to, "jan@dekker4x4.nl");
  assert.equal(SG.assembleSend({ ...base, recipient: "" }, BODY).to, "jan@dekker4x4.nl");
});

test("recipient set → it wins over the thread sender", () => {
  const p = SG.assembleSend({ ...base, recipient: "piet@dekker4x4.nl" }, BODY);
  assert.equal(p.to, "piet@dekker4x4.nl");
  assert.notEqual(p.to, base.sender_email);
});

test("recipient is trimmed and lowercased on the way out", () => {
  assert.equal(SG.assembleSend({ ...base, recipient: "  PIET@Dekker4x4.NL " }, BODY).to, "piet@dekker4x4.nl");
});

test("a redirected reply still quotes the ORIGINAL correspondent's message", () => {
  // Redirecting the reply must not rewrite history: the quoted block is still Jan's email, since
  // that is the message being replied to. Only the destination changed.
  const p = SG.assembleSend({ ...base, recipient: "piet@dekker4x4.nl" }, BODY);
  assert.ok(p.html.includes("Jan Dekker"), "quoted header names the original sender");
  assert.ok(p.html.includes("jan@dekker4x4.nl"), "quoted header carries the original address");
  assert.ok(p.html.includes("wanneer wordt mijn order verzonden"), "original text quoted");
  assert.equal(p.subject, "Re: Order 226574");
});

test("a tampered recipient column cannot smuggle a second address", () => {
  // Defence in depth: even if something wrote a bad address straight into work_items.recipient,
  // the send path re-screens it. The route is the first gate, not the only one.
  for (const bad of ["piet@dekker4x4.nl, attacker@evil.com", "Piet <attacker@evil.com>",
                     "piet@dekker4x4.nl\nBcc: attacker@evil.com", "a@b", addrOfLength(300)]) {
    assert.throws(() => SG.assembleSend({ ...base, recipient: bad }, BODY), /recipient/i, `must refuse: ${bad}`);
  }
});

test("no valid address anywhere → refused", () => {
  assert.throws(() => SG.assembleSend({ ...base, sender_email: "", recipient: "" }, BODY), /recipient/i);
  assert.throws(() => SG.assembleSend({ ...base, sender_email: "not-an-email", recipient: null }, BODY), /recipient/i);
});

test("a recipient rescues an item whose sender address is unusable", () => {
  const p = SG.assembleSend({ ...base, sender_email: "noreply@", recipient: "piet@dekker4x4.nl" }, BODY);
  assert.equal(p.to, "piet@dekker4x4.nl");
});

// ---- assembleSend: the guarantees that must NOT have moved ----------------------------------

test("an injection-flagged item can never send, with or without a recipient", () => {
  assert.throws(() => SG.assembleSend({ ...base, injection_flag: 1 }, BODY), /flagged/i);
  assert.throws(() => SG.assembleSend({ ...base, injection_flag: 1, recipient: "piet@dekker4x4.nl" }, BODY), /flagged/i);
});

test("the flagged refusal is checked BEFORE the recipient", () => {
  // Order matters: a flagged item with a broken recipient must report the flag, not the address,
  // so nobody "fixes" the address and tries again.
  assert.throws(() => SG.assembleSend({ ...base, injection_flag: 1, recipient: "junk" }, BODY), /flagged/i);
});

test("an off-allowlist URL is still refused, redirected or not", () => {
  const evil = "Hallo,\n\nZie https://evil.com/pay\n\nGroet";
  assert.throws(() => SG.assembleSend(base, evil), /allowlist/i);
  assert.throws(() => SG.assembleSend({ ...base, recipient: "piet@dekker4x4.nl" }, evil), /allowlist/i);
});

test("an allowlisted URL still renders, and the body is still sent verbatim", () => {
  const body = "Hallo Jan,\n\nhttps://roverparts.eu/products/tf534\n\nGroet";
  const p = SG.assembleSend({ ...base, recipient: "piet@dekker4x4.nl" }, body);
  assert.ok(p.html.includes("roverparts.eu/products/tf534"));
  assert.equal(p.text, body, "verbatim");
  assert.equal(p.sha256, SG.sha256(body), "integrity tie is over the body, not the recipient");
});

test("empty body is refused", () => {
  assert.throws(() => SG.assembleSend({ ...base, recipient: "piet@dekker4x4.nl" }, "   "), /empty/i);
});

test("still exactly one recipient — never CC or BCC", () => {
  const p = SG.assembleSend({ ...base, recipient: "piet@dekker4x4.nl" }, BODY);
  assert.deepEqual(p.cc, []);
  assert.deepEqual(p.bcc, []);
  assert.equal(typeof p.to, "string");
});

test("the sha256 does not depend on the recipient — same body, two addresses, same hash", () => {
  // This is what makes the widened (work_item_id, to_addr, body_sha256) dedup index necessary:
  // the hash alone cannot tell the two sends apart.
  const a = SG.assembleSend({ ...base, recipient: "jan@dekker4x4.nl" }, BODY);
  const b = SG.assembleSend({ ...base, recipient: "piet@dekker4x4.nl" }, BODY);
  assert.equal(a.sha256, b.sha256);
  assert.notEqual(a.to, b.to);
});

// ---- assembleNewOutboundSend: no sender fallback, same screen --------------------------------

test("new-outbound never falls back to the inbound sender", () => {
  // A contact-form item's sender_email is Shopify's mailer. If the recipient is missing the send
  // must refuse, not quietly mail the mailer.
  const cf = { id: 9, sender_email: "mailer@shopify.com", subject: "x", injection_flag: 0, recipient: "" };
  assert.throws(() => SG.assembleNewOutboundSend(cf, "hi", "subj"), /recipient/i);
});

test("new-outbound applies the same character screen", () => {
  const cf = { id: 9, sender_email: "mailer@shopify.com", subject: "x", injection_flag: 0 };
  assert.throws(() => SG.assembleNewOutboundSend({ ...cf, recipient: "a@b.nl, evil@x.com" }, "hi", "subj"), /recipient/i);
  assert.throws(() => SG.assembleNewOutboundSend({ ...cf, recipient: "Jan <evil@x.com>" }, "hi", "subj"), /recipient/i);
  assert.equal(SG.assembleNewOutboundSend({ ...cf, recipient: " PIET@Dekker4x4.NL " }, "hi", "subj").to, "piet@dekker4x4.nl");
});
