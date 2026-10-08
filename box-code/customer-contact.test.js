// customer-contact.test.js - the customer's contact details from OCRD (round 2, request 13):
// E_Mail and U_E_Mail may each hold several addresses; Phone1 and Phone2 are trimmed; empty
// values and repeats drop out. The address split is resolve-customer's splitEmails; a phone field
// may hold several numbers (phone-numbers.js splitPhones), and each gets a tel: target (telHref).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { contactLists } = require("./customer-summary.js");
const { splitPhones, telHref } = require("./phone-numbers.js");

test("several addresses per field, both fields, lower-cased and de-duplicated", () => {
  assert.deepStrictEqual(contactLists({ E_Mail: "Info@Klant.nl; inkoop@klant.nl", U_E_Mail: "info@klant.nl, boekhouding@klant.nl" }).emails,
    ["info@klant.nl", "inkoop@klant.nl", "boekhouding@klant.nl"]);
});

test("junk and empty values give nothing", () => {
  assert.deepStrictEqual(contactLists({ E_Mail: "geen email", U_E_Mail: null, Phone1: "  ", Phone2: null }), { emails: [], phones: [] });
});

test("phones trimmed, the same number once", () => {
  assert.deepStrictEqual(contactLists({ Phone1: " +31 6 1234 5678 ", Phone2: "+31 6 1234 5678" }).phones, ["+31 6 1234 5678"]);
  assert.deepStrictEqual(contactLists({ Phone1: "0182 123456", Phone2: "06 98765432" }).phones, ["0182 123456", "06 98765432"]);
});

test("a field with several numbers gives each; a Belgian slash stays one number", () => {
  assert.deepStrictEqual(splitPhones("010 123 4567 / 06 12345678"), ["010 123 4567", "06 12345678"]);
  assert.deepStrictEqual(splitPhones("0182-123456; +32 2 555 1234,06 98765432"), ["0182-123456", "+32 2 555 1234", "06 98765432"]);
  assert.deepStrictEqual(splitPhones("0612345678 of 0102345678\n0201234567 en 0301234567 or 0401234567"), ["0612345678", "0102345678", "0201234567", "0301234567", "0401234567"]);
  assert.deepStrictEqual(splitPhones("02/123.45.67"), ["02/123.45.67"]);
  assert.deepStrictEqual(contactLists({ Phone1: "06 1111 2222 / 06 3333 4444", Phone2: "06 3333 4444" }).phones, ["06 1111 2222", "06 3333 4444"]);
});

test("tel: targets", () => {
  assert.strictEqual(telHref("+31 (0)10 123 4567"), "+31101234567");
  assert.strictEqual(telHref("0031 (0)10-123.4567"), "0031101234567");
  assert.strictEqual(telHref("(010) 123 45 67"), "0101234567");
  assert.strictEqual(telHref("+49 4321 556677"), "+494321556677");
  assert.strictEqual(telHref("02/123.45.67"), "021234567");
  assert.strictEqual(telHref("12345"), null);
  assert.strictEqual(telHref("ask for Jan"), null);
  assert.strictEqual(telHref("+31 6 1234 5678 ext 12"), null);
  assert.strictEqual(telHref("1234567890123456"), null);
});
