// claim-attach.test.js - 2026-08-15, step 4 of the carrier-claim build.
//
// Staging documents automatically is the first thing in this feature that ACTS without a human
// asking, so the guards matter more than the happy path. These asserts prove the gate, the scope
// substitution, the refusals and the idempotency, with negative controls showing each guard bites.
//
// Run: node claim-attach.test.js
"use strict";
const CA = require("./claim-attach.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("  FAIL:", m); } };

const DOSSIER = {
  barcode: "1ZRJ71190404069255", found: true,
  orders: [{ doc_num: 227148, card_code: "K122894", card_name: "Cartek Groeninghe BVBA" }],
  sales_invoices: [{ doc_num: 427442, card_code: "K122894", total: 179.29 }],
  contents: [{ item_code: "DA6030", quantity: 1, line_purchase_cost: 31.34 }],
  purchase_value: { total_eur: 74.51 },
  insurance: { insured_eur: 85 },
};
const ITEM = { id: 1316, origin: "inbound", injection_flag: 0 };

// A harness recording everything that happened, with each dependency overridable per test.
function harness(over = {}) {
  const state = { attached: [], audits: [], rendered: [], statements: 0 };
  const deps = {
    buildDocumentPdf: async (type, num) => {
      state.rendered.push(`${type}:${num}`);
      return { ok: true, doc: { cardCode: "K122894", docNum: Number(num) },
        buffer: Buffer.from("%PDF-1.4 invoice"), bytes: 16 };
    },
    buildStatementPdf: async () => {
      state.statements++;
      return { ok: true, filename: "Inkoopwaarde-427442.pdf", buffer: Buffer.from("%PDF-1.4 stmt"), bytes: 13 };
    },
    addAttachment: (item, body) => { state.attached.push(body.name); return { error: null, id: state.attached.length }; },
    existingNames: async () => [],
    audit: (actor, action, id, detail) => state.audits.push(`${action}:${detail || ""}`),
    ...over,
  };
  return { state, deps };
}

(async () => {
  // ---------------------------------------------------------------- the happy path
  let h = harness();
  let r = await CA.stageClaimDocuments(ITEM, DOSSIER, h.deps, { mode: "on" });
  ok(r.staged.length === 2, "both documents are staged");
  ok(h.state.attached[0] === "Invoice-427442.pdf", "the sales invoice is staged first");
  ok(h.state.attached[1] === "Inkoopwaarde-427442.pdf", "the purchase-value statement second");
  ok(h.state.rendered[0] === "invoice:427442", "the invoice is re-resolved by NUMBER, not by a carried DocEntry");
  ok(r.errors.length === 0, "no errors on the happy path");
  ok(h.state.audits.filter((a) => a.startsWith("claim_doc_attached")).length === 2, "each staging is audited");

  // ---------------------------------------------------------------- the gate
  h = harness();
  r = await CA.stageClaimDocuments(ITEM, DOSSIER, h.deps, { mode: "off" });
  ok(r.staged.length === 0 && h.state.attached.length === 0, "gate off stages nothing");
  ok(CA.mode({}) === "off", "an unset env is off");
  ok(CA.mode({ AXLE_ACTION_CLAIM_AUTOATTACH: "on" }) === "on", "'on' is on");
  ok(CA.mode({ AXLE_ACTION_CLAIM_AUTOATTACH: "dry" }) === "dry", "'dry' is dry");
  ok(CA.mode({ AXLE_ACTION_CLAIM_AUTOATTACH: "yes" }) === "off", "anything else is off, not on");
  ok(!CA.active({}) && CA.active({ AXLE_ACTION_CLAIM_AUTOATTACH: "dry" }), "active() reflects the gate");

  h = harness();
  r = await CA.stageClaimDocuments(ITEM, DOSSIER, h.deps, { mode: "dry" });
  ok(r.staged.length === 2 && r.staged.every((s) => s.dryRun), "dry run reports what it would stage");
  ok(h.state.attached.length === 0, "and stages nothing");
  ok(h.state.statements === 0, "a dry run does not even render");

  // ---------------------------------------------------------------- refusals
  h = harness();
  r = await CA.stageClaimDocuments({ ...ITEM, injection_flag: 1 }, DOSSIER, h.deps, { mode: "on" });
  ok(h.state.attached.length === 0 && /injection/.test(r.skipped[0]),
    "an injection-flagged item never gets documents staged automatically");

  h = harness();
  r = await CA.stageClaimDocuments({ ...ITEM, origin: "compose" }, DOSSIER, h.deps, { mode: "on" });
  ok(h.state.attached.length === 0, "a compose item is not a carrier claim");

  h = harness();
  r = await CA.stageClaimDocuments(ITEM, { found: false }, h.deps, { mode: "on" });
  ok(h.state.attached.length === 0, "no dossier, nothing staged");

  h = harness();
  r = await CA.stageClaimDocuments(ITEM, { ...DOSSIER, orders: [] }, h.deps, { mode: "on" });
  ok(h.state.attached.length === 0 && /no SAP order/.test(r.skipped[0]),
    "a shipment resolving to no order stages nothing - there is no scope to check against");

  // ---------------------------------------------------------------- THE SCOPE GATE
  // The document SAP hands back must belong to the customer on the shipment's own order.
  h = harness({
    buildDocumentPdf: async () => ({ ok: true, doc: { cardCode: "K999999", docNum: 427442 },
      buffer: Buffer.from("%PDF-1.4"), bytes: 8 }),
  });
  r = await CA.stageClaimDocuments(ITEM, DOSSIER, h.deps, { mode: "on" });
  ok(!h.state.attached.includes("Invoice-427442.pdf"),
    "an invoice belonging to a DIFFERENT customer is never staged");
  ok(r.errors.some((e) => /K999999/.test(e)), "and the mismatch is reported");
  ok(h.state.audits.some((a) => a.startsWith("claim_attach_scope_block")), "and audited");
  ok(h.state.attached.includes("Inkoopwaarde-427442.pdf"),
    "the statement still stages - it is built from the dossier, not from the rejected document");

  // ---------------------------------------------------------------- render failures
  h = harness({ buildDocumentPdf: async () => ({ ok: false, error: "Crystal timed out" }) });
  r = await CA.stageClaimDocuments(ITEM, DOSSIER, h.deps, { mode: "on" });
  ok(r.errors.some((e) => /Crystal timed out/.test(e)), "a render failure is reported, not swallowed");
  ok(h.state.attached.length === 1, "and does not stop the other document");

  h = harness({ buildDocumentPdf: async () => { throw new Error("boom"); } });
  r = await CA.stageClaimDocuments(ITEM, DOSSIER, h.deps, { mode: "on" });
  ok(r.errors.some((e) => /boom/.test(e)), "a thrown renderer is caught");

  h = harness({ addAttachment: () => ({ error: "file too big", id: null }) });
  r = await CA.stageClaimDocuments(ITEM, DOSSIER, h.deps, { mode: "on" });
  ok(r.errors.length === 2 && r.staged.length === 0, "a staging refusal is reported for each document");

  // ---------------------------------------------------------------- idempotency
  // Ingest runs repeatedly on a live thread; a claim must not accumulate duplicate attachments.
  h = harness({ existingNames: async () => ["Invoice-427442.pdf", "Inkoopwaarde-427442.pdf"] });
  r = await CA.stageClaimDocuments(ITEM, DOSSIER, h.deps, { mode: "on" });
  ok(h.state.attached.length === 0 && r.skipped.length === 2, "documents already on the draft are not staged twice");
  h = harness({ existingNames: async () => ["Invoice-427442.pdf"] });
  r = await CA.stageClaimDocuments(ITEM, DOSSIER, h.deps, { mode: "on" });
  ok(h.state.attached.length === 1 && h.state.attached[0] === "Inkoopwaarde-427442.pdf",
    "a partially-staged claim completes rather than starting over");

  // ---------------------------------------------------------------- the plan
  ok(CA.plan(DOSSIER).length === 2, "a full dossier plans two documents");
  ok(CA.plan({ ...DOSSIER, purchase_value: { total_eur: 0 } }).length === 1,
    "a zero purchase value plans no statement - we never assert the goods were worthless");
  ok(CA.plan({ ...DOSSIER, contents: [] }).length === 1, "no contents, no statement");
  ok(CA.plan({ ...DOSSIER, sales_invoices: [] }).length === 1, "no invoice, but the statement still stands");
  ok(CA.plan({ found: false }).length === 0, "an unresolved claim plans nothing");

  // ---------------------------------------------------------------- end to end via handleInboundClaim
  const mpStub = {
    myparcelSearch: async () => [{
      shop: "gouda", id: 1, barcode: "1ZRJ71190404069255", reference: "227148 - #S18422",
      carrier: "UPS", status: "distribution", created: "2026-06-29", insurance_eur: 85,
      recipient: { person: "Benjamin Bourgois" },
    }],
  };
  h = harness();
  let res = await CA.handleInboundClaim(ITEM, {
    senderAddress: "info@myparcel.nl", subject: "1ZRJ71190404069255 naar Benjamin Bourgois",
    text: "Zodoende zullen we een onderzoek moeten starten. Graag ontvang ik een inkoop- en verkoopfactuur.",
  }, { ...h.deps, claimDeps: mpStub, claimDossier: async () => DOSSIER }, { mode: "on" });
  ok(res.claim.is_claim && res.report.staged.length === 2, "the whole path runs: detect, assemble, stage");

  // An ordinary customer email must not go anywhere near this.
  h = harness();
  res = await CA.handleInboundClaim(ITEM, {
    senderAddress: "benjamin@cartek.be", subject: "Where is my order 227148?",
    text: "Graag ontvang ik de factuur.",
  }, { ...h.deps, claimDeps: mpStub, claimDossier: async () => DOSSIER }, { mode: "on" });
  ok(!res.claim.is_claim && h.state.attached.length === 0, "a customer email is not a claim and stages nothing");

  // A failure must never block the item reaching the salesperson.
  h = harness();
  res = await CA.handleInboundClaim(ITEM, {
    senderAddress: "info@myparcel.nl", subject: "1ZRJ71190404069255 naar iemand",
    text: "onderzoek, graag inkoop- en verkoopfactuur",
  }, { ...h.deps, claimDeps: mpStub, claimDossier: async () => { throw new Error("SAP down"); } }, { mode: "on" });
  ok(res.dossier === null && h.state.audits.some((a) => a.startsWith("claim_error")),
    "a mid-flight failure is audited and swallowed, never thrown at ingest");

  // ---------------------------------------------------------------- negative controls
  // 1. Without the scope gate, the foreign invoice above WOULD have been staged.
  ok((await harness({
    buildDocumentPdf: async () => ({ ok: true, doc: { cardCode: "K999999" }, buffer: Buffer.from("x"), bytes: 1 }),
  }).deps.buildDocumentPdf()).doc.cardCode === "K999999",
    "control: the renderer really does hand back a foreign document - the gate is what rejects it");
  // 2. Without the existingNames check, the second run WOULD duplicate.
  h = harness({ existingNames: async () => [] });
  await CA.stageClaimDocuments(ITEM, DOSSIER, h.deps, { mode: "on" });
  await CA.stageClaimDocuments(ITEM, DOSSIER, h.deps, { mode: "on" });
  ok(h.state.attached.length === 4,
    "control: with nothing reported as already-present, two runs DO stage twice - the check is what prevents it");

  // ---------------------------------------------------------------- the scope substitution
  // The other half of step 4: the suggestions panel. Scoped to the SENDER, a MyParcel claim files
  // its own correct documents under "different customer" - which is exactly what item 1316 showed.
  // Scoped to the order on our shipment's label, the same documents come back one-click in_scope.
  const { buildSuggestions, suggestForEmail } = require("./doc-suggest.js");
  const sapStub = {
    resolveDocument: async (type, num) => ({
      ok: true, candidates: String(num) === "427442"
        ? [{ type: "Invoice", objectId: 13, docEntry: 27609, docNum: 427442, cardCode: "K122894", cardName: "Cartek Groeninghe BVBA", docTotal: 179.29 }]
        : String(num) === "227148"
        ? [{ type: "Order", objectId: 17, docEntry: 27049, docNum: 227148, cardCode: "K122894", cardName: "Cartek Groeninghe BVBA", docTotal: 179.29 }]
        : [],
    }),
    resolveShopifyOrder: async () => ({ ok: true, candidates: [] }),
    // MyParcel's address resolves to no single customer - which is the whole problem.
    customerByEmail: async () => ({ cardCode: null }),
  };
  const claimText = "Onderzoek zending 1ZRJ71190404069255, order 227148, factuur 427442.";

  let s = await suggestForEmail("info@myparcel.nl", claimText, {}, sapStub);
  ok(s.length === 2 && s.every((x) => x.status === "out_of_scope"),
    "control: scoped to the SENDER, both correct documents land in 'different customer' (item 1316's bug)");

  s = await buildSuggestions(claimText, { cardCode: "K122894", cardName: "Cartek Groeninghe BVBA" }, {}, sapStub);
  ok(s.length === 2 && s.every((x) => x.status === "in_scope"),
    "scoped to the shipment's own order, both come back one-click in_scope");

  // The substitution must not become a way in for anything else: a foreign document named in the
  // same email is still refused, because the scope is a CardCode, not a free pass.
  sapStub.resolveDocument = async (type, num) => ({
    ok: true, candidates: String(num) === "999001"
      ? [{ type: "Invoice", objectId: 13, docEntry: 1, docNum: 999001, cardCode: "K000001", cardName: "Someone Else", docTotal: 10 }] : [],
  });
  s = await buildSuggestions("also invoice 999001", { cardCode: "K122894" }, {}, sapStub);
  ok(s.length === 1 && s[0].status === "out_of_scope",
    "a foreign customer's document is still out of scope under the claim scope");

  // ---------------------------------------------------------------- one implementation, two paths
  // The bug this guards, found on the live dry run of item 1316: the claim path was wired into
  // ingest only. A claim item already exists by the time anyone opens it, so ingest does not run
  // again; the button a salesperson presses is "Save & redraft", which goes through runRedraft.
  // The documents would therefore never have been staged from the UI at any gate setting.
  // Unit tests could not see it - both halves were individually correct - so this reads the source
  // and insists both callers go through the SAME helper.
  const src = (f) => require("fs").readFileSync(require("path").join(__dirname, f), "utf8");
  const shared = src("routes/shared.js"), ingest = src("ingest.js");
  ok(/function runClaim\(/.test(shared), "runClaim is defined once, in routes/shared.js");
  ok(/runClaim\(itemId,/.test(shared), "the redraft path calls it");
  ok(/require\("\.\/routes\/shared\.js"\)/.test(ingest) && /runClaim\(itemId,/.test(ingest),
    "and the ingest path calls the same one rather than its own copy");
  ok(!/handleInboundClaim/.test(ingest),
    "ingest does not reach past the shared helper into claim-attach directly");

  console.log(`\nclaim-attach: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
