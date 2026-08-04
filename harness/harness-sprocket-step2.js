// harness-sprocket-step2.js — sandbox proof for Sprocket STEP 2 (request mode + the request log).
// Run: node harness/harness-sprocket-step2.js
//
// Tests the feature-request STORE end-to-end (append, de-dupe→vote, md mirror, ids/status) against
// the real sprocket-store.js, and the save-marker parser via verbatim copies (the sandbox file-mount
// truncates the edited sprocket.js, so its full syntax is validated by node --check on the box at
// promote time; converse() orchestration is verified live in Chrome).
const fs = require("fs");
const os = require("os");
const path = require("path");

const FIX = fs.mkdtempSync(path.join(os.tmpdir(), "sprocket2-"));
process.env.AXLE_SPROCKET_DIR = FIX;
const STORE = require("../box-code/sprocket-store.js");

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.log("  FAIL:", n); } };

// ---- store: first save creates FR-0001, writes both files ----
(() => {
  const r = STORE.saveRequest({ goal: "automatically chase customers with unpaid invoices",
    workaround_today: "I chase them by hand", frequency: "weekly", impact: "would save real time",
    example: "", original_question: "can Axle chase unpaid invoices?", requester: "Jack", language: "en" });
  ok(r.deduped === false, "first save is not a dupe");
  ok(r.id === "FR-0001", "first id is FR-0001");
  ok(r.record.status === "new" && r.record.votes === 1, "new record: status new, 1 vote");
  ok(fs.existsSync(STORE.JSONL) && fs.existsSync(STORE.MD), "jsonl + md mirror written");
  ok(/automatically chase/.test(fs.readFileSync(STORE.MD, "utf8")), "md mirror contains the goal");
  const lines = fs.readFileSync(STORE.JSONL, "utf8").trim().split("\n");
  ok(lines.length === 1 && JSON.parse(lines[0]).id === "FR-0001", "jsonl has one parseable line");
})();

// ---- store: a similar goal from another requester de-dupes into a +1, no new record ----
(() => {
  const r = STORE.saveRequest({ goal: "chase unpaid invoices for customers automatically",
    requester: "Rob", language: "nl", original_question: "kan Axle onbetaalde facturen opvolgen?" });
  ok(r.deduped === true, "similar goal de-dupes");
  ok(r.id === "FR-0001", "vote lands on FR-0001");
  ok(r.votes === 2, "votes now 2");
  const all = STORE.loadRequests();
  ok(all.length === 1, "still one record (no duplicate)");
  ok(all[0].also_requested_by.includes("Rob"), "Rob recorded as also-requested-by");
})();

// ---- store: same requester re-asking does not double-count ----
(() => {
  const r = STORE.saveRequest({ goal: "chase unpaid invoices automatically", requester: "Rob", language: "nl" });
  ok(r.deduped === true && r.votes === 2, "same requester doesn't inflate the vote");
})();

// ---- store: a genuinely different goal creates FR-0002 ----
(() => {
  const r = STORE.saveRequest({ goal: "let me bulk-print packing slips for a whole day of orders",
    requester: "Jack", language: "en" });
  ok(r.deduped === false && r.id === "FR-0002", "distinct goal creates FR-0002");
  ok(STORE.loadRequests().length === 2, "two records now");
})();

// ---- store: model's dupe_of folds a paraphrased request onto an OPEN id (low token overlap) ----
(() => {
  const before = STORE.loadRequests().find((r) => r.id === "FR-0001").votes;
  const r = STORE.saveRequest({ goal: "remind buyers about overdue invoices by text message",
    dupe_of: "FR-0001", requester: "Huub", language: "nl" });
  ok(r.deduped === true && r.id === "FR-0001", "dupe_of folds a paraphrased goal onto FR-0001");
  ok(r.selfDupe === false, "different requester -> not a self-dupe");
  ok(r.votes === before + 1, "vote incremented via dupe_of");
  ok(STORE.loadRequests().length === 2, "no new record created by dupe_of");
})();

// ---- store: same requester re-asking is a self-dupe and does not inflate the vote ----
(() => {
  const before = STORE.loadRequests().find((r) => r.id === "FR-0001").votes;
  const r = STORE.saveRequest({ goal: "x", dupe_of: "FR-0001", requester: "Jack" }); // Jack = FR-0001's author
  ok(r.deduped === true && r.selfDupe === true, "original requester re-asking -> self-dupe");
  ok(r.votes === before, "self-dupe doesn't inflate the vote");
})();

// ---- store: dupe_of pointing at a non-existent/closed id is ignored (falls back / new) ----
(() => {
  const r = STORE.saveRequest({ goal: "a totally distinct request about label printers", dupe_of: "FR-9999", requester: "Tom" });
  ok(r.deduped === false, "dupe_of an unknown id is ignored -> new record");
})();

// ---- store: similarity scoring sanity ----
(() => {
  ok(STORE.goalSimilarity("chase unpaid invoices", "automatically chase unpaid invoices") >= 0.6, "near-identical goals score high");
  ok(STORE.goalSimilarity("print packing slips", "chase unpaid invoices") < 0.6, "unrelated goals score low");
})();

// ---- store: md mirror groups by status and only counts open requests as dedupe targets ----
(() => {
  const all = STORE.loadRequests();
  all[0].status = "declined";                 // close FR-0001
  STORE.writeAll(all);
  const r = STORE.saveRequest({ goal: "automatically chase customers with unpaid invoices", requester: "Huub", language: "nl" });
  ok(r.deduped === false, "a CLOSED request is not a dedupe target — new request is created");
  ok(/## declined/.test(fs.readFileSync(STORE.MD, "utf8")), "md mirror has a declined section");
})();

// ---- save-marker parsing (verbatim copies of sprocket.js helpers) ----
const SAVE_MARKER = "@@SPROCKET_SAVE@@";
function parseSavePayload(text) {
  const i = String(text || "").indexOf(SAVE_MARKER);
  if (i === -1) return null;
  const after = text.slice(i + SAVE_MARKER.length);
  const start = after.indexOf("{");
  if (start === -1) return null;
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let j = start; j < after.length; j++) {
    const c = after[j];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { end = j; break; } }
  }
  if (end === -1) return null;
  try { const o = JSON.parse(after.slice(start, end + 1)); return o && typeof o === "object" ? o : null; } catch (e) { return null; }
}
function stripSaveMarker(text) { const i = String(text || "").indexOf(SAVE_MARKER); return i === -1 ? String(text || "") : text.slice(0, i).trim(); }

(() => {
  const conf = 'Saved — Brad will take a look. Cheers!\n@@SPROCKET_SAVE@@ {"goal":"chase unpaid invoices","workaround_today":"by hand","frequency":"weekly","impact":"would save real time","example":""}';
  const p = parseSavePayload(conf);
  ok(p && p.goal === "chase unpaid invoices" && p.frequency === "weekly", "marker JSON parsed");
  ok(stripSaveMarker(conf) === "Saved — Brad will take a look. Cheers!", "marker stripped from display text");
  ok(parseSavePayload("just a normal help answer, no marker") === null, "no marker -> null");
  // a brace inside a string value must not end the object early
  const tricky = '@@SPROCKET_SAVE@@ {"goal":"add a } button","example":"x"}';
  ok(parseSavePayload(tricky).goal === "add a } button", "braces inside strings handled");
})();

console.log(`\nharness-sprocket-step2: ${pass}/${pass + fail} passed, ${fail} failed.`);
try { fs.rmSync(FIX, { recursive: true, force: true }); } catch (e) { /* temp */ }
process.exit(fail ? 1 : 0);
