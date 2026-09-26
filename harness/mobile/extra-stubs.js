// extra-stubs.js - preload for the mobile harness's child process (loaded via
// NODE_OPTIONS=--require before harness/step0/child.js runs).
//
// harness/step0/stubs.js dates from June 2026 and intercepts a fixed list of module
// basenames (engine, connectors, send, translate, ingest, resolve-customer, compose,
// sap-doc-pdf, doc-suggest, better-sqlite3). box-code has grown since then: routes/item.js
// now requires ../customer-summary.js (FR-0002, the customer at-a-glance card), which is
// not on that list and is not stubbed. customer-summary.js does `require("mssql")` at
// module load and calls a live `connectors.getPool()` at call time - neither of which the
// Step-0 stub kit provides, so requiring the real box-code/server.js under the plain
// Step-0 stubs hangs forever pulling in the real mssql/@azure/identity dependency tree,
// and even if it finished loading, calling summarise()/detail() would throw because the
// stubbed connectors.js has no getPool(). This is exactly the "stale stubs" situation the
// mobile plan's K4 note anticipates ("stale stubs are fixed inside harness/, which deploy
// never sees") - this file is that fix, kept inside harness/ and never touching box-code
// or harness/step0/stubs.js itself.
//
// Layering: stubs.js installs its own Module._load interceptor as a side effect of being
// required. We require it first (so its interceptor is in place, unchanged), then wrap
// Module._load again with our own function that intercepts a small EXTRA basename list
// and otherwise defers to the interceptor stubs.js just installed. Because this whole
// file runs as a NODE_OPTIONS --require preload, it executes before harness/step0/child.js
// does its own `require("./stubs.js")` - Node's module cache then returns the already
// -loaded module without re-running its top-level code, so the interceptor chain stays:
// original Module._load -> stubs.js's interceptor -> this file's interceptor.
"use strict";
const path = require("path");
const Module = require("module");

const STEP0_DIR = path.join(__dirname, "..", "step0");
require(path.join(STEP0_DIR, "stubs.js")); // installs the base interceptor (unmodified)

// Deterministic fixture data, keyed by the same CardCodes harness/step0/stubs.js already
// uses for resolve-customer (K127177 BV Newcraft, K130312 Schotters GmbH). Shapes mirror
// the real customer-summary.js's summarise()/detail() return values exactly (box-code/
// customer-summary.js:51-102) so the customer card and modal render with real markup.
const SUMMARY = {
  K130312: {
    cardCode: "K130312", cardName: "Schotters GmbH", cardType: "C", country: "DE",
    currency: "EUR", group: "Trade", frozen: false, tier: "Sales - Pro (10%)",
    balance: 245.5, openOrders: 2, openOrdersVal: 155, openInvoices: 1, openInvOutstanding: 55,
  },
  K127177: {
    cardCode: "K127177", cardName: "BV Newcraft", cardType: "C", country: "BE",
    currency: "EUR", group: "Trade", frozen: false, tier: "Sales - Pro (10%)",
    balance: 121.5, openOrders: 1, openOrdersVal: 121.5, openInvoices: 0, openInvOutstanding: 0,
  },
};
const DETAIL_EXTRA = {
  K130312: {
    stats: { lifetimeInv: 980, inv12m: 430, firstInv: "2024-02-11", lastOrder: "2026-06-02" },
    orders: [
      { docNum: 224665, docDate: "2026-05-20", total: 55, open: true },
      { docNum: 777, docDate: "2026-05-01", total: 10, open: false },
    ],
    invoices: [{ docNum: 90013, docDate: "2026-05-02", total: 12, outstanding: 12, open: true }],
  },
  K127177: {
    stats: { lifetimeInv: 640, inv12m: 260, firstInv: "2024-05-03", lastOrder: "2026-06-02" },
    orders: [{ docNum: 226108, docDate: "2026-06-02", total: 121.5, open: true }],
    invoices: [],
  },
};

function cleanTier(name) {
  return String(name || "").replace(/^\s*\d+\.\s*/, "").trim() || null;
}

const stubCustomerSummary = {
  summarise: async (cardCode) => SUMMARY[String(cardCode || "").trim()] || null,
  detail: async (cardCode) => {
    const cc = String(cardCode || "").trim();
    const summary = SUMMARY[cc];
    if (!summary) return null;
    const extra = DETAIL_EXTRA[cc] || { stats: { lifetimeInv: 0, inv12m: 0, firstInv: null, lastOrder: null }, orders: [], invoices: [] };
    return { summary, stats: extra.stats, orders: extra.orders, invoices: extra.invoices };
  },
  cleanTier,
};

const EXTRA_BY_BASENAME = {
  "customer-summary.js": stubCustomerSummary,
};

// Phase 3 (C4 / M-51): a controllable forced 500 on GET /item/:id, without touching box-code.
// routes/item.js has no unguarded JSON.parse of a row column (doc_suggestions_json,
// compose_customer, contact_form_json, return_json and attachments_json are all parsed
// inside try/catch), so a malformed fixture value cannot make the handler throw. Instead,
// when AXLE_HARNESS_FAIL_ITEM is set (an item id; boot.js sets "300" for phase 3), the
// first time views/ui.js is loaded its export object's renderTimeline is replaced, in
// place, by a wrapper that throws for that item id and otherwise calls the real function.
// Patching the shared export object in place (before routes/item.js destructures it at its
// own require time) is what makes item.js pick the wrapper up. renderTimeline is called
// only while rendering a real item's detail (item.js, the #mailwrap block), so the throw
// lands in Express's last-resort error middleware exactly like any route error would: a
// 500 with the pane-shaped .errbox for an htmx request, the plain error page otherwise.
const FAIL_ITEM = process.env.AXLE_HARNESS_FAIL_ITEM ? String(process.env.AXLE_HARNESS_FAIL_ITEM) : "";
let uiPatched = false;
function maybePatchUi(request, mod) {
  if (!FAIL_ITEM || uiPatched || !mod || typeof mod.renderTimeline !== "function") return mod;
  if (path.basename(request) !== "ui.js") return mod;
  const real = mod.renderTimeline;
  mod.renderTimeline = function (w) {
    if (w && String(w.id) === FAIL_ITEM) throw new Error("harness forced failure for item " + FAIL_ITEM);
    return real.apply(this, arguments);
  };
  uiPatched = true;
  return mod;
}

const prevLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.startsWith(".")) {
    const base = path.basename(request);
    if (Object.prototype.hasOwnProperty.call(EXTRA_BY_BASENAME, base)) return EXTRA_BY_BASENAME[base];
  }
  const mod = prevLoad.apply(this, arguments);
  return maybePatchUi(request, mod);
};

module.exports = { EXTRA_BY_BASENAME };
