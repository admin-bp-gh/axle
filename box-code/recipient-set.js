"use strict";
// recipient-set.js - THE single definition of "what counts as a known address" for a work item.
//
// Three call sites need this answer and they must never disagree: the item page (to render the
// recipient radios), POST /item/:id/recipient (to validate a picked address), and the tests. Three
// implementations of this question is how the editable-recipient feature would rot.
//
// SECURITY. The address set is assembled ONLY from:
//   * the inbound thread's own sender address;
//   * addresses the deterministic resolver produced for THIS item's customer (SAP/Shopify contact
//     records reached via a CardCode or the sender address, never via anything in the email body);
//   * for a contact-form item, the address the customer typed into OUR OWN form at submission;
//   * for a reply to mail sent by one of OUR OWN mailboxes (15 Oct 2026): that mailbox itself
//     ('internal', the colleague's reply path) and, when the mail carries a forwarded customer
//     email, the original sender read deterministically from the forwarded header block
//     (send-guard.ownMailCase over forwarded-origin.js). That address is the one entry that comes
//     from an email body. It is admitted only because the mail was sent by our own mailbox, it is
//     tagged 'forwarded' and shown with the amber "not on file" pill unless the resolver holds it
//     for a customer (then it is 'onfile'), and nothing sends it without a human pressing Send.
// No other email body text, no tool result and no model output can add an entry here. A poisoned SAP contact
// record can put an attacker address in a NAME field; it cannot put one in this set, because only
// the resolver's sendableAddresses are read, never free-text name columns.
//
// A free-text typed address never enters through this module. It reaches work_items.recipient only
// via send-guard.acceptTypedRecipient, from a human's keystrokes, and is surfaced here afterwards
// (tagged 'typed') purely so the UI can show the operator what is currently selected.
//
// This module is PURE apart from the two injected lookups, so it unit-tests without SAP.

// The four item kinds. The caller classifies (server.js/routes already own isContactFormItem etc.)
// and passes the kind in, so this module never re-implements that test either.
const KINDS = ["reply", "compose", "contactform", "return"];
const SG = require("./send-guard.js");   // ownMailCase and replyDefault: pure, no IO

function norm(a) { return String(a == null ? "" : a).trim().toLowerCase(); }
function parseJson(s) { try { return JSON.parse(s || "null"); } catch (e) { return null; } }

// First occurrence of an address wins its label. Order is meaningful: it is the radio order, and
// entry 0 is what the UI highlights first.
function dedupe(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    if (!e.addr || seen.has(e.addr)) continue;
    seen.add(e.addr);
    out.push(e);
  }
  return out;
}

// The address a send would use with NO override in place. The "changed" pill compares against this.
//   reply  -> the thread sender, or the forwarded customer (send-guard.replyDefault, the send's fallback)
//   others -> the resolver's own default, if it produced exactly one obvious address
function defaultRecipient(w, kind) {
  if (kind === "reply") return norm(SG.replyDefault(w));
  if (kind === "contactform") { const cf = parseJson(w.contact_form_json); return norm(cf && cf.defaultRecipient); }
  if (kind === "return") { const rn = parseJson(w.return_json); return norm(rn && rn.defaultRecipient); }
  return "";   // compose: there is no default; the recipient was chosen at creation
}

// What a send would actually use right now.
function activeRecipient(w, kind) {
  return norm(w.recipient) || (kind === "reply" ? defaultRecipient(w, kind) : "");
}

// True when the active recipient differs from the untouched default - drives the amber pill.
function isRedirected(w, kind) {
  const active = activeRecipient(w, kind);
  if (!active) return false;
  const def = defaultRecipient(w, kind);
  return def ? active !== def : Boolean(norm(w.recipient)) && kind !== "compose";
}

// deps.addressesByEmail(email)     -> Promise<string[]>  (resolver sendableAddresses for a sender)
// deps.addressesByCardCode(card)   -> Promise<string[]>  (resolver sendableAddresses for a CardCode)
// Both are best-effort: a lookup failure degrades the set, it never throws out of here. A slow or
// dead SAP must cost the operator a radio option, not the ability to open the item.
//
// Returns [{ addr, source }] with source in 'sender' | 'onfile' | 'form' | 'forwarded' | 'internal' | 'typed'.
//
// NOTE on labels: resolve-customer.sendableAddresses does not carry per-address provenance (it
// merges OCRD E_Mail/U_E_Mail and the Shopify contact into one list), so on-file addresses are
// labelled 'onfile' rather than the brief's separate "on file, SAP" / "on file, Shopify". Splitting
// them would mean changing resolve-customer, which this build deliberately leaves untouched.
async function knownAddressesFor(w, kind, deps = {}) {
  if (!KINDS.includes(kind)) throw new Error(`unknown item kind: ${kind}`);
  const entries = [];
  const push = (addr, source) => { const a = norm(addr); if (a) entries.push({ addr: a, source }); };
  const typed = norm(w.recipient_source) === "typed";

  if (kind === "contactform") {
    const cf = parseJson(w.contact_form_json);
    const formAddr = norm(cf && cf.parsed && cf.parsed.email);
    for (const a of (cf && cf.candidateAddresses) || []) push(a, norm(a) === formAddr ? "form" : "onfile");

  } else if (kind === "return") {
    const rn = parseJson(w.return_json);
    for (const a of (rn && rn.candidateAddresses) || []) push(a, "onfile");

  } else if (kind === "compose") {
    // compose_customer is deliberately address-free (the model must never see a recipient), so the
    // on-file set is re-read from the resolver by CardCode. The stored recipient is added as a
    // safety net when it was resolver-produced, so a SAP hiccup can't leave the item with no radio.
    if (!typed) push(w.recipient, "onfile");
    const cc = parseJson(w.compose_customer);
    if (cc && cc.cardCode && deps.addressesByCardCode) {
      try { for (const a of await deps.addressesByCardCode(cc.cardCode)) push(a, "onfile"); } catch (e) { /* best-effort */ }
    }

  } else if (SG.ownMailCase(w)) {   // a reply to mail from one of our own mailboxes
    const own = SG.ownMailCase(w);
    if (own.customer) {
      let onfile = [];
      if (deps.addressesByEmail) {
        try { onfile = (await deps.addressesByEmail(own.customer.addr)).map(norm); } catch (e) { /* best-effort */ }
      }
      push(own.customer.addr, onfile.includes(norm(own.customer.addr)) ? "onfile" : "forwarded");
      for (const a of onfile) push(a, "onfile");
    }
    push(w.sender_email, "internal");

  } else {   // reply
    push(w.sender_email, "sender");
    if (w.sender_email && deps.addressesByEmail) {
      try { for (const a of await deps.addressesByEmail(w.sender_email)) push(a, "onfile"); } catch (e) { /* best-effort */ }
    }
  }

  // A typed override is not part of the known set - it is shown last, tagged, so the operator can
  // see what is selected and switch back. It is never silently promoted to 'onfile'.
  if (w.recipient && !entries.some((e) => e.addr === norm(w.recipient))) push(w.recipient, typed ? "typed" : "onfile");

  return dedupe(entries);
}

// The membership test the route uses for mode=known. Case-insensitive; returns the clean address
// or "" (never a fallback). Mirrors resolve-customer.pickRecipient's contract deliberately.
function pickKnown(entries, addr) {
  const a = norm(addr);
  if (!a) return "";
  return entries.some((e) => e.addr === a && e.source !== "typed") ? a : "";
}

// The production lookups: the deterministic resolver, nothing else. Required lazily so this module
// stays importable (and unit-testable) without opening a SAP connection pool.
function defaultDeps() {
  const RESOLVE = require("./resolve-customer.js");
  const addressesOf = async (identifier) => {
    const r = await RESOLVE.resolveCustomer(identifier);
    return (r && r.resolved && r.customer && r.customer.sendableAddresses) || [];
  };
  return { addressesByEmail: addressesOf, addressesByCardCode: addressesOf };
}

module.exports = { KINDS, knownAddressesFor, pickKnown, defaultRecipient, activeRecipient, isRedirected, norm, defaultDeps };
