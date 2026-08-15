// claim-dossier.test.js - 2026-08-15, step 2 of the carrier-claim build.
//
// claimDossier talks to MyParcel and SAP, so this suite injects both. The figures are the real
// ones from item 1316 / order 227148 / AR invoice 427442, so a derivation that drifts from what
// SAP actually holds fails here rather than in a letter to an insurer.
//
// Run: node claim-dossier.test.js
"use strict";
const Module = require("module");

// ---------------------------------------------------------------- fixtures (real values)
const SHIPMENT = {
  shop: "gouda", id: 235739100, barcode: "1ZRJ71190404069255",
  status: "5 (enroute - distribution)", carrier: "UPS Express Saver",
  reference: "227148 - #S18422", created: "2026-06-29 13:46:02",
  insurance_eur: 85, weight_g: 9000,
  recipient: { person: "Benjamin Bourgois", company: "Cartek Groeninghe", country: "BE" },
};
const ORDER = {
  DocEntry: 27049, DocNum: 227148, CardCode: "K122894", CardName: "Cartek Groeninghe BVBA",
  DocDate: new Date("2026-06-27"), DocTotal: 179.29, U_Paid: "S", NumAtCard: "#S18422",
};
const INVOICE = {
  DocEntry: 27609, DocNum: 427442, DocDate: new Date("2026-06-29"), DocTotal: 179.29,
  DocCur: "EUR", CardCode: "K122894", CardName: "Cartek Groeninghe BVBA", BaseEntry: 27049,
};
// The eight real lines, with SAP's booked StockPrice per unit.
const LINES = [
  ["DA6030",    "SKT6030",   "Service kit filter Range Rover L322 3.0", 1, 69,   69,   31.34, "Aftermarket"],
  ["BK 0042",   "SKT6029",   "Service Kit Filter WA> - P38 2.5dt",      1, 39.7, 39.7, 18.26, "Aftermarket"],
  ["AMR6676",   "AMR6676",   "Washer Non-Return Valve",                 3, 3.23, 9.69, 1.58,  "OEM"],
  ["JWH100060", "JWH100060", "Dial illumination bulb",                  1, 5.1,  5.1,  2.66,  "Genuine"],
  ["DA6004",    "SKT6004",   "Service kit TD5 Defender/Discovery",      1, 33.9, 33.9, 15.01, "Aftermarket"],
  ["501216",    "10211",     "Lamp 12V 10W BA15S",                      2, 1.19, 2.38, 0.1,   "OEM"],
  ["570829",    "AFU4481",   "Capless bulb 501 12V 5W",                 2, 1.96, 3.92, 0.88,  "OEM"],
  ["RTC3635",   "RTC3635",   "Bulb 12V 1.2W",                           2, 0.85, 1.7,  0.27,  "Aftermarket"],
].map(([ItemCode, CustCode, Dscription, Quantity, Price, LineTotal, StockPrice, U_Quality], i) => ({
  DocEntry: 27609, LineNum: i, ItemCode, CustCode, Dscription, Quantity, Price, LineTotal,
  StockPrice, U_Quality, U_Tag_Cat: null,
}));
// FIVE of the eight have a purchase on or before 29 June - verified against live SAP, not
// assumed. 501216 and 570829 have no A/P record at all, and AMR6676's only purchase is 3 July,
// i.e. AFTER this parcel shipped, so it correctly has no provenance either. That third case is
// the one that makes StockPrice the right basis: a "last purchase price" would have valued this
// parcel using goods bought after it was already lost.
const SOURCES = [
  { ItemCode: "DA6030",    DocNum: 301377, DocDate: new Date("2026-06-09"), CardName: "Allmakes", NumAtCard: "0001/00749026", Price: 27.06 },
  { ItemCode: "BK 0042",   DocNum: 300690, DocDate: new Date("2025-03-25"), CardName: "Allmakes", NumAtCard: "000/00727296",  Price: 15.28 },
  { ItemCode: "JWH100060", DocNum: 300228, DocDate: new Date("2024-03-12"), CardName: "Britpart (Border Holdings UK Ltd)", NumAtCard: "03201223", Price: 2.3 },
  { ItemCode: "DA6004",    DocNum: 301261, DocDate: new Date("2026-03-24"), CardName: "Allmakes", NumAtCard: "0001/00745514", Price: 12.97 },
  { ItemCode: "RTC3635",   DocNum: 300707, DocDate: new Date("2025-04-08"), CardName: "Allmakes", NumAtCard: "0001/00728032", Price: 0.23 },
];

// ---------------------------------------------------------------- a fake mssql pool
// Routes each query by a distinctive fragment, so the SQL's shape is asserted too: if a query
// stops selecting from ORDR, or stops joining INV1 on BaseType 17, nothing matches and the test
// fails loudly rather than passing on a stale fixture.
function makePool(state) {
  const request = () => {
    const req = {
      input: () => req,
      query: async (q) => {
        if (/FROM ORDR/i.test(q)) return { recordset: state.orders };
        if (/BaseType" = 17/i.test(q)) return { recordset: state.invoices };
        if (/FROM INV1 T1 LEFT JOIN OITM/i.test(q)) return { recordset: state.lines };
        if (/FROM OPCH P0/i.test(q)) return { recordset: state.sources };
        throw new Error("unexpected query: " + q.slice(0, 80));
      },
    };
    return req;
  };
  return { request };
}

// Load connectors.js with mssql and the MyParcel search stubbed.
function loadConnectors(state) {
  const realResolve = Module._resolveFilename;
  const realLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === "mssql") return { Int: 1, NVarChar: 2, DateTime: 3, Numeric: 4 };
    return realLoad.apply(this, arguments);
  };
  delete require.cache[require.resolve("./connectors.js")];
  delete require.cache[require.resolve("./carrier-claim.js")];
  const C = require("./connectors.js");
  Module._load = realLoad;
  Module._resolveFilename = realResolve;
  // Injected rather than monkey-patched: claimDossier closes over its own module-level helpers,
  // so overwriting the exports would look like it worked and quietly hit the real systems.
  const deps = {
    pool: makePool(state),
    myparcelSearch: async (term) =>
      (state.shipments || []).filter((s) => s.barcode.includes(String(term).toUpperCase())),
  };
  return { dossier: (barcode) => C.claimDossier(barcode, { deps }) };
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("  FAIL:", m); } };

(async () => {
  const full = {
    shipments: [SHIPMENT], orders: [ORDER], invoices: [INVOICE], lines: LINES, sources: SOURCES,
  };
  const C = loadConnectors(full);
  const d = await C.dossier("1ZRJ71190404069255");

  // ------------------------------------------------------------ scope
  ok(d.found === true, "the real barcode produces a dossier");
  ok(d.scope.sap_order_numbers[0] === "227148", "scope is order 227148, read off the label reference");
  ok(d.orders[0].card_name === "Cartek Groeninghe BVBA", "the order's customer comes through");
  ok(d.sales_invoices.length === 1 && d.sales_invoices[0].doc_num === 427442,
    "the verkoopfactuur is invoice 427442, linked structurally to the order");

  // ------------------------------------------------------------ contents
  ok(d.contents.length === 8, "all eight lines are described - none trimmed");
  const kit = d.contents[0];
  ok(kit.customer_code === "SKT6030" && kit.item_code === "DA6030",
    "the CUSTOMER code is carried, not just our internal ItemCode");
  ok(kit.quality === "Aftermarket", "the quality tier is carried as the brand MyParcel asks for");
  ok(kit.line_purchase_cost === 31.34, "line purchase cost = qty x booked unit cost");
  ok(d.contents[2].line_purchase_cost === 4.74, "a multi-quantity line multiplies out (3 x 1.58)");

  // ------------------------------------------------------------ the money
  // The whole point of the feature: purchase value, from SAP's booked cost of the goods sold.
  ok(d.purchase_value.total_eur === 74.51,
    `purchase value is EUR 74.51 (got ${d.purchase_value && d.purchase_value.total_eur})`);
  ok(d.insurance.sales_value_excl_vat_eur === 165.39, "the goods' sales value is carried separately");
  ok(d.insurance.invoice_total_eur === 179.29, "the invoice total is carried separately again");
  ok(d.insurance.insured_eur === 85, "the insured amount comes from the shipment");

  // THE FINDING: cover is judged against purchase value, not the invoice total. Judged the
  // intuitive way (85 vs 179.29) this parcel looks badly under-insured; it is not.
  ok(d.insurance.covers_purchase_value === true,
    "EUR 85 of cover DOES cover the EUR 74.51 payout basis");
  ok(d.insurance.shortfall_eur === 0, "so there is no shortfall to raise");
  ok(d.insurance.insured_eur < d.insurance.invoice_total_eur,
    "control: against the INVOICE total it would have looked like a shortfall");

  // ------------------------------------------------------------ provenance
  ok(d.contents[0].purchase_source.supplier_invoice === "0001/00749026",
    "the supplier invoice behind the line is carried as provenance");
  ok(new Date(d.contents[0].purchase_source.date) <= new Date(INVOICE.DocDate),
    "provenance is a purchase on or BEFORE the shipment - it could plausibly be these goods");
  const noSource = d.contents.filter((c) => !c.purchase_source);
  ok(noSource.length === 3, "the three lines with no usable purchase record are identified, not hidden");
  ok(noSource.every((c) => c.line_purchase_cost > 0),
    "and they still carry a cost - the booked stock value covers them");
  ok(d.notes.some((n) => /501216/.test(n)), "a missing purchase record is called out in the notes");
  // AMR6676 HAS an A/P invoice - dated 3 July, after this parcel shipped. Taking it would value
  // a lost parcel with goods bought after it was lost, so it must not be offered as provenance.
  ok(noSource.some((c) => c.item_code === "AMR6676"),
    "a purchase made AFTER the shipment is not offered as provenance for it");
  ok(d.contents.find((c) => c.item_code === "AMR6676").line_purchase_cost === 4.74,
    "and that line is still valued correctly from the booked cost");

  // ------------------------------------------------------------ parcel facts
  ok(d.shipment.weight_g === 9000 && d.shipment.shop === "gouda", "parcel facts carry through");
  ok(/^Bruine kartonnen doos/.test(d.parcel_appearance.nl) && /^Brown cardboard box/.test(d.parcel_appearance.en),
    "the standard outward description is supplied in BOTH languages, to be quoted verbatim");

  // ------------------------------------------------------------ refusals
  const notOurs = await C.dossier("1ZRJ00000000000000");
  ok(notOurs.found === false, "a barcode that is not ours produces no dossier");
  ok(/not one of our/i.test(notOurs.note) && !notOurs.sales_invoices,
    "and says so plainly, with no documents to attach");
  ok((await C.dossier("")).found === false, "an empty barcode produces no dossier");

  // An order on the label that matches no SAP order must not silently yield an empty claim.
  const orphan = loadConnectors({ ...full, orders: [], invoices: [], lines: [] });
  const o = await orphan.dossier("1ZRJ71190404069255");
  ok(o.found === true && o.sales_invoices.length === 0, "an unmatched order yields no invoice");
  ok(o.notes.some((n) => /matches no SAP order/i.test(n)), "and the gap is stated in the notes");
  ok(o.purchase_value === null, "with no lines there is no purchase value to assert");

  // A shipped-but-never-invoiced order is a real anomaly worth stopping on.
  const uninv = loadConnectors({ ...full, invoices: [], lines: [] });
  const u = await uninv.dossier("1ZRJ71190404069255");
  ok(u.notes.some((n) => /never invoiced/i.test(n)), "an order with no AR invoice is flagged for the salesperson");

  console.log(`\nclaim-dossier: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
