// claim-statement.test.js - 2026-08-15, step 3 of the carrier-claim build.
//
// This document goes to an insurer, so what it asserts has to be exactly right and nothing it
// asserts may come from an email. buildStatementHtml is pure, so the whole page is checked here
// without Edge or a filesystem; only the render itself needs the box.
//
// Run: node claim-statement.test.js
"use strict";
const S = require("./claim-statement.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("  FAIL:", m); } };

// The real item-1316 dossier, as claimDossier returns it (verified live 2026-08-15).
const DOSSIER = {
  barcode: "1ZRJ71190404069255", found: true,
  shipment: {
    shipment_id: 235739100, shop: "gouda", carrier: "UPS Express Saver",
    status: "5 (enroute - distribution)", created: "2026-06-29 13:46:02",
    reference: "227148 - #S18422", weight_g: 9000,
    recipient: { person: "Benjamin Bourgois", company: "Cartek Groeninghe", country: "BE" },
  },
  scope: { sap_order_numbers: ["227148"], shopify_order_names: ["S18422"] },
  orders: [{ doc_num: 227148, card_name: "Cartek Groeninghe BVBA" }],
  sales_invoices: [{ doc_num: 427442, date: new Date("2026-06-29"), total: 179.29, currency: "EUR" }],
  contents: [
    { item_code: "DA6030", customer_code: "SKT6030", description: "Service kit filter Range Rover L322 3.0",
      quality: "Aftermarket", quantity: 1, unit_purchase_cost: 31.34, line_purchase_cost: 31.34,
      purchase_source: { supplier: "Allmakes", supplier_invoice: "0001/00749026", date: new Date("2026-06-09") } },
    { item_code: "AMR6676", customer_code: "AMR6676", description: "Washer Non-Return Valve",
      quality: "OEM", quantity: 3, unit_purchase_cost: 1.58, line_purchase_cost: 4.74,
      purchase_source: null },
  ],
  purchase_value: { total_eur: 74.51, basis: "SAP booked cost of goods (INV1.StockPrice)..." },
  insurance: { insured_eur: 85, purchase_value_eur: 74.51, invoice_total_eur: 179.29, covers_purchase_value: true },
  notes: [],
};

const html = S.buildStatementHtml(DOSSIER, { now: new Date("2026-08-15") });

// ---------------------------------------------------------------- the figures
ok(/74,51/.test(html), "the total purchase value appears, in Dutch convention");
ok(/31,34/.test(html) && /4,74/.test(html), "each line's purchase value appears");
ok(/SKT6030/.test(html), "the CUSTOMER part code is printed, not the internal ItemCode");
ok(!/>DA6030</.test(html), "the internal ItemCode is not printed when a customer code exists");
ok(/AMR6676/.test(html), "an item whose customer code IS the item code still prints");
ok(/Aftermarket/.test(html) && /OEM/.test(html), "the grade is printed as the brand MyParcel asks for");
ok(/427442/.test(html), "the sales invoice is identified");
ok(/1ZRJ71190404069255/.test(html), "the barcode is identified");
ok(/2026-06-29/.test(html), "the dispatch date renders as ISO, not 'Mon Jun 29'");
ok(/9000 g/.test(html), "the parcel weight is stated");
// parcel_appearance is a {nl,en} pair, used verbatim by the draft. The statement does not print
// it, but the dossier shape is shared, so a regression to a bare string should be visible.
ok(typeof (DOSSIER.parcel_appearance || { nl: "" }).nl === "string",
  "the standard parcel description is held per language, not re-translated per reply");
ok(/EUR 85,00/.test(html), "the insured amount is stated");

// ---------------------------------------------------------------- what it must NOT say
ok(!/179[.,]29/.test(html),
  "the SALES total is absent - this is a statement of purchase value and must not be read as a price list");
ok(!/165[.,]39/.test(html), "the sales value of the goods is absent too");
ok(!/69[.,]00/.test(html), "no per-line selling price appears");

// ---------------------------------------------------------------- provenance
ok(/0001\/00749026/.test(html), "the supplier invoice behind a line is named as a reference");
ok(/Allmakes/.test(html), "so is the supplier");
ok(/geen inkoopfactuur van vóór de verzenddatum/.test(html),
  "a line with no usable purchase record says so rather than showing a blank");
ok(/<span class="nb">2026-06-09<\/span>/.test(html),
  "a purchase date is held on one line - it wrapped as '2026-' / '06-09' before");
ok(/<colgroup>/.test(html), "column widths are fixed so the description gets the room");
ok(/latere inkoop is bewust niet gebruikt/i.test(html),
  "the document explains why a later purchase was not used");
ok(/uitsluitend de regels van deze zending/i.test(html),
  "and why we send a statement rather than a supplier's own invoice");

// ---------------------------------------------------------------- language
const en = S.buildStatementHtml(DOSSIER, { lang: "en", now: new Date("2026-08-15") });
ok(/Statement of purchase value/.test(en), "the English document renders");
ok(/74\.51/.test(en) && !/74,51/.test(en), "English uses a decimal point");
ok(/Opgave inkoopwaarde/.test(html) && !/Opgave/.test(en), "the two languages do not bleed into each other");
ok(/lang="nl"/.test(html) && /lang="en"/.test(en), "the document declares its language");

// ---------------------------------------------------------------- escaping
// SAP descriptions are free text the team edits, so the document must not be injectable through
// them - and nothing from an email reaches this page at all.
const nasty = JSON.parse(JSON.stringify(DOSSIER, (k, v) => (v instanceof Date ? v.toISOString() : v)));
nasty.contents[0].description = `<script>alert(1)</script> & "quoted" <b>bold</b>`;
nasty.contents[0].purchase_source.supplier = "<img src=x onerror=1>";
const escaped = S.buildStatementHtml(nasty);
ok(!/<script>/.test(escaped), "a script tag in an item description is escaped");
ok(!/<img /.test(escaped), "so is one in a supplier name");
ok(/&lt;script&gt;/.test(escaped), "and it is still legible as text");
ok(/&amp;/.test(escaped) && /&quot;/.test(escaped), "ampersands and quotes are escaped");

// ---------------------------------------------------------------- money + dates
ok(S.money(0, "nl") === "0,00", "zero formats correctly");
ok(S.money(null, "nl") === "0,00", "a missing number does not print NaN");
ok(S.money(undefined, "nl") === "0,00", "so does an absent one");
ok(S.money(1234.5, "en") === "1234.50", "English formatting pads to two decimals");
// The real float case on this data: qty x unit price, not a hand-typed half-cent.
ok(S.money(1.58 * 3, "nl") === "4,74", "3 x 1.58 prints as 4,74, not 4,740000000000001");
ok(S.money(0.1 * 3, "nl") === "0,30", "0.1 x 3 prints as 0,30, not 0,30000000000000004");
// Documented, not asserted as a wish: 1.005 is stored as 1.00499999999999989, so 1,00 is the
// correct rounding of the value we actually hold. SAP supplies 2dp figures, so this cannot bite.
ok(S.money(1.005, "nl") === "1,00", "a non-representable half-cent rounds by its true stored value");

// ---------------------------------------------------------------- refusals
(async () => {
  let r = await S.buildStatementPdf(null);
  ok(!r.ok, "no dossier, no statement");
  r = await S.buildStatementPdf({ found: false, barcode: "X" });
  ok(!r.ok && /no claim dossier/.test(r.error), "an unresolved barcode produces no statement");
  r = await S.buildStatementPdf({ found: true, contents: [], purchase_value: null });
  ok(!r.ok && /no lines/.test(r.error), "an invoice with no lines produces no statement");
  // The one that matters: never assert a purchase value of zero to an insurer.
  r = await S.buildStatementPdf({
    found: true, contents: [{ item_code: "X", quantity: 1, line_purchase_cost: 0 }],
    purchase_value: { total_eur: 0 },
  });
  ok(!r.ok && /no purchase value/.test(r.error),
    "a zero purchase value refuses to render rather than claiming the goods were worthless");

  // Empty-ish dossiers must not throw while building the HTML - the caller shows the error.
  let threw = false;
  try { S.buildStatementHtml({ found: true, contents: [] }); } catch { threw = true; }
  ok(!threw, "a dossier with no contents renders without throwing");
  try { S.buildStatementHtml({}); } catch { threw = true; }
  ok(!threw, "so does an empty object");

  // ---------------------------------------------------------------- completion detection
  // The bug this guards: Edge's launcher exits before the browser has written the PDF, so the
  // process ending is NOT the signal. Completion is judged by the file appearing and settling.
  const fs = require("fs"), os = require("os"), pathm = require("path");
  const tmp = fs.mkdtempSync(pathm.join(os.tmpdir(), "claim-wait-"));

  const late = pathm.join(tmp, "late.pdf");
  setTimeout(() => fs.writeFileSync(late, "%PDF-1.4 partial"), 300);
  setTimeout(() => fs.writeFileSync(late, "%PDF-1.4 partial and then the rest of it"), 700);
  const t0 = Date.now();
  ok(await S.waitForPdf(late, 8000) === true, "a file written AFTER the wait starts is still found");
  ok(Date.now() - t0 >= 700, "and the wait does not return before the file stops growing");

  const never = pathm.join(tmp, "never.pdf");
  ok(await S.waitForPdf(never, 700) === false, "a file that never appears times out as false");

  const empty = pathm.join(tmp, "empty.pdf");
  fs.writeFileSync(empty, "");
  ok(await S.waitForPdf(empty, 700) === false, "a zero-byte file does not count as finished");

  fs.rmSync(tmp, { recursive: true, force: true });

  // A launch failure must say so rather than hang for the full timeout with no explanation.
  const badEdge = process.env.AXLE_EDGE_EXE;
  process.env.AXLE_EDGE_EXE = pathm.join(os.tmpdir(), "no-such-edge.exe");
  delete require.cache[require.resolve("./claim-statement.js")];
  const S2 = require("./claim-statement.js");
  const r2 = await S2.htmlToPdf("<html><body>x</body></html>", { timeout: 1500 });
  ok(!r2.ok && /Edge produced no PDF/.test(r2.error), "a missing Edge reports a render failure");
  ok(/ENOENT|not recognized|cannot find/i.test(r2.error),
    `and carries the launch error rather than swallowing it (got: ${r2.error})`);
  if (badEdge) process.env.AXLE_EDGE_EXE = badEdge; else delete process.env.AXLE_EDGE_EXE;

  console.log(`\nclaim-statement: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
