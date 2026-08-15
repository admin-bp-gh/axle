// carrier-claim-live.js - LIVE verification of carrier-claim.js against the real MyParcel API.
// READ-ONLY: one shipment search per barcode. Nothing is drafted, rendered, staged or sent.
//
// The unit suite (carrier-claim.test.js) runs against a stub, so it proves the LOGIC but cannot
// see the seam: whether connectors.myparcelSearch really returns the field names this module
// reads, on the real keys, for both branches. That seam is where the bugs live. Run this once
// after deploying, on the box:
//
//   node C:\Axle\app\carrier-claim-live.js                      <- replays item 1316
//   node C:\Axle\app\carrier-claim-live.js 3SMYPA6954778        <- any other barcode
//
// Expected for the default run: is_claim true, scope = SAP order 227148, both documents wanted.
"use strict";
require("C:\\Axle\\app\\node_modules\\dotenv").config({ path: "C:\\Axle\\secrets\\.env", quiet: true });
const CC = require("C:\\Axle\\app\\carrier-claim.js");
const C = require("C:\\Axle\\app\\connectors.js");

// The real item-1316 email, verbatim enough to exercise the detector end to end.
const ITEM_1316 = {
  senderAddress: "info@myparcel.nl",
  subject: "1ZRJ71190404069255 naar Benjamin Bourgois",
  text: [
    "Beste Bradley,",
    "Het spijt ons te horen dat uw zending nog niet is afgeleverd. We hebben dit meteen nagekeken",
    "in ons systeem, maar helaas kan ik de zending niet vinden. Zodoende zullen we een onderzoek",
    "moeten starten.",
    "Graag ontvang ik een inkoop- en verkoopfactuur.",
  ].join("\n"),
};

// NOTE: process.exitCode, not process.exit - an immediate exit after fetch trips a libuv assert
// on Windows. The process ends by itself once undici's keep-alive sockets close.
(async () => {
  // The first NON-FLAG argument is the barcode. Taking argv[2] blindly (the first version) meant
  // `--statement` was read as a barcode, which then resolved to nothing and quietly reported
  // "no_barcode" instead of rendering - a failure that looked like a data problem.
  const barcode = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const email = barcode
    ? { senderAddress: "info@myparcel.nl", subject: `${barcode} naar iemand`, text: ITEM_1316.text }
    : ITEM_1316;

  console.log("Barcode(s) extracted:", CC.extractBarcodes(`${email.subject}\n${email.text}`));
  console.log("Documents wanted:    ", CC.documentsWanted(email.text));

  const deps = { myparcelSearch: C.myparcelSearch };
  const r = await CC.detectClaim(email, {}, deps);

  console.log("\n--- detectClaim ---");
  console.log("is_claim:", r.is_claim, "  reason:", r.reason);
  if (!r.is_claim) { console.log("\nNo claim scope. Nothing would be attached."); return; }

  for (const s of r.shipments) {
    console.log(`\nshipment ${s.shipment_id} (${s.shop})`);
    console.log("  barcode:   ", s.barcode);
    console.log("  reference: ", s.reference, " <- the scope is read from THIS, not from the email");
    console.log("  carrier:   ", s.carrier, "| status:", s.status, "| created:", s.created);
    console.log("  insured:   ", s.insurance_eur != null ? `EUR ${s.insurance_eur}` : "(none)");
    console.log("  weight:    ", s.weight_g != null ? `${s.weight_g} g` : "(not mapped - check mpShipment)");
    console.log("  recipient: ", [s.recipient && s.recipient.person, s.recipient && s.recipient.company].filter(Boolean).join(" / "));
  }
  console.log("\nSCOPE  SAP order(s):", r.sap_order_numbers.join(", ") || "(none)");
  console.log("       Shopify name(s):", r.shopify_order_names.join(", ") || "(none)");

  // The guard that matters, exercised live: a well-formed barcode that is not one of our parcels
  // must produce NO scope, with no looser fallback.
  const notOurs = await CC.detectClaim(
    { ...email, subject: "1ZRJ00000000000000 naar iemand" }, {}, deps);
  console.log("\nGUARD  a barcode that is not ours ->",
    notOurs.is_claim ? "*** FAILED: it got a scope ***" : `no scope (reason: ${notOurs.reason})  OK`);

  // ---------------------------------------------------------------- step 2: the dossier
  // Same barcode, now through the full SAP assembly. This is the seam the unit suite cannot see:
  // whether the real INV1/OPCH columns and the BaseType 17 join behave as the fixtures claim.
  const d = await C.claimDossier(r.barcodes[0]);
  console.log("\n--- claim_dossier ---");
  if (!d.found) { console.log("found: false —", d.note); await C.closePool().catch(() => {}); return; }

  console.log("sales invoice(s) to attach:",
    // SAP hands dates back as Date objects, so slice the ISO form - String(date) gives "Mon Jun 29".
    d.sales_invoices.map((v) => `${v.doc_num} (${new Date(v.date).toISOString().slice(0, 10)}, EUR ${v.total})`).join(", ") || "(none)");
  console.log("\ncontents:");
  for (const c of d.contents) {
    console.log(`  ${String(c.quantity).padStart(2)} x ${String(c.customer_code).padEnd(12)} ${String(c.quality || "?").padEnd(12)}` +
      ` cost EUR ${String(c.line_purchase_cost).padStart(6)}  ${c.purchase_source ? c.purchase_source.supplier + " " + c.purchase_source.supplier_invoice : "(no purchase record)"}`);
  }
  console.log("\npurchase value:", d.purchase_value ? `EUR ${d.purchase_value.total_eur}` : "(none)");
  console.log("sales value (excl VAT):", `EUR ${d.insurance.sales_value_excl_vat_eur}`, " invoice total:", `EUR ${d.insurance.invoice_total_eur}`);
  console.log("insured:", `EUR ${d.insurance.insured_eur}`,
    "-> covers the payout basis:", d.insurance.covers_purchase_value,
    "| shortfall: EUR", d.insurance.shortfall_eur);
  if (d.notes.length) { console.log("\nnotes:"); for (const n of d.notes) console.log("  -", n); }

  // ---------------------------------------------------------------- step 3: the statement PDF
  // Only with --statement, because it shells out to headless Edge. The file is written into the
  // REPO folder rather than the render out-dir so it can simply be opened and looked at - this
  // is the one part of the feature whose output is judged by eye, not by an assert.
  if (process.argv.includes("--statement")) {
    const S = require("C:\\Axle\\app\\claim-statement.js");
    const lang = process.argv.includes("--en") ? "en" : "nl";
    console.log(`\n--- claim statement (${lang}) ---`);
    const r = await S.buildStatementPdf(d, { lang });
    if (!r.ok) { console.log("render failed:", r.error); }
    else {
      const out = "C:\\Admin\\Projects\\Axle\\claim-statement-sample.pdf";
      require("fs").writeFileSync(out, r.buffer);
      console.log(`${r.filename}  ${r.bytes} bytes  ->  ${out}`);
      console.log("Open it and check it reads like a document you would send an insurer.");
    }
  }

  await C.closePool().catch(() => {});
})();
