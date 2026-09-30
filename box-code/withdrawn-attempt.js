// withdrawn-attempt.js - what to do with a draft the accuracy gates pulled (item #2368, 2026-09-30).
//
// When a gate withdraws a draft, the salesperson saw an empty reply box and "Save & redraft" gave
// them the same empty box again: the model re-anchored the reply on the VIN each time, the claim
// gate withdrew it each time, and nothing on the page said so. Two consumers fix that:
//
//   previousAttempt(...)  -> the seed block a REDRAFT hands the model: the withdrawn text, the
//                            offending fragments and the reasons, so it writes a fresh reply
//                            without repeating the claim.
//   withdrawnNotice(...)  -> the reason codes the item page turns into a short notice above the
//                            empty box, so an empty box is never silent.
//
// Both are pure: they take the rows, they return data. Reasons are re-derived from the withdrawn
// text with the engine's own patterns, so this never depends on question wording.
const { VIN_CLAIM_PATTERNS, SOURCING_CLAIM_PATTERNS } = require("./engine.js");
const DS = require("./draft-staleness.js");

const AVAIL_Q = /^Check availability with the supplier for /;

function matchAll(patterns, text) {
  const s = String(text || "");
  const out = [];
  for (const re of patterns) { const m = s.match(re); if (m) out.push(m[0].trim()); }
  return out;
}

// The withdrawn row counts only when it is the LATEST run's (same version as the newest AI
// draft row of any kind) and was written for the current email (not superseded by a newer one).
function isCurrentWithdrawn(item, withdrawnRow, latestVersion) {
  if (!withdrawnRow) return false;
  if (latestVersion && withdrawnRow.version !== latestVersion) return false;
  return !DS.isSupersededDraft(item, withdrawnRow);
}

// reasons: 'vin' | 'sourcing' | 'availability'. offending: the matched fragments (for the model).
function analyse(item, withdrawnRow, latestVersion, openQuestions = []) {
  if (!isCurrentWithdrawn(item, withdrawnRow, latestVersion)) return null;
  const text = String(withdrawnRow.body || "");
  const vin = matchAll(VIN_CLAIM_PATTERNS, text);
  const src = matchAll(SOURCING_CLAIM_PATTERNS, text);
  const avail = openQuestions.map((q) => String(q.question || q)).filter((q) => AVAIL_Q.test(q));
  const reasons = [];
  if (vin.length) reasons.push("vin");
  if (src.length) reasons.push("sourcing");
  if (avail.length) reasons.push("availability");
  if (!reasons.length) return null;   // withdrawn for a reason we cannot name: say nothing rather than guess
  return { reasons, offending: [...vin, ...src], availability: avail, text };
}

const REASON_NOTE = {
  vin: "it stated or implied that something was checked, confirmed or derived from the customer's VIN / chassis number. We cannot decode a VIN (model year only). Do NOT reference the VIN in the reply at all beyond thanking them for it; the salesperson verifies fitment on JLR EPC before sending.",
  sourcing: "it told the customer how we source the part (drop-ship / direct from a supplier). Never describe sourcing; give the lead time only.",
  availability: "it named a part whose availability is unknown (out of stock, not a stock-order item). Unless the salesperson feedback settles availability, do not promise a lead time for it.",
};

// Seed block for a redraft. null when there is nothing to say.
function previousAttempt(item, withdrawnRow, latestVersion, openQuestions) {
  const a = analyse(item, withdrawnRow, latestVersion, openQuestions);
  if (!a) return null;
  return {
    note: "Your PREVIOUS draft for this email was WITHDRAWN by an automated check and was never shown to the salesperson or the customer. Write a fresh reply that does not repeat the problem. Reasons: "
      + a.reasons.map((r) => REASON_NOTE[r]).join(" "),
    offending_fragments: a.offending,
    withdrawn_text: a.text.slice(0, 4000),
  };
}

// For the item page: reason codes + the withdrawn text (reference only). null when nothing to show.
function withdrawnNotice(item, withdrawnRow, latestVersion, openQuestions) {
  const a = analyse(item, withdrawnRow, latestVersion, openQuestions);
  return a ? { reasons: a.reasons, text: a.text } : null;
}

module.exports = { previousAttempt, withdrawnNotice, analyse, isCurrentWithdrawn };
