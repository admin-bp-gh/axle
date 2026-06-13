"use strict";
// Integration tests for contact-form.js — run: node --test contact-form.test.js
// Dependency-injected: no DB, no network. getMessageHtml + resolveCustomer are mocked so we
// test the enrichment/candidate-set/recipient-default logic deterministically.
const test = require("node:test");
const assert = require("node:assert");
const CF = require("./contact-form.js");

function htmlBody(rows) {
  const sections = rows
    .map(([label, val]) => `<div class="form-section"><b>${label}:</b> <pre style="white-space:pre-line">${val}</pre></div>`)
    .join("");
  return `<html><body><div class="primary-message">You received a new message from your online store's contact form.</div>${sections}<h2>You can enable spam filtering for contact forms in online store preferences.</h2></body></html>`;
}

const ALAN_HTML = htmlBody([
  ["Country Code", "NL"],
  ["Name", "Alan Rushe"],
  ["Email", "carushe@gmail.com"],
  ["Phone", "+358401542137"],
  ["Message", "Order #S17562\r\nCan I return the alternator and get the left-hand one?"],
]);

const COLD_HTML = htmlBody([
  ["Country Code", "FR"],
  ["Name", "Bernard Lambert"],
  ["Email", "lamber55@orange.fr"],
  ["Phone", "0677292855"],
  ["Message", "Bonjour, j'ai besoin d'une pièce."],
]);

const NOEMAIL_HTML = htmlBody([
  ["Country Code", "NO"],
  ["Name", "Fredrik Kvalvik"],
  ["Email", "not-an-email"],
  ["Phone", "+4741764945"],
  ["Message", "Order #S17726 — I forgot to add a part."],
]);

// resolver result builders (resolve-customer envelopes) --------------------------------
function matched(customer) { return { resolved: true, matched_via: "email", customer, candidates: [], needsAddressPick: (customer.sendableAddresses || []).length > 1 }; }
function notFound() { return { resolved: false, matched_via: "not_found", customer: null, candidates: [], needsAddressPick: false }; }

const email = (html) => ({ id: "MSG1", from: { address: "mailer@shopify.com", name: "Budget Parts (Shopify)" }, subject: "New customer message", text: "" });

test("known customer: form-typed default, SAP address pickable, NL language", async () => {
  let seenIds = null;
  const cf = await CF.buildContactForm(email(), "info@budget-parts.nl", {
    getMessageHtml: async () => ALAN_HTML,
    resolveCustomer: async (ids) => { seenIds = ids; return matched({
      cardCode: "K127177", name: "BV Newcraft", country: "NL", language_hint: "nl",
      knownAccount: true, frozen: false, phone: "+31...", sendableAddresses: ["carushe@gmail.com", "sales@newcraft.nl"], notes: [], context: null,
    }); },
  });
  assert.equal(cf.parsed.email, "carushe@gmail.com");
  assert.equal(cf.parsed.orderRef, "S17562");
  assert.deepEqual(seenIds, ["carushe@gmail.com", "S17562"], "resolver gets email + order ref");
  assert.equal(cf.defaultRecipient, "carushe@gmail.com", "default = form-typed address");
  assert.deepEqual(cf.candidateAddresses, ["carushe@gmail.com", "sales@newcraft.nl"], "form-typed first, SAP pickable");
  assert.equal(cf.language, "nl");
  assert.equal(cf.resolved.matched, true);
  assert.equal(cf.resolved.cardCode, "K127177");
  assert.equal(cf.source, "html");
});

test("cold prospect (no SAP record): only the form-typed address, language from form country", async () => {
  const cf = await CF.buildContactForm(email(), "info@budget-parts.nl", {
    getMessageHtml: async () => COLD_HTML,
    resolveCustomer: async () => notFound(),
  });
  assert.equal(cf.defaultRecipient, "lamber55@orange.fr");
  assert.deepEqual(cf.candidateAddresses, ["lamber55@orange.fr"]);
  assert.equal(cf.language, "fr", "FR country -> french");
  assert.equal(cf.resolved.matched, false);
});

test("HTML fetch fails -> text fallback still parses + resolves", async () => {
  const e = email(); e.text = [
    "You received a new message from your online store's contact form.",
    "Country Code:", "", "NL", "", "Name:", "", "Alan Rushe", "",
    "Email:", "", "carushe@gmail.com", "", "Phone:", "", "+358401542137", "",
    "Message:", "", "Order #S17562", "Can I return it?", "",
    "You can enable spam filtering for contact forms in online store preferences.",
  ].join("\r\n");
  const cf = await CF.buildContactForm(e, "info@budget-parts.nl", {
    getMessageHtml: async () => { throw new Error("graph 500"); },
    resolveCustomer: async () => notFound(),
  });
  assert.equal(cf.source, "text");
  assert.equal(cf.parsed.email, "carushe@gmail.com");
  assert.equal(cf.parsed.orderRef, "S17562");
  assert.ok(!/spam filtering/i.test(cf.parsed.message), "footer stripped in fallback");
});

test("invalid form email + order ref: resolve via order, default forces a pick", async () => {
  let seenIds = null;
  const cf = await CF.buildContactForm(email(), "info@budget-parts.nl", {
    getMessageHtml: async () => NOEMAIL_HTML,
    resolveCustomer: async (ids) => { seenIds = ids; return matched({
      cardCode: "K90001", name: "Kvalvik AS", country: "NO", language_hint: "en",
      knownAccount: true, frozen: false, phone: null, sendableAddresses: ["fleet@kvalvik.no"], notes: [], context: null,
    }); },
  });
  assert.equal(cf.parsed.email, null, "invalid form email -> null");
  assert.deepEqual(seenIds, ["S17726"], "resolves on the order ref alone");
  assert.equal(cf.defaultRecipient, "", "no valid form email -> empty default forces human pick");
  assert.deepEqual(cf.candidateAddresses, ["fleet@kvalvik.no"], "SAP address is the only candidate");
  assert.equal(cf.language, "en", "NO country -> english");
  assert.equal(cf.resolved.matched, true);
});

test("never sets a recipient or sends — output is a record only", async () => {
  const cf = await CF.buildContactForm(email(), "info@budget-parts.nl", {
    getMessageHtml: async () => ALAN_HTML,
    resolveCustomer: async () => notFound(),
  });
  // The contract: no 'recipient' key is produced here; defaultRecipient is a *suggestion*.
  assert.equal(cf.recipient, undefined);
  assert.ok("defaultRecipient" in cf && "candidateAddresses" in cf);
});
