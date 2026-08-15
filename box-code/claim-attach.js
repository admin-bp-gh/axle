// claim-attach.js - Step 4 of the carrier-claim build: put the documents on the draft.
//
// Steps 1-3 established the scope, assembled the facts and produced the purchase-value statement.
// This is the part that removes the manual work: on a recognised carrier claim, the sales invoice
// and the statement are STAGED on the draft, so the salesperson opens item 1316 and finds both
// documents already attached instead of a note telling them to go and find an invoice in SAP.
//
// WHAT THIS IS AND IS NOT. Staging is not sending. An attachment sits in draft_attachments exactly
// like a file a human dragged onto the draft, behind the same Send approval as everything else,
// with a Remove button beside it. Nothing here sends an email, writes to SAP or touches Shopify.
// It is the same read-and-render capability the "Attach SAP document" control has had since June,
// with the human's click moved from "find and attach this" to "keep or remove this".
//
// THE SCOPE SUBSTITUTION, which is the one genuinely new thing here. Everywhere else in Axle a
// document may be attached only if its CardCode matches the customer resolved from the SENDER.
// On a carrier claim the sender is MyParcel, so that rule resolves to nobody and blocks the two
// correct documents (this is exactly what item 1316 did). The claim scope replaces it:
//
//     barcode in the email  ->  OUR MyParcel shipment  ->  the order on ITS OWN label
//
// Every link after the first is our own data. The email contributes one candidate string, which
// can only resolve inside our own MyParcel account. So the substitution does not widen what an
// email can reach; it swaps a scope that cannot work here for one derived from our records.
//
// Belt and braces on top of that: the invoice actually staged must belong to the same CardCode as
// the order the shipment names. The dossier builds it from that order, so this can only fail if
// the assembly is wrong - which is precisely when we want to stop.
//
// GATED. `AXLE_ACTION_CLAIM_AUTOATTACH` in C:\Axle\secrets\.env:
//     unset / anything else - off. Claims are detected and briefed; nothing is staged.
//     dry                   - do every read and render, report what WOULD be staged, stage nothing.
//     on                    - stage.
// Off is the safe default, and `dry` exists because the last two capabilities that went live here
// (the Outlook sender block especially) were saved by their dry runs.

"use strict";

const CC = require("./carrier-claim.js");
const CS = require("./claim-statement.js");

// AR invoice = SAP object 13. Named rather than inlined so the intent is readable at the call site.
const OBJ_AR_INVOICE = 13;

function mode(env = process.env) {
  const v = String(env.AXLE_ACTION_CLAIM_AUTOATTACH || "").trim().toLowerCase();
  return v === "on" ? "on" : v === "dry" ? "dry" : "off";
}
const active = (env) => mode(env) !== "off";

// The two documents a claim always needs, in the order they should appear on the draft.
// `key` is a stable identity used to avoid staging the same document twice across re-ingests.
function plan(dossier) {
  const out = [];
  if (!dossier || !dossier.found) return out;
  const inv = (dossier.sales_invoices || [])[0];
  if (inv) out.push({ kind: "sales_invoice", key: `Invoice-${inv.doc_num}.pdf`, invoice: inv });
  if (dossier.purchase_value && dossier.purchase_value.total_eur > 0 && (dossier.contents || []).length) {
    out.push({ kind: "purchase_statement", key: `Inkoopwaarde-${inv ? inv.doc_num : dossier.barcode}.pdf` });
  }
  return out;
}

// Stage the claim documents on a work item.
//
// deps (all injected by the caller so this is testable without SAP, Edge or the DB):
//   renderPdf(objectId, docEntry) -> { ok, buffer, bytes }        the Boyum print renderer
//   buildStatementPdf(dossier, opts) -> { ok, filename, buffer }  the statement generator
//   addAttachment(item, {data,name,ctype}) -> { error, id }       the existing staging helper
//   existingNames(itemId) -> [name]                               what is already on the draft
//   audit(actor, action, itemId, detail)
async function stageClaimDocuments(item, dossier, deps, opts = {}) {
  const m = opts.mode || mode(opts.env);
  const report = { mode: m, staged: [], skipped: [], errors: [] };
  if (m === "off") { report.skipped.push("gate off"); return report; }

  // Refusals, cheapest first. Each mirrors an existing rule rather than inventing a new one.
  if (!item) { report.errors.push("no item"); return report; }
  if (item.injection_flag) { report.skipped.push("injection-flagged"); return report; }   // as everywhere: surface nothing automatically
  if (item.origin === "compose") { report.skipped.push("compose item"); return report; }
  if (!dossier || !dossier.found) { report.skipped.push("no claim dossier"); return report; }

  // The scope check, restated locally rather than trusted from upstream.
  const order = (dossier.orders || [])[0];
  const scopeCard = order && order.card_code;
  if (!scopeCard) { report.skipped.push("shipment resolves to no SAP order"); return report; }

  const already = new Set(await deps.existingNames(item.id));

  for (const p of plan(dossier)) {
    if (already.has(p.key)) { report.skipped.push(`${p.kind} already on the draft`); continue; }

    if (p.kind === "sales_invoice") {
      if (m === "dry") { report.staged.push({ kind: p.kind, name: p.key, dryRun: true }); continue; }
      // Deliberately the same resolve-then-render path the manual "Attach SAP document" control
      // uses, driven by the DOCUMENT NUMBER rather than a DocEntry carried over from the dossier.
      // It re-resolves against SAP, refuses an ambiguous number, and hands back the document's own
      // identity - so the scope check below tests SAP's answer, not our copy of it.
      let r;
      try { r = await deps.buildDocumentPdf("invoice", String(p.invoice.doc_num)); }
      catch (e) { report.errors.push("invoice render threw: " + (e.message || e)); continue; }
      if (!r || !r.ok) { report.errors.push("invoice render failed: " + ((r && r.error) || (r && r.ambiguous ? "ambiguous number" : "unknown"))); continue; }

      // THE SCOPE GATE. The rendered document must belong to the customer on the order that this
      // shipment's own label names. Nothing is staged on a mismatch - we stop and say why.
      if (!r.doc || r.doc.cardCode !== scopeCard) {
        report.errors.push(`invoice ${p.invoice.doc_num} belongs to ${(r.doc && r.doc.cardCode) || "?"}, not ${scopeCard}`);
        deps.audit("system", "claim_attach_scope_block", item.id,
          `invoice ${p.invoice.doc_num} cust ${(r.doc && r.doc.cardCode) || "?"} vs order cust ${scopeCard}`);
        continue;
      }
      const a = deps.addAttachment(item, { data: r.buffer.toString("base64"), name: p.key, ctype: "application/pdf" });
      if (a.error) { report.errors.push("invoice not staged: " + a.error); continue; }
      report.staged.push({ kind: p.kind, name: p.key, bytes: r.bytes });
      deps.audit("system", "claim_doc_attached", item.id,
        `sales invoice ${p.invoice.doc_num} cust ${scopeCard} ${r.bytes}b (claim ${dossier.barcode})`);
      continue;
    }

    if (p.kind === "purchase_statement") {
      if (m === "dry") { report.staged.push({ kind: p.kind, name: p.key, dryRun: true }); continue; }
      let r;
      try { r = await deps.buildStatementPdf(dossier, { lang: opts.lang === "en" ? "en" : "nl" }); }
      catch (e) { report.errors.push("statement render threw: " + (e.message || e)); continue; }
      if (!r || !r.ok) { report.errors.push("statement render failed: " + ((r && r.error) || "unknown")); continue; }
      const a = deps.addAttachment(item, { data: r.buffer.toString("base64"), name: p.key, ctype: "application/pdf" });
      if (a.error) { report.errors.push("statement not staged: " + a.error); continue; }
      report.staged.push({ kind: p.kind, name: p.key, bytes: r.bytes });
      deps.audit("system", "claim_doc_attached", item.id,
        `purchase-value statement EUR ${dossier.purchase_value.total_eur} ${r.bytes}b (claim ${dossier.barcode})`);
    }
  }

  for (const e of report.errors) deps.audit("system", "claim_attach_error", item.id, String(e).slice(0, 150));
  return report;
}

// Detect + assemble + stage, for the ingest path. Returns { claim, dossier, report } so the caller
// can store the claim on the item and scope its document suggestions to the order.
// A failure anywhere here must never block an item: the email still reaches the salesperson.
async function handleInboundClaim(item, email, deps, opts = {}) {
  const out = { claim: null, dossier: null, report: null };
  try {
    const claim = await CC.detectClaim(
      { senderAddress: email.senderAddress, subject: email.subject, text: email.text },
      { flagged: !!item.injection_flag }, deps.claimDeps);
    out.claim = claim;
    if (!claim.is_claim) return out;

    const dossier = await deps.claimDossier(claim.barcodes[0]);
    out.dossier = dossier;
    out.report = await stageClaimDocuments(item, dossier, deps, opts);
    return out;
  } catch (e) {
    if (deps && deps.audit) deps.audit("system", "claim_error", item && item.id, String(e.message || e).slice(0, 150));
    return out;
  }
}

module.exports = { mode, active, plan, stageClaimDocuments, handleInboundClaim, OBJ_AR_INVOICE, CS };
