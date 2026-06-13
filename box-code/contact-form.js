"use strict";
// contact-form.js
// ---------------------------------------------------------------------------------------
// Step 2 of the contact-form reply build: parse a Shopify contact-form notification and
// ENRICH it into a structure the confirmed-To UI (Step 3) and the send path (Step 4) can use.
//
// Pipeline (all READ-ONLY against business systems; writes nothing anywhere):
//   1. Fetch the message's raw HTML (structural parse beats Exchange's text rendering);
//      fall back to the stored plain text if the fetch fails.
//   2. Parse it deterministically (contact-form-parser) -> {countryCode,name,email,phone,message,orderRef}.
//   3. Resolve the customer via resolve-customer using the parsed email + any order ref, on the
//      TRUSTED side (SAP/Shopify). This is enrichment only.
//   4. Build the candidate address set and the default recipient.
//
// SECURITY (the invariant that makes this safe):
//   * The parsed email is a CANDIDATE recipient only. This module NEVER sets w.recipient and
//     NEVER sends. The recipient is chosen by a human in Step 3 and validated by
//     resolve-customer.pickRecipient against THIS candidate set before any Step-4 send.
//   * Per Brad's decision: the DEFAULT recipient is the form-typed address (what the customer
//     wrote from); the customer's SAP/Shopify addresses are added to the set as pickable
//     alternatives, shown for context. The default is still human-confirmed before sending.
//   * The free-text Message is data, never instruction. The model never receives any address
//     from here (the draft greets the parsed Name; addresses live only in this record + code).

const { parseContactForm } = require("./contact-form-parser.js");
const RC = require("./resolve-customer.js");          // safe to require (lazy-loads mssql)

// Default dependencies for the box runtime. connectors.js is lazy-required so this module can
// be unit-tested without the mssql driver present.
function defaultDeps() {
  return {
    getMessageHtml: (mailbox, id) => require("./connectors.js").getMessageHtml(mailbox, id),
    resolveCustomer: (identifiers) => RC.resolveCustomer(identifiers),   // default SAP/Shopify deps
  };
}

// Collect the SAP/Shopify addresses a resolver result exposes (resolved customer, else any
// candidates). Only ever addresses the resolver itself produced from trusted reads.
function resolverAddresses(res) {
  if (!res) return [];
  if (res.customer && Array.isArray(res.customer.sendableAddresses)) return res.customer.sendableAddresses;
  const out = [];
  for (const c of res.candidates || []) for (const a of c.sendableAddresses || []) out.push(a);
  return out;
}

function summariseResolved(res) {
  if (!res) return { matched: false, matched_via: "none", message: "No identifier to resolve." };
  if (res.customer) {
    const c = res.customer;
    return {
      matched: true,
      matched_via: res.matched_via || null,
      cardCode: c.cardCode || null,
      name: c.name || null,
      contactName: c.contactName || null,
      country: c.country || null,
      language_hint: c.language_hint || null,
      frozen: Boolean(c.frozen),
      knownAccount: Boolean(c.knownAccount),
      phone: c.phone || null,
      sapAddresses: c.sendableAddresses || [],
      needsAddressPick: Boolean(res.needsAddressPick),
      notes: c.notes || [],
      context: c.context || null,
    };
  }
  return {
    matched: false,
    matched_via: res.matched_via || "not_found",
    message: res.message || null,
    candidates: (res.candidates || []).map((c) => ({
      cardCode: c.cardCode || null, name: c.name || null, country: c.country || null,
      email: c.email || (c.sendableAddresses || [])[0] || null, sendableAddresses: c.sendableAddresses || [],
      frozen: Boolean(c.frozen), reason: c.reason || null,
    })),
  };
}

// Build the enriched contact-form record for one ingested message.
//   email   - the mapped message ({ id, from, subject, text, ... }) from connectors
//   mailbox - the Graph mailbox address (env-resolved) for the HTML re-fetch
//   deps    - { getMessageHtml, resolveCustomer } (injectable for tests)
async function buildContactForm(email, mailbox, deps) {
  deps = deps || defaultDeps();

  // 1. raw HTML (structural) with text fallback.
  let html = "";
  try { html = await deps.getMessageHtml(mailbox, email.id); } catch (e) { html = ""; }
  const usableHtml = html && /class="form-section"|<pre\b/i.test(html);
  const body = usableHtml ? html : (email.text || "");
  const source = usableHtml ? "html" : "text";

  // 2. deterministic parse.
  const parsed = parseContactForm(body);

  // 3. resolve (enrichment) from the parsed email + any order ref.
  const identifiers = [parsed.email, parsed.orderRef].filter(Boolean);
  let res = null;
  if (identifiers.length) {
    try { res = await deps.resolveCustomer(identifiers); } catch (e) { res = null; }
  }
  const resolved = summariseResolved(res);

  // 4. language: SAP country (authoritative for a known customer) else the form's country code.
  const country = (resolved.matched && resolved.country) || parsed.countryCode || null;
  const language = RC.countryLang(country);

  // candidate set: form-typed address FIRST (the default), then the customer's on-file
  // addresses as pickable alternatives; de-duplicated; only ever real, parsed/SAP addresses.
  const candidateAddresses = [...new Set([parsed.email, ...resolverAddresses(res)].filter(Boolean))];
  const defaultRecipient = parsed.email || "";   // "" forces an explicit human pick in Step 3

  return {
    parsed,                 // {countryCode,name,email,phone,message,orderRef,templateLang,isContactForm}
    language,               // outbound language for the draft (country map)
    defaultRecipient,       // form-typed default (human-confirmed before any send)
    candidateAddresses,     // the set pickRecipient will validate against in Step 4
    resolved,               // enrichment summary for the confirmed-To UI (Step 3)
    source,                 // 'html' | 'text' (which body the parse used)
    identifiers,            // what we resolved on (transparency)
  };
}

module.exports = { buildContactForm, summariseResolved, resolverAddresses, defaultDeps };
