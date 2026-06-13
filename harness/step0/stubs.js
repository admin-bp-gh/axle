// stubs.js - module-load interceptor + deterministic stubs for the Step-0 equivalence
// harness. Installed in the child BEFORE the server entry is required. Real modules:
// express, dotenv, db.js, rules.js, scenarios.js, send-guard.js, views/ui.js, routes/*.
// Stubbed (network/model/native): engine, connectors, send, translate, ingest,
// resolve-customer, compose, sap-doc-pdf, doc-suggest, @anthropic-ai/sdk, better-sqlite3.
"use strict";
const Module = require("module");
const path = require("path");
const fs = require("fs");

const NM = (process.env.AXLE_MIRROR || "/sessions/stoic-sweet-heisenberg/mnt/Axle/box-code") + "/node_modules";
const GATE = process.env.HARNESS_GATE || "";

// Async gate: when HARNESS_GATE is set, slow paths wait for a marker file so the
// battery can deterministically observe "investigating"/"syncing" renders.
async function waitGate(name) {
  if (!GATE) return;
  const f = path.join(GATE, name);
  for (let i = 0; i < 400; i++) {
    if (fs.existsSync(f)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("harness gate timeout: " + name);
}

// ---- better-sqlite3 -> node:sqlite adapter (covers exactly the API db.js uses) ----
const { DatabaseSync } = require("node:sqlite");
class Stmt {
  constructor(st) { this.st = st; }
  get(...a) { return this.st.get(...a); }
  all(...a) { return this.st.all(...a); }
  run(...a) { const r = this.st.run(...a); return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }; }
}
class BetterSqliteShim {
  constructor(p) { this._d = new DatabaseSync(p); }
  pragma(s) { try { this._d.exec("PRAGMA " + s); } catch (e) { /* ignore */ } return []; }
  exec(s) { this._d.exec(s); return this; }
  prepare(s) { return new Stmt(this._d.prepare(s)); }
}

// ---- deterministic business stubs --------------------------------------------------
const CUSTOMERS = {
  K127177: { cardCode: "K127177", name: "BV Newcraft", contactName: "Laurens Michiels", country: "BE", knownAccount: true, frozen: false, language_hint: "nl", sendableAddresses: ["laurens@yvesmichiels.be"], notes: ["VAT BE0123456789"] },
  K130312: { cardCode: "K130312", name: "Schotters GmbH", contactName: "Felicitas Schotters", country: "DE", knownAccount: true, frozen: false, language_hint: "de", sendableAddresses: ["felicitas@example.com"], notes: [] },
};

const stubResolve = {
  resolveCustomer: async (who) => {
    const k = String(who || "").trim();
    const lk = k.toLowerCase();
    if (CUSTOMERS[k]) return { resolved: true, matched_via: "card", needsAddressPick: false, message: "", customer: CUSTOMERS[k] };
    if (lk === "laurens@yvesmichiels.be") return { resolved: true, matched_via: "email", needsAddressPick: false, message: "", customer: CUSTOMERS.K127177 };
    if (lk === "felicitas@example.com") return { resolved: true, matched_via: "email", needsAddressPick: false, message: "", customer: CUSTOMERS.K130312 };
    if (lk === "multi") return {
      resolved: false, message: "2 matches - pick the customer", candidates: [
        { cardCode: "K127177", name: "BV Newcraft", contactName: "Laurens Michiels", email: "laurens@yvesmichiels.be", sendableAddresses: ["laurens@yvesmichiels.be"], country: "BE", frozen: false, reason: 'name contains "multi"' },
        { cardCode: "K130312", name: "Schotters GmbH", contactName: "Felicitas Schotters", email: "felicitas@example.com", sendableAddresses: ["felicitas@example.com"], country: "DE", frozen: false, reason: 'name contains "multi"' },
      ],
    };
    return { resolved: false, candidates: [], message: "No customer found (stub)" };
  },
  // Faithful copy of the recipient-gate contract (equivalence harness: both versions use
  // the SAME stub, so pre/post equality is what is proven here, not absolute behaviour).
  pickRecipient: (validAddrs, pickAddr) => {
    const set = (validAddrs || []).map((a) => String(a || "").trim().toLowerCase()).filter(Boolean);
    const pick = String(pickAddr || "").trim().toLowerCase();
    if (pick) return set.includes(pick) ? pick : "";
    if (set.length === 1) return set[0];
    return "";
  },
};

const stubEngine = {
  gatherSeed: async (email) => ({ stub_seed: true, subject: String(email.subject || "") }),
  agenticDraft: async (an, email) => {
    await waitGate("go-" + String(email.id || "none"));
    return {
      result: { status: "ready", language: "en", draft: "Stub redraft reply.", interim_draft: null, questions_for_salesperson: ["Stub question?"], physical_checks: [], confidence: "high", injection_suspected: false, referenced_documents: [{ type: "order", value: "224665" }] },
      toolLog: [{ ok: true, tool: "sap_query", purpose: "stub lookup", input: "SELECT 1" }],
    };
  },
};

const stubCompose = {
  sanitizeCustomerForModel: (c) => ({ name: c.name || null, contactName: c.contactName || null, cardCode: c.cardCode || null, country: c.country || null, knownAccount: c.knownAccount !== false, frozen: !!c.frozen, notes: c.notes || [], matched_via: "stub" }),
  composeDraft: async (an, opts) => {
    await waitGate("go-compose");
    return {
      result: { status: "ready", language: opts.language, draft: "Stub compose draft to " + ((opts.resolved && opts.resolved.customer && opts.resolved.customer.cardCode) || "?"), subject: "Stub subject", questions_for_salesperson: [], physical_checks: [], confidence: "high", injection_suspected: false },
      toolLog: [{ ok: true, tool: "sap_query", purpose: "stub", input: "SELECT 1" }],
      seed: { stub: true },
    };
  },
};

const stubSend = {
  sendReply: async (o) => ({ sentId: "graph-stub-1", threaded: o.originalMessageId != null }),
  markRead: async () => ({ ok: true }),
};

// cached() (UX round 2026-06-11): the sync cache-only lookup. The stub always
// misses, so harness renders exercise the new async-fill (pending-marker) path.
const stubTranslate = { translate: async (an, lang, text) => "«" + lang + "» " + String(text), cached: () => null };

const stubIngest = { runBoxes: async () => { await waitGate("go-sync"); } };

const stubConnectors = {
  getAttachment: async (mailbox, msgId, attId) => {
    if (attId !== "AAA") throw new Error("stub: attachment not found");
    return { name: "photo.jpg", contentType: "image/jpeg", size: 9, contentBytes: Buffer.from("img-bytes").toString("base64") };
  },
};

const DOC_TYPES = { order: { objectId: 17, table: "ORDR" }, invoice: { objectId: 13, table: "OINV" }, quotation: { objectId: 23, table: "OQUT" }, delivery: { objectId: 15, table: "ODLN" }, creditnote: { objectId: 14, table: "ORIN" } };
const PREFIX = { order: "Order", invoice: "Invoice", quotation: "Quotation", delivery: "Delivery", creditnote: "CreditNote" };
const stubSapDoc = {
  DOC_TYPES,
  docTypeInfo: (t) => ({ ...DOC_TYPES[t], prefix: PREFIX[t] }),
  resolveDocument: async (type, num) => {
    if (num === "226108") return { ok: true, candidates: [{ objectId: 17, docEntry: 90001, docNum: 226108, type: "Order", cardCode: "K130312", cardName: "Schotters GmbH", docTotal: 121.5, docCur: "EUR", docDate: "2026-06-02" }] };
    if (num === "226449") return { ok: true, candidates: [{ objectId: 17, docEntry: 90002, docNum: 226449, type: "Order", cardCode: "K118652", cardName: "Veenstra", docTotal: 80, docCur: "EUR", docDate: "2026-06-03" }] };
    if (num === "777") return {
      ok: true, candidates: [
        { objectId: 17, docEntry: 90011, docNum: 777, type: "Order", cardCode: "K130312", cardName: "Schotters GmbH", docTotal: 10, docCur: "EUR", docDate: "2026-05-01" },
        { objectId: 17, docEntry: 90012, docNum: 777, type: "Order", cardCode: "K000001", cardName: "Other BV", docTotal: 20, docCur: "EUR", docDate: "2026-05-02" },
      ],
    };
    return { ok: false, candidates: [] };
  },
  renderPdf: async (objectId, docEntry) => ({ ok: true, buffer: Buffer.from("%PDF-1.4 stub " + objectId + "/" + docEntry), bytes: 20 }),
  customerByEmail: async (email) => (String(email).toLowerCase() === "felicitas@example.com" ? { cardCode: "K130312", cardName: "Schotters GmbH" } : null),
};

const stubDocSuggest = {
  suggestForEmail: async (sender, text, opts) => {
    if (String(sender || "").toLowerCase() !== "felicitas@example.com") return [];
    const base = [
      { status: "in_scope", reference: { raw: "224665" }, docs: [{ objectId: 17, docEntry: 90021, docNum: 224665, type: "Order", cardCode: "K130312", cardName: "Schotters GmbH", docTotal: 55, docCur: "EUR", docDate: "2026-05-20" }] },
      { status: "ambiguous", reference: { raw: "777" }, docs: [{ objectId: 17, docEntry: 90011, docNum: 777, type: "Order", cardCode: "K130312", cardName: "Schotters GmbH", docTotal: 10, docCur: "EUR", docDate: "2026-05-01" }, { objectId: 13, docEntry: 90013, docNum: 777, type: "Invoice", cardCode: "K130312", cardName: "Schotters GmbH", docTotal: 12, docCur: "EUR", docDate: "2026-05-02" }] },
      { status: "out_of_scope", reference: { raw: "226449" }, docs: [{ objectId: 17, docEntry: 90002, docNum: 226449, type: "Order", cardCode: "K118652", cardName: "Veenstra", docTotal: 80, docCur: "EUR", docDate: "2026-06-03" }] },
    ];
    if (opts && opts.extraRefs && opts.extraRefs.length) base.push({ status: "in_scope", reference: { raw: "hint" }, docs: [{ objectId: 13, docEntry: 90031, docNum: 425315, type: "Invoice", cardCode: "K130312", cardName: "Schotters GmbH", docTotal: 99, docCur: "EUR", docDate: "2026-06-01" }] });
    return base;
  },
};

class StubAnthropic { constructor() { /* never called: model paths are stubbed */ } }

// ---- the interceptor ---------------------------------------------------------------
const BY_BASENAME = {
  "engine.js": stubEngine,
  "connectors.js": stubConnectors,
  "send.js": stubSend,
  "translate.js": stubTranslate,
  "ingest.js": stubIngest,
  "resolve-customer.js": stubResolve,
  "compose.js": stubCompose,
  "sap-doc-pdf.js": stubSapDoc,
  "doc-suggest.js": stubDocSuggest,
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "better-sqlite3") return BetterSqliteShim;
  if (request === "@anthropic-ai/sdk") return StubAnthropic;
  if (request === "express" || request === "dotenv") return origLoad.call(this, path.join(NM, request), parent, false);
  if (request.startsWith(".")) {
    const base = path.basename(request);
    if (Object.prototype.hasOwnProperty.call(BY_BASENAME, base)) return BY_BASENAME[base];
  }
  return origLoad.call(this, request, parent, isMain);
};

module.exports = { BetterSqliteShim, NM };
