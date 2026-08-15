// dash-style.test.js — 2026-08-15, Brad's house-style rule.
//
// An AI draft must never contain " — ". The SYSTEM prompt asks for it; this proves the
// deterministic pass enforces it regardless of what the model produced, that it leaves
// internal notes alone, and that it does not mangle numeric ranges or ordinary hyphens.
//
// Run: node dash-style.test.js
"use strict";
const { normaliseDashes, applyDashStyle, applyGates } = require("./engine.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("  FAIL:", m); } };
const EM = "—", EN = "–";
const clean = (s) => !/[‒–—―]/.test(s);

// ---------------------------------------------------------------- the dash itself
ok(normaliseDashes(`We have it in stock ${EM} it ships today.`) === "We have it in stock - it ships today.",
  "spaced em dash becomes a spaced hyphen");
ok(normaliseDashes(`stock${EM}today`) === "stock - today", "unspaced em dash is spaced out");
ok(normaliseDashes(`Bulb ${EN} 12V 1.2W`) === "Bulb - 12V 1.2W", "en dash handled the same way");
ok(clean(normaliseDashes(`a ${EM} b ${EN} c`)), "every dash in a string is replaced, not just the first");
ok(normaliseDashes(`a ${EM}${EM} b`) === "a - b", "a doubled dash collapses to one hyphen");

// ---------------------------------------------------------------- ranges keep the tight hyphen
ok(normaliseDashes(`Lead time is 2${EN}3 weeks.`) === "Lead time is 2-3 weeks.", "numeric range -> tight hyphen");
ok(normaliseDashes(`2 ${EM} 3 weeks`) === "2-3 weeks", "a spaced dash between numbers is still a range");
ok(normaliseDashes("Lead time is 2-3 weeks.") === "Lead time is 2-3 weeks.", "an existing plain range is untouched");

// ---------------------------------------------------------------- leave ordinary text alone
ok(normaliseDashes("Clutch master & slave: 550732 / 591231") === "Clutch master & slave: 550732 / 591231",
  "text with no dash is returned unchanged");
ok(normaliseDashes("[DA6030 - Service kit](https://www.roverparts.eu/products/da6030)")
  === "[DA6030 - Service kit](https://www.roverparts.eu/products/da6030)",
  "an existing ' - ' inside a markdown link is preserved");
ok(normaliseDashes("Met vriendelijke groet,\nTeam Budget Parts") === "Met vriendelijke groet,\nTeam Budget Parts",
  "a sign-off spanning lines is untouched");

// ---------------------------------------------------------------- dashes at the edges of a line
ok(normaliseDashes(`${EM} We will let you know.`) === "We will let you know.", "a line-opening dash is dropped, not left adrift");
ok(normaliseDashes(`We will let you know ${EM}`) === "We will let you know", "a line-closing dash is dropped");
ok(normaliseDashes(`line one ${EM}\nline two`) === "line one\nline two", "the drop is per line, not per string");

// ---------------------------------------------------------------- non-strings and empties
ok(normaliseDashes("") === "", "empty string survives");
ok(normaliseDashes(null) === null, "null passes through");
ok(normaliseDashes(undefined) === undefined, "undefined passes through");

// ---------------------------------------------------------------- slot selection
let r = applyDashStyle({
  status: "ready",
  draft: `In stock ${EM} ships today.`,
  interim_draft: `Partly answered ${EM} see below.`,
  ack_draft: `Thanks ${EM} glad it is sorted.`,
  withdrawn_draft: `Held text ${EM} kept verbatim.`,
  questions_for_salesperson: [`Check the shelf ${EM} is it there?`],
  physical_checks: [`Weigh it ${EM} over 30 kg?`],
});
ok(clean(r.draft), "draft is normalised");
ok(clean(r.interim_draft), "interim_draft is normalised");
ok(clean(r.ack_draft), "ack_draft is normalised");
ok(!clean(r.withdrawn_draft), "withdrawn_draft is NOT rewritten (read-only record of what was withheld)");
ok(!clean(r.questions_for_salesperson[0]), "internal questions are NOT rewritten");
ok(!clean(r.physical_checks[0]), "internal physical checks are NOT rewritten");

// ---------------------------------------------------------------- wired into the gate chain
r = applyGates({
  status: "ready", draft: `Order 227148 shipped on 29 June ${EM} here is the tracking.`,
  interim_draft: "", questions_for_salesperson: [], physical_checks: [], confidence: "high",
}, {});
ok(clean(r.draft), "applyGates runs the dash pass on a clean ready draft");

// A draft the accuracy gates HOLD must still leave no dash in whatever ends up customer-facing.
r = applyGates({
  status: "ready", draft: `This matches your VIN perfectly ${EM} it is the right part.`,
  interim_draft: `We do stock it ${EM} price on request.`,
  questions_for_salesperson: [], physical_checks: [], confidence: "high",
}, {});
ok(clean(r.draft || "") && clean(r.interim_draft || ""),
  "style still applies after a gate has moved text between slots");

// ---------------------------------------------------------------- negative control
// Removing applyDashStyle from the chain must fail these; prove the pass is what is doing the work.
ok(!clean(`In stock ${EM} ships today.`), "control: the raw fixture really does contain an em dash");

console.log(`\ndash-style: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
