// resolve-test.js - Gate A harness for the Compose customer resolver (Step 1).
// READ-ONLY: it only calls resolveCustomer(), which performs SELECT reads. Nothing is sent,
// nothing is written to any business system. Safe to run on the box at any time.
//
// Usage:
//   node resolve-test.js            run the built-in suite (turret SO 226108 + every path)
//   node resolve-test.js 226108     resolve one ad-hoc identifier
//   node resolve-test.js 226108 K127177   resolve several identifiers together (reconcile)
require("dotenv").config({ path: "C:\\Axle\\secrets\\.env", quiet: true });
const { resolveCustomer } = require("./resolve-customer.js");

function show(label, r) {
  console.log("\n" + "-".repeat(78));
  console.log("INPUT:  " + label);
  console.log(`RESULT: ${r.resolved ? "RESOLVED" : "NEEDS A HUMAN PICK"}  (via ${r.matched_via})  ${r.message}`);
  if (r.customer) {
    const c = r.customer;
    console.log(`  customer:   ${c.name || "(no account name)"}${c.contactName ? "  /  contact: " + c.contactName : ""}  [${c.cardCode || "no card"}]`);
    console.log(`  send to:    ${c.sendableAddresses.join(", ") || "(none on file)"}${r.needsAddressPick ? "   <- MORE THAN ONE, pick one" : ""}`);
    console.log(`  country:    ${c.country || "?"}   language_hint: ${c.language_hint}   (SAP lang: ${c.language_signals.sap_lang_name || "-"}, not used)`);
    console.log(`  account:    ${c.knownAccount ? "known SAP customer" : "B2C / guest (not in SAP)"}${c.frozen ? "   [FROZEN]" : ""}`);
    if (c.context && c.context.source_doc) {
      const d = c.context.source_doc;
      console.log(`  source doc: ${d.type} ${d.docNum}${d.status ? " status=" + d.status : ""}${d.paid != null ? " U_Paid=" + d.paid : ""}${d.shopify_order ? " shopify=" + d.shopify_order : ""}`);
      for (const ln of (c.context.lines || [])) console.log(`     line:    ${ln.itemCode}  ${String(ln.description || "").slice(0, 48)}  qty ${ln.quantity} (open ${ln.openQty})`);
    }
    if (c.notes && c.notes.length) c.notes.forEach((n) => console.log("  note:       " + n));
  }
  if (r.candidates && r.candidates.length) {
    console.log(`  candidates (${r.candidates.length}) - Axle will NOT auto-pick:`);
    r.candidates.slice(0, 12).forEach((c) =>
      console.log(`     - ${(c.name || "?").padEnd(34)} [${c.cardCode}]  ${c.email || "(no email)"}  ${c.country || ""}  ${c.language_hint}${c.reason ? "  - " + c.reason : ""}`));
  }
}

function check(r, expect) {
  if (!expect) return null;
  const fails = [];
  if ("resolved" in expect && r.resolved !== expect.resolved) fails.push(`resolved=${r.resolved}!=${expect.resolved}`);
  if (expect.cardCode && (!r.customer || r.customer.cardCode !== expect.cardCode)) fails.push(`card=${r.customer && r.customer.cardCode}!=${expect.cardCode}`);
  if (expect.via && r.matched_via !== expect.via) fails.push(`via=${r.matched_via}!=${expect.via}`);
  if (expect.lang && (!r.customer || r.customer.language_hint !== expect.lang)) fails.push(`lang=${r.customer && r.customer.language_hint}!=${expect.lang}`);
  if (expect.sendTo && (!r.customer || !r.customer.sendableAddresses.includes(expect.sendTo))) fails.push(`missing sendTo ${expect.sendTo}`);
  if ("hasCandidates" in expect && Boolean(r.candidates.length) !== expect.hasCandidates) fails.push(`candidates=${r.candidates.length}`);
  return fails;
}

const SUITE = [
  { label: "Sales order 226108 (the turret case)", input: "226108",
    expect: { resolved: true, cardCode: "K127177", via: "sales_order", lang: "nl", sendTo: "laurens@yvesmichiels.be" } },
  { label: "AR invoice 426646", input: "426646", expect: { resolved: true, via: "ar_invoice", lang: "nl" } },
  { label: "Customer code K127177", input: "K127177", expect: { resolved: true, cardCode: "K127177", via: "card_code" } },
  { label: "Email laurens@yvesmichiels.be", input: "laurens@yvesmichiels.be", expect: { resolved: true, cardCode: "K127177", via: "email" } },
  { label: "Shopify order #S17877", input: "#S17877", expect: { resolved: true, via: "shopify_order_via_sap" } },
  // via was "name" before the 2026-06-09 resolver rework folded byName into searchCustomers.
  { label: "Name only: Michielsen", input: "Michielsen", expect: { resolved: false, hasCandidates: true, via: "search" } },
  { label: "Unknown email (B2C guest)", input: "no-such-buyer-xyz@example.com", expect: { resolved: true, via: "email_guest" } },
  { label: "Two identifiers that agree: 226108 + K127177", input: ["226108", "K127177"], expect: { resolved: true, cardCode: "K127177" } },
];

(async () => {
  const args = process.argv.slice(2);
  if (args.length) { show(args.join(" + "), await resolveCustomer(args.length === 1 ? args[0] : args)); return; }

  console.log("Axle Compose - customer resolver, Gate A suite (read-only)\n");
  let pass = 0, total = 0;
  for (const t of SUITE) {
    const r = await resolveCustomer(t.input);
    show(t.label, r);
    const fails = check(r, t.expect);
    if (fails) { total++; if (fails.length === 0) { pass++; console.log("  CHECK:      PASS"); } else console.log("  CHECK:      FAIL - " + fails.join("; ")); }
  }
  console.log("\n" + "=".repeat(78));
  console.log(`${pass}/${total} checks passed.`);
  process.exit(pass === total ? 0 : 1);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(2); });
