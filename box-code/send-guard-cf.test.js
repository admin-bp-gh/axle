"use strict";
// Tests for send-guard.assembleContactFormSend — run: node --test send-guard-cf.test.js
// The new-outbound variant must reproduce every guarantee of assembleSend except: recipient is
// the CODE-HELD w.recipient (never the Shopify-mailer sender), the subject is fresh (no "Re:"),
// and there is NO quoted Shopify-mailer history.
const test = require("node:test");
const assert = require("node:assert");
const SG = require("./send-guard.js");

const base = {
  id: 7,
  sender_email: "mailer@shopify.com",      // the inbound "sender" is Shopify's mailer...
  sender_name: "Budget Parts (Shopify)",
  recipient: "customer@example.com",       // ...but the confirmed recipient is the real customer
  subject: "New customer message on 8 June 2026 at 15:10",
  email_text: "You received a new message from your online store's contact form. Country Code: NL ...",
  language: "nl",
  injection_flag: 0,
};

test("happy path: To = code-held recipient, fresh subject, body verbatim, no quoted history", () => {
  const p = SG.assembleContactFormSend(base, "Hallo Alan,\n\nDe TF534 is op voorraad: https://roverparts.eu/products/tf534\n\nGroet, RoverParts.eu", "S17562 - RoverParts.eu");
  assert.equal(p.to, "customer@example.com", "recipient is the confirmed customer, NOT the mailer");
  assert.notEqual(p.to, "mailer@shopify.com");
  assert.equal(p.subject, "S17562 - RoverParts.eu", "fresh subject, verbatim");
  assert.ok(!/^re\s*:/i.test(p.subject), "no Re: prefix on a new outbound");
  assert.deepEqual(p.cc, []); assert.deepEqual(p.bcc, []);
  assert.ok(p.html.includes("roverparts.eu/products/tf534"), "allowlisted URL rendered");
  assert.ok(!/border-left/.test(p.html), "no quoted-history blockquote");
  assert.ok(!p.html.includes("online store's contact form"), "Shopify wrapper never quoted back");
  assert.equal(p.sha256, SG.sha256("Hallo Alan,\n\nDe TF534 is op voorraad: https://roverparts.eu/products/tf534\n\nGroet, RoverParts.eu"));
});

test("injection-flagged item can never send", () => {
  assert.throws(() => SG.assembleContactFormSend({ ...base, injection_flag: 1 }, "hi", "subj"), /flagged/i);
});

test("no confirmed recipient is refused", () => {
  assert.throws(() => SG.assembleContactFormSend({ ...base, recipient: "" }, "hi", "subj"), /recipient/i);
  assert.throws(() => SG.assembleContactFormSend({ ...base, recipient: "not-an-email" }, "hi", "subj"), /recipient/i);
});

test("empty subject and empty body are refused", () => {
  assert.throws(() => SG.assembleContactFormSend(base, "hi", "   "), /subject/i);
  assert.throws(() => SG.assembleContactFormSend(base, "   ", "subj"), /empty/i);
});

test("off-allowlist URL in body is refused", () => {
  assert.throws(() => SG.assembleContactFormSend(base, "see http://evil.example.com/x", "subj"), /allowlist/i);
});

test("recipient is normalised lower-case; subject capped", () => {
  const p = SG.assembleContactFormSend({ ...base, recipient: "Customer@Example.COM" }, "body", "x".repeat(300));
  assert.equal(p.to, "customer@example.com");
  assert.equal(p.subject.length, 200);
});
