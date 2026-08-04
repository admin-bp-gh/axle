// fitment-gate.test.js — P1.4: prove applyFitmentGate enforces the confidence gate deterministically.
// It must, ONLY when fitment_confirmed === false, demote an unconfirmed part out of a READY draft
// into an interim holding reply (keeping the model's own interim if present, else salvaging the
// draft), hold for input, guarantee a confirmation question, and cap confidence — and be a no-op for
// true / 'n/a' / unset. Run: node fitment-gate.test.js
"use strict";
const { applyFitmentGate } = require("./engine.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("  FAIL:", m); } };

// 1) false + ready + asserting draft, no interim -> draft salvaged into interim, held, question added, confidence capped
let r = applyFitmentGate({ status: "ready", draft: "The correct part is BTR9641.", interim_draft: "", questions_for_salesperson: [], physical_checks: [], fitment_confirmed: false, confidence: "high" });
ok(r.status === "awaiting_input", "false+ready -> awaiting_input");
ok(r.draft === "", "asserting draft cleared from the ready slot");
ok(r.interim_draft === "The correct part is BTR9641.", "draft salvaged into interim (research not lost)");
ok(r.questions_for_salesperson.length === 1, "a confirmation question is guaranteed");
ok(r.confidence === "medium", "high confidence capped to medium");

// 2) false + ready, model ALSO wrote a proper interim -> keep the model's interim, don't overwrite
r = applyFitmentGate({ status: "ready", draft: "It is BTR9641.", interim_draft: "We think BTR9641 fits — can you confirm your VIN?", questions_for_salesperson: ["Confirm VIN"], physical_checks: [], fitment_confirmed: false, confidence: "medium" });
ok(r.status === "awaiting_input" && r.draft === "", "demoted to awaiting_input, draft cleared");
ok(r.interim_draft === "We think BTR9641 fits — can you confirm your VIN?", "model's own interim preserved (not overwritten)");
ok(r.questions_for_salesperson.length === 1, "existing question kept, none duplicated");

// 3) false + already awaiting_input with a physical check -> no draft move, no forced extra question, confidence capped
r = applyFitmentGate({ status: "awaiting_input", draft: "", interim_draft: "holding reply", questions_for_salesperson: [], physical_checks: ["Check the old part's stamping"], fitment_confirmed: false, confidence: "high" });
ok(r.status === "awaiting_input" && r.interim_draft === "holding reply", "already-held item untouched");
ok(r.questions_for_salesperson.length === 0, "physical check counts as a check — no question forced");
ok(r.confidence === "medium", "confidence still capped");

// 4) true + ready -> completely untouched (a confirmed part may be asserted)
r = applyFitmentGate({ status: "ready", draft: "BTR9641 fits your 2008 Defender.", interim_draft: "", questions_for_salesperson: [], physical_checks: [], fitment_confirmed: true, confidence: "high" });
ok(r.status === "ready" && r.draft.startsWith("BTR9641") && r.confidence === "high", "fitment_confirmed=true -> no-op");

// 5) 'n/a' and unset -> no-op
ok(applyFitmentGate({ status: "ready", draft: "Yes, in stock.", fitment_confirmed: "n/a", confidence: "high" }).status === "ready", "'n/a' -> no-op");
ok(applyFitmentGate({ status: "ready", draft: "Yes, in stock.", confidence: "high" }).status === "ready", "missing field -> no-op");

// 6) false + low confidence stays low (only 'high' is capped)
ok(applyFitmentGate({ status: "awaiting_input", interim_draft: "x", questions_for_salesperson: ["q"], fitment_confirmed: false, confidence: "low" }).confidence === "low", "low confidence left as-is");

console.log(`\n${pass}/${pass + fail} asserts passed` + (fail ? `  (${fail} FAILED)` : "  ✓"));
process.exit(fail ? 1 : 0);
