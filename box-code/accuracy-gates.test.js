// accuracy-gates.test.js — 2026-08-12, from item 1249.
//
// That draft told a customer the part "matches your VIN perfectly" (we cannot decode a VIN
// beyond the model year) and that it "ships directly from our supplier" (untrue — invented
// from a tool field named `dropship`). Both were confident, customer-ready and unverifiable.
// These asserts prove the deterministic gates catch each class regardless of what the model
// reports about itself, and that they stay quiet on drafts that are actually fine.
//
// Run: node accuracy-gates.test.js
"use strict";
const {
  applyClaimGate, applyAvailabilityGate, applyVinCheck, applyGates, collectItemFacts,
} = require("./engine.js");
const { availabilityOf } = require("./connectors.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("  FAIL:", m); } };
const ready = (draft) => ({ status: "ready", draft, interim_draft: "", questions_for_salesperson: [], physical_checks: [], confidence: "high" });

// ---------------------------------------------------------------- availabilityOf
ok(availabilityOf(3, "N").state === "in_stock", "OnHand>0 -> in_stock regardless of the flag");
ok(availabilityOf(0, "Y").state === "order_in", "no stock + DropShip Y -> order_in");
ok(availabilityOf(0, "y").state === "order_in", "flag comparison is case-insensitive");
ok(availabilityOf(0, "N").state === "check_first", "no stock + DropShip N -> check_first");
ok(availabilityOf(0, null).state === "check_first", "no stock + missing flag -> check_first (fail safe)");
ok(/2-3 weeks/.test(availabilityOf(0, "Y").statement), "order_in statement carries the 2-3 week lead time");
ok(!/direct/i.test(availabilityOf(0, "Y").statement), "order_in statement never suggests direct supply");
ok(/salesperson must check/i.test(availabilityOf(0, "N").statement), "check_first statement demands a human check");

// Purchasing ETA tiers (dbo.vw_ItemEta). "now" is pinned so the week count is deterministic.
const NOW = Date.UTC(2026, 9, 8);
const eta = (Confidence, FreeInboundQty = 4, NextFreeEta = new Date(Date.UTC(2026, 9, 21))) => ({ FreeInboundQty, NextFreeEta, Confidence });
let av = availabilityOf(0, "N", eta("confirmed"), NOW);
ok(av.state === "eta_confirmed" && /Expected in stock 21 Oct\./.test(av.statement), "confirmed -> the date");
av = availabilityOf(0, "Y", eta("estimated"), NOW);
ok(av.state === "eta_estimated" && /around 2 weeks/.test(av.statement), "estimated -> around N weeks");
ok(!/21|Oct\b/.test(av.statement), "estimated statement carries no date");
ok(/around 1 week\./.test(availabilityOf(0, "Y", eta("estimated", 1, new Date(Date.UTC(2026, 9, 9))), NOW).statement), "estimated is never under a week");
av = availabilityOf(0, "N", eta("none", 2, null), NOW);
ok(av.state === "order_in" && /2-3 weeks/.test(av.statement), "none -> the standard 2-3 weeks, whatever the DropShip flag");
ok(availabilityOf(2, "Y", eta("confirmed"), NOW).state === "in_stock", "stock on hand wins over inbound");
ok(availabilityOf(0, "Y", eta("confirmed", 0), NOW).state === "order_in", "inbound fully allocated to back orders -> DropShip rule");
ok(availabilityOf(0, "N", { FreeInboundQty: null, NextFreeEta: null, Confidence: null }, NOW).state === "check_first", "no view row (LEFT JOIN nulls) -> DropShip rule");

// ---------------------------------------------------------------- claim gate: VIN
// The exact sentence from item 1249.
let r = applyClaimGate(ready("Yes, the IAB000033E is the correct unit for your 2005 Range Rover L322 with the M57 3.0 diesel and 5-speed Steptronic automatic — it matches your VIN perfectly."));
ok(r.status === "awaiting_input", "item 1249's VIN claim is held, not sent");
ok(r.draft === "" && /matches your VIN/.test(r.withdrawn_draft), "held draft kept as read-only withdrawn reference");
ok(!r.interim_draft, "the withdrawn text never becomes the sendable interim");
ok(r.questions_for_salesperson.some((q) => /EPC/i.test(q)), "salesperson is told to confirm on EPC");
ok(r.confidence === "medium", "confidence capped off high");

ok(applyClaimGate(ready("Your VIN confirms this is the 3.0 diesel.")).status === "awaiting_input", "'VIN confirms' held");
ok(applyClaimGate(ready("Based on your VIN, you need BTR9641.")).status === "awaiting_input", "'based on your VIN' held");
ok(applyClaimGate(ready("I checked against the chassis number and it fits.")).status === "awaiting_input", "'checked against the chassis number' held");
ok(applyClaimGate(ready("Volgens uw chassisnummer is dit het juiste onderdeel.")).status === "awaiting_input", "Dutch 'volgens uw chassisnummer' held");
ok(applyClaimGate(ready("Laut Ihrer FIN passt dieses Teil.")).status === "awaiting_input", "German 'laut Ihrer FIN' held");

// Legitimate VIN talk must NOT be held — we are allowed to ASK for one.
ok(applyClaimGate(ready("Could you send me your VIN so we can check the exact fitment?")).status === "ready", "asking for a VIN is fine");
ok(applyClaimGate(ready("Thanks for the VIN. Our catalogue lists this part for the L322 3.0 diesel, which is what you describe.")).status === "ready", "attributed catalogue fitment beside a VIN mention is fine");

// ---------------------------------------------------------------- claim gate: sourcing
r = applyClaimGate(ready("The part is currently not on our shelf; it ships directly from our supplier. Lead time is approximately 2–3 weeks."));
ok(r.status === "awaiting_input", "item 1249's direct-from-supplier claim is held");
ok(r.questions_for_salesperson.some((q) => /lead time only/i.test(q) || /source/i.test(q)), "question explains the sourcing problem");

ok(applyClaimGate(ready("It will be sent direct from the manufacturer.")).status === "awaiting_input", "'direct from the manufacturer' held");
ok(applyClaimGate(ready("Our supplier will ship it to you next week.")).status === "awaiting_input", "'our supplier will ship it' held");
ok(applyClaimGate(ready("Dit wordt rechtstreeks door onze leverancier verzonden.")).status === "awaiting_input", "Dutch direct-supplier claim held");
ok(applyClaimGate(ready("We drop-ship this one.")).status === "awaiting_input", "internal jargon 'drop-ship' never reaches a customer");

// The CORRECT wording must pass untouched.
r = applyClaimGate(ready("This one is not in stock — we order it in for you, lead time 2 to 3 weeks."));
ok(r.status === "ready" && r.draft !== "", "the approved lead-time wording passes");
ok(applyClaimGate(ready("Niet op voorraad; we bestellen hem voor u, levertijd 2 tot 3 weken.")).status === "ready", "Dutch approved wording passes");
ok(applyClaimGate(ready("We have shipped your order, tracking is below.")).status === "ready", "ordinary shipping talk is not a sourcing claim");

// ---------------------------------------------------------------- availability gate
const facts = { items: new Map() };
collectItemFacts("part_dossier", {
  items: [
    { item_code: "IAB000033E", customer_code: "IAB000033E", availability: availabilityOf(0, "N") },
    { item_code: "STC1234", customer_code: "AM-STC1234", availability: availabilityOf(0, "Y") },
  ],
}, facts);
ok(facts.items.get("IAB000033E").state === "check_first", "dossier facts collected by item code");
ok(facts.items.get("AM-STC1234").state === "order_in", "facts also keyed by the customer-facing code");

r = applyAvailabilityGate(ready("IAB000033E is available, lead time 2-3 weeks."), facts);
ok(r.status === "awaiting_input", "a check_first part mentioned in the draft holds it");
ok(r.questions_for_salesperson.some((q) => /availability/i.test(q)), "question asks for a supplier availability check");

ok(applyAvailabilityGate(ready("AM-STC1234 is not in stock; we order it in, 2-3 weeks."), facts).status === "ready", "an order_in part is not held");
ok(applyAvailabilityGate(ready("Your order shipped this morning."), facts).status === "ready", "a draft naming no gated part is untouched");
ok(applyAvailabilityGate(ready("iab000033e please"), facts).status === "awaiting_input", "code matching is case-insensitive");
ok(applyAvailabilityGate(ready("anything"), { items: new Map() }).status === "ready", "no facts -> no-op");

// part_finder candidates feed the same store.
const f2 = { items: new Map() };
collectItemFacts("part_finder", { candidates: [{ item_code: "X1", customer_code: "X1", availability: availabilityOf(0, "N") }] }, f2);
ok(f2.items.get("X1").state === "check_first", "finder candidates collected too");
collectItemFacts("sap_query", null, f2);
ok(f2.items.size === 1, "a null/odd tool result never throws or pollutes the facts");

// ---------------------------------------------------------------- VIN -> EPC check
const VIN = "SALLMAMC45A193273";
r = applyVinCheck(ready("Our catalogue lists this for the L322 3.0 diesel."), `FIN: ${VIN}`);
ok(r.status === "ready", "a VIN in the email does not by itself hold the draft (agreed policy)");
ok(r.physical_checks.some((c) => c.includes(VIN)), "an EPC verification check is attached, naming the VIN");

r = applyVinCheck(ready("x"), "no vin here");
ok(r.physical_checks.length === 0, "no VIN in the email -> no check added");
r = applyVinCheck({ status: "ready", draft: "x", physical_checks: ["Verify on EPC for the VIN given"], questions_for_salesperson: [] }, VIN);
ok(r.physical_checks.length === 1, "an existing EPC check is not duplicated");
r = applyVinCheck({ status: "awaiting_input", draft: "", interim_draft: "", physical_checks: [], questions_for_salesperson: [] }, VIN);
ok(r.physical_checks.length === 0, "nothing drafted -> nothing to verify");

// ---------------------------------------------------------------- end to end
// Item 1249's actual output, through the whole gate chain.
r = applyGates({
  status: "ready", confidence: "high", fitment_confirmed: "n/a",
  draft: "Yes, the IAB000033E – Transfer Box NVG225 is the correct unit for your 2005 Range Rover L322 with the M57 3.0 diesel and 5-speed Steptronic automatic — it matches your VIN perfectly.\n\nThe part is currently not on our shelf; it ships directly from our supplier. Lead time is approximately 2–3 weeks.",
  interim_draft: "", questions_for_salesperson: [], physical_checks: [],
}, { senderAddr: "info@heckers-blechkultur.de", facts, emailText: `when is the Transfer Box ready? FIN: ${VIN}` });
ok(r.status === "awaiting_input", "1249 end-to-end: no longer sendable");
ok(r.draft === "", "1249 end-to-end: the asserting draft is out of the ready slot");
ok(r.withdrawn_draft.includes("NVG225"), "1249 end-to-end: research preserved as read-only reference");
ok(!r.interim_draft, "1249 end-to-end: nothing sendable carries the withdrawn claims");
ok(r.questions_for_salesperson.length >= 2, "1249 end-to-end: both problems raised (VIN claim + sourcing claim)");
ok(r.physical_checks.some((c) => c.includes(VIN)), "1249 end-to-end: EPC check on the VIN attached");
ok(r.confidence === "medium", "1249 end-to-end: confidence no longer high");

// ---------------------------------------------------------------- the interim is sendable too
// Item 1249, second pass: the gates matched a bad INTERIM but only ever cleared `draft`, so the
// offending sentences stayed in the send box. Each slot must be withdrawn independently.
r = applyClaimGate({ status: "awaiting_input", draft: "", interim_draft: "It is a drop-ship item ordered in from our supplier, so the lead time is 2-3 weeks. Based on your VIN, your Range Rover is a 2005 L322.", questions_for_salesperson: [], physical_checks: [], confidence: "high" });
ok(r.interim_draft === "", "a bad interim is emptied, not merely flagged");
ok(/drop-ship item/.test(r.withdrawn_draft), "the bad interim text is kept as read-only reference");
ok(r.questions_for_salesperson.length === 2, "both problems in the interim are raised");

// Bad draft AND bad interim -> both withdrawn, both preserved.
r = applyClaimGate({ status: "ready", draft: "It matches your VIN perfectly.", interim_draft: "We drop-ship this one.", questions_for_salesperson: [], physical_checks: [], confidence: "high" });
ok(r.draft === "" && r.interim_draft === "", "both sendable slots emptied");
ok(/matches your VIN/.test(r.withdrawn_draft) && /drop-ship/.test(r.withdrawn_draft), "both withdrawn texts preserved");
ok(r.status === "awaiting_input", "held");

// A clean interim beside a bad draft must be left alone.
r = applyClaimGate({ status: "ready", draft: "It matches your VIN perfectly.", interim_draft: "The part is €680 excl. VAT.", questions_for_salesperson: [], physical_checks: [], confidence: "high" });
ok(r.interim_draft === "The part is €680 excl. VAT.", "a clean interim survives a withdrawn draft");
ok(!/€680/.test(r.withdrawn_draft || ""), "the clean interim is not swept into the withdrawn text");

// Availability gate withdraws per slot too.
r = applyAvailabilityGate({ status: "ready", draft: "", interim_draft: "IAB000033E is not in stock; lead time 2-3 weeks.", questions_for_salesperson: [], physical_checks: [], confidence: "high" }, facts);
ok(r.interim_draft === "" && /IAB000033E/.test(r.withdrawn_draft), "a check_first claim in the interim is withdrawn");

// A model-written interim is current-run output and must survive a hold untouched — it is what
// the salesperson now sees in the send box, so the gates must not clobber or contaminate it.
r = applyGates({
  status: "ready", confidence: "high", fitment_confirmed: "n/a",
  draft: "It matches your VIN perfectly and ships directly from our supplier.",
  interim_draft: "The NVG225 transfer box is €680 excl. VAT. I'll confirm the fitment for your car and come back to you.",
  questions_for_salesperson: [], physical_checks: [],
}, { senderAddr: "x@y.com", facts, emailText: `FIN: ${VIN}` });
ok(r.status === "awaiting_input", "held despite a clean interim being present");
ok(r.interim_draft.startsWith("The NVG225 transfer box is"), "the model's own interim is preserved verbatim");
ok(!/matches your VIN/.test(r.interim_draft), "the withdrawn claim never leaks into the interim");
ok(/matches your VIN/.test(r.withdrawn_draft), "the offending draft is withdrawn, not discarded");

// A clean draft must survive the whole chain untouched.
const clean = applyGates({
  status: "ready", confidence: "high", fitment_confirmed: "n/a",
  draft: "Your order went out this morning. Tracking is in the link below.",
  interim_draft: "", questions_for_salesperson: [], physical_checks: [],
}, { senderAddr: "someone@example.com", facts, emailText: "where is my order?" });
ok(clean.status === "ready" && clean.confidence === "high", "a clean draft passes every gate untouched");

// ---------------------------------------------------------------- Supplier facts (AI parity Step E3)
const E3 = require("./engine.js");
const FVIN = "SALLDHMF7AA123456";

// extractFactsInput: Workbench's code rules, the VIN, the model and the quantity.
let fi = E3.extractFactsInput(
  { subject: "Parts STC1234", text: `I need 2 stuks LR017952, 123456 and 12345 for my Defender from 2010 (300TDI). Order #S12345, mail jan.LR012345@example.nl, see https://www.roverparts.eu/products/ERR5205 or www.example.com/ANR1234. VIN ${FVIN}` },
  [{ text: "earlier: NTC1234 and -STC500-" }], { partNumbers: ["ESR4238"], sapStock: [{ ItemCode: "FTC5201" }] });
ok(JSON.stringify(fi.codes.map((c) => c.code)) === JSON.stringify(["STC1234", "LR017952", "123456", "NTC1234", "STC500", "ESR4238", "FTC5201"]),
  "codes: first appearance, a 6-digit numeric kept, 12345, 300TDI, the email, the links and #S12345 dropped, dashes trimmed, seed codes last: " + JSON.stringify(fi.codes));
ok(fi.vin === FVIN, "the VIN");
ok(fi.modelText === "Defender 2010", "family plus a year within 40 characters: " + fi.modelText);
ok(fi.quantity === 2, "'2 stuks' is a quantity of 2");
fi = E3.extractFactsInput({ subject: "", text: "Front pads x3 for my Range Rover Sport please" }, [], {});
ok(fi.modelText === "Range Rover Sport" && fi.quantity === 3 && fi.vin === null && !fi.codes.length, "Range Rover Sport without a year, x3, no VIN: " + JSON.stringify(fi));
fi = E3.extractFactsInput({ subject: "Hello", text: "Do you ship to Belgium?" }, [], { sapStock: { error: "down" } });
ok(fi.quantity === 1 && fi.modelText === null && fi.vin === null && !fi.codes.length, "nothing found: quantity 1, the rest empty");
ok(E3.extractFactsInput({ subject: "", text: "Freelander 2 front discs" }, [{ text: "a 2008 Discovery 3" }], {}).modelText === "Freelander 2", "the email before the thread");
const shapes = E3.extractCodes("Order S12345 to 2801AB, PO I214556349; parts LR089625, 1A621960 and STC4380");
ok(JSON.stringify(shapes) === JSON.stringify(["LR089625", "1A621960", "STC4380"]), "an order name without its hash, a Dutch postcode and a letter before 8+ digits dropped, real codes kept: " + JSON.stringify(shapes));

// applySupplierGate: flag mode only, one question per distinct problem.
const held = (draft) => ({ status: "ready", draft, interim_draft: "", questions_for_salesperson: [], physical_checks: [], confidence: "high", flags: [] });
const vctx = (results, extra = {}) => ({ flagMode: true, verify: { byCode: new Map(results.map((x) => [x.code, x])), problems: [], vehicleKnown: true, quantity: 1, vehicle: null, codes: [], ...extra } });
const vres = (code, fitment, availability, inRange = true) => ({ code, fitment, availability, inRange });
r = E3.applySupplierGate(held("STC1234 fits your Defender and is in stock."), vctx([vres("STC1234", "fits", "in_stock_own")]));
ok(r.status === "ready" && !r.flags.length && !r.questions_for_salesperson.length, "fits and in stock: nothing trips");
r = E3.applySupplierGate(held("STC1234 is orderable."), vctx([vres("STC1234", "fits_model", "orderable")]));
ok(r.status === "ready" && !r.flags.length, "fits_model and orderable: nothing trips");
r = E3.applySupplierGate(held("STC1234 fits your Defender."), vctx([vres("STC1234", "no_fit", "in_stock_own")]));
ok(r.status === "awaiting_input" && r.interim_draft.includes("STC1234") && r.draft === "", "no_fit with a vehicle: held in place");
ok(r.flags.length === 1 && r.flags[0].gate === "fitment" && r.flags[0].fragment === "STC1234", "no_fit: one fitment flag on the code");
ok(r.questions_for_salesperson.length === 1 && /the catalogue says it does not fit/.test(r.questions_for_salesperson[0]), "no_fit: the blocking question names the verdict");
r = E3.applySupplierGate(held("STC1234 should suit it."), vctx([vres("STC1234", "conditional", "in_stock_own")]));
ok(/it depends on the VIN or build/.test(r.questions_for_salesperson[0]), "conditional: its own wording");
r = E3.applySupplierGate(held("STC1234 is in stock."), vctx([vres("STC1234", "unknown", "in_stock_own")], { vehicleKnown: false }));
ok(r.status === "ready" && !r.flags.length, "unknown fitment without a vehicle: nothing trips on fitment");
r = E3.applySupplierGate(held("STC1234 is in stock."), vctx([vres("STC1234", "unknown", "in_stock_own")]));
ok(/fitment unknown/.test(r.questions_for_salesperson[0]), "unknown fitment with a vehicle, in our range: fitment unknown");
r = E3.applySupplierGate(held("STC1234 is in stock."), vctx([vres("STC1234", "unknown", "in_stock_own", false)]));
ok(r.status === "ready" && !r.flags.length, "unknown fitment with a vehicle, not in our range: nothing trips");
r = E3.applySupplierGate(held("STC1234 fits your Defender."), vctx([vres("STC1234", "no_fit", "in_stock_own", false)]));
ok(r.flags.length === 1 && r.flags[0].gate === "fitment", "no_fit outside our range still trips fitment");
r = E3.applySupplierGate(held("STC1234 can be ordered."), vctx([vres("STC1234", "fits", "not_available")]));
ok(r.flags.length === 1 && r.flags[0].gate === "availability" && /cannot be ordered/.test(r.questions_for_salesperson[0]), "not_available trips availability");
r = E3.applySupplierGate(held("STC1234 can be ordered."), vctx([vres("STC1234", "fits", "not_available", false)]));
ok(r.flags.length === 1 && r.flags[0].gate === "availability", "not_available outside our range still trips availability");
r = E3.applySupplierGate(held("STC1234 is available."), vctx([vres("STC1234", "fits", "unknown", false)]));
ok(r.status === "ready" && !r.flags.length, "unknown availability outside our range: nothing trips");
const below = [{ asked: "STC1234", current: "STC1234", availability: { verdict: "unknown", qty: 2, own: { gou: 1, dra: 0 } } }];
r = E3.applySupplierGate(held("STC1234 is available."), vctx([vres("STC1234", "fits", "unknown")], { codes: below }));
ok(r.flags.length === 1 && r.flags[0].gate === "availability" && /could not be confirmed as orderable/.test(r.questions_for_salesperson[0]), "unknown with own stock below the quantity trips availability");
const covers = [{ asked: "LR000001", current: "STC1234", availability: { verdict: "unknown", qty: 2, own: { gou: 1, dra: 1 } } }];
r = E3.applySupplierGate(held("STC1234 is available."), vctx([vres("STC1234", "fits", "unknown")], { codes: covers }));
ok(r.status === "ready" && !r.flags.length, "unknown with own stock covering the quantity (found by its current code): nothing trips");
r = E3.applySupplierGate(held("STC1234 is available."), vctx([vres("STC1234", "fits", "unknown")]));
ok(r.flags.length === 1, "unknown with no stock figure anywhere counts as below");
r = held("STC1234 and again STC1234.");
r.interim_draft = "STC1234 interim";
E3.applySupplierGate(r, vctx([vres("STC1234", "no_fit", "not_available")]));
E3.applySupplierGate(r, vctx([vres("STC1234", "no_fit", "not_available")]));
ok(r.questions_for_salesperson.length === 2 && r.flags.length === 2, "one question and one flag per problem, however often the code is named or the gate runs");
r = E3.applySupplierGate(held("STC1234 fits."), { ...vctx([vres("STC1234", "no_fit", "not_available")]), flagMode: false });
ok(r.status === "ready" && !r.flags.length, "json mode: the gate does nothing");
r = E3.applySupplierGate(held("NTC9999 fits."), vctx([vres("STC1234", "no_fit", "not_available")]));
ok(r.status === "ready", "a checked code the reply does not name trips nothing");

// applyAvailabilityGate: a check_first code that Workbench checked is left to applySupplierGate.
const cf = { items: new Map([["STC1234", { state: "check_first", label: "STC1234" }]]) };
r = applyAvailabilityGate(held("STC1234 is available."), cf, true, vctx([vres("STC1234", "fits", "orderable")]).verify);
ok(r.status === "ready" && !r.flags.length, "a verified code skips the check_first trip");
r = applyAvailabilityGate(held("STC1234 is available."), cf, true);
ok(r.flags.length === 1 && r.flags[0].gate === "availability", "without verify the check_first trip stands");

// applyVinCheck: skipped when the block decoded this VIN in EPC and every checked code named fits.
const decoded = (fitment, source = "epc") => ({ ...vctx([vres("STC1234", fitment, "in_stock_own")]).verify, vehicle: { vin: FVIN, source } });
r = applyVinCheck(held("STC1234 fits your Defender."), `VIN ${FVIN}`, new Set(), decoded("fits"));
ok(!r.physical_checks.length, "decoded VIN, the named code fits: no EPC check asked");
r = applyVinCheck(held("STC1234 fits your Defender."), `VIN ${FVIN}`, new Set(), decoded("fits_model"));
ok(r.physical_checks.length === 1, "fits_model is not a VIN-level fit: the EPC check stays");
r = applyVinCheck(held("STC1234 fits your Defender."), `VIN ${FVIN}`, new Set(), decoded("fits", "text"));
ok(r.physical_checks.length === 1, "a VIN EPC did not decode: the EPC check stays");
r = applyVinCheck(held("Thanks for the VIN."), `VIN ${FVIN}`, new Set(), decoded("fits"));
ok(r.physical_checks.length === 1, "no checked code named: the EPC check stays");

// Drift: SYSTEM_PROSE_FACTS is SYSTEM_PROSE with the SUPPLIER FACTS line after PART LOOKUP and two phrases replaced.
const pl = E3.SYSTEM_PROSE_FACTS.split("\n");
const at = pl.findIndex((l) => l.startsWith("PART LOOKUP:"));
ok(at >= 0 && pl[at + 1] === E3.SUPPLIER_FACTS_RULE, "the SUPPLIER FACTS line follows PART LOOKUP");
ok(E3.SYSTEM_PROSE_FACTS.includes("or unless <supplier_facts> says confirmed for that code and vehicle."), "the confidence gate accepts the block");
ok(E3.SYSTEM_PROSE_FACTS.includes("the <supplier_facts> block already decodes a VIN found in the email; call epc_vin_decode only for a VIN that is not in it."), "the VIN rule defers to the block");
ok(!E3.SYSTEM_PROSE_FACTS.includes("call epc_vin_decode FIRST.") && E3.SYSTEM_PROSE.includes("call epc_vin_decode FIRST."), "replaced in the facts prompt only");
ok(pl.length === E3.SYSTEM_PROSE.split("\n").length + 1, "one line added, nothing else");
ok(!/[\u2012-\u2015]/.test(E3.SUPPLIER_FACTS_RULE), "no dashes in the new rule");
ok([E3.SYSTEM_PROSE, E3.SYSTEM_PROSE_FACTS].every((p) => p.includes("the manufacturer's records list") && !p.includes("what JLR's catalogue lists")), "the VIN rule names no catalogue to the customer");

console.log(`\n${pass}/${pass + fail} asserts passed` + (fail ? `  (${fail} FAILED)` : "  ✓"));
process.exit(fail ? 1 : 0);
