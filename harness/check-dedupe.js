// Standalone check of saveRequest's NEW dedupe-selection logic (verbatim copy of the changed
// lines in sprocket-store.js). Used because the sandbox file-mount truncates the edited store;
// the deployed file's full syntax is validated by node --check on the box. The overlap path and
// md mirror are already covered by harness-sprocket-step2.js (22/22).
const OPEN = new Set(["new", "approved", "in_progress"]);

// stand-in for findSimilarOpen: only matches when goals literally share the word "invoice"
const findSimilarOpen = (goal, reqs) => reqs.find((r) => OPEN.has(r.status) && /invoice/.test(goal) && /invoice/.test(r.goal)) || null;

function selectAndVote(requests, fields) {
  let match = null;
  const dupeId = String(fields.dupe_of || "").trim();
  if (dupeId) match = requests.find((r) => r.id === dupeId && OPEN.has(r.status)) || null;
  if (!match && fields.goal) match = findSimilarOpen(fields.goal, requests);
  if (match) {
    match.also_requested_by = Array.isArray(match.also_requested_by) ? match.also_requested_by : [];
    const already = fields.requester === match.requester || match.also_requested_by.includes(fields.requester);
    if (fields.requester && !already) match.also_requested_by.push(fields.requester);
    match.votes = 1 + match.also_requested_by.length;
    return { deduped: true, selfDupe: already, id: match.id, votes: match.votes };
  }
  return { deduped: false };
}

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log("  FAIL:", n); } };
const fresh = () => [{ id: "FR-0001", status: "new", requester: "Jack", votes: 1, also_requested_by: [], goal: "SMS when order ships" }];

// dupe_of folds a paraphrased goal (no shared words) onto the open id, different requester -> +1
(() => { const r = selectAndVote(fresh(), { goal: "text when parcel dispatched", dupe_of: "FR-0001", requester: "Rob" });
  ok(r.deduped && r.id === "FR-0001" && r.selfDupe === false && r.votes === 2, "dupe_of folds paraphrase, +1 for new requester"); })();

// same requester via dupe_of -> self-dupe, no vote inflation
(() => { const r = selectAndVote(fresh(), { goal: "x", dupe_of: "FR-0001", requester: "Jack" });
  ok(r.deduped && r.selfDupe === true && r.votes === 1, "self-dupe doesn't inflate"); })();

// dupe_of an unknown id, no overlap -> new record
(() => { const r = selectAndVote(fresh(), { goal: "label printer support", dupe_of: "FR-9999", requester: "Tom" });
  ok(r.deduped === false, "unknown dupe_of + no overlap -> new"); })();

// dupe_of a CLOSED id is ignored; falls back to overlap (here also none) -> new
(() => { const reqs = [{ id: "FR-0001", status: "declined", requester: "Jack", votes: 1, also_requested_by: [], goal: "unpaid invoice chasing" }];
  const r = selectAndVote(reqs, { goal: "chase the unpaid invoice", dupe_of: "FR-0001", requester: "Rob" });
  ok(r.deduped === false, "dupe_of a CLOSED id ignored -> new (overlap only matches OPEN)"); })();

// no dupe_of, deterministic overlap still works (safety net)
(() => { const r = selectAndVote([{ id: "FR-0001", status: "new", requester: "Jack", votes: 1, also_requested_by: [], goal: "chase the invoice" }], { goal: "automatically chase an invoice", requester: "Rob" });
  ok(r.deduped && r.id === "FR-0001", "overlap fallback still dedupes when no dupe_of"); })();

console.log(`check-dedupe: ${pass}/${pass + fail} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
