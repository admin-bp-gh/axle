// sprocket-store.js — Sprocket's feature-request log. This is the ONLY thing Sprocket ever
// writes: a structured record per captured request, into its own files under the Sprocket dir.
// No SAP/Shopify/email/MyParcel writes; no system action. Two files, kept in sync on every save:
//   feature-requests.jsonl  — one JSON object per line (easy to append/parse, the source of truth)
//   feature-requests.md     — a human-readable mirror Brad can read at a glance
//
// De-dupe: before adding a new request we compare its goal to the OPEN requests; a clear match
// adds the new requester as a +1 to the existing one instead of creating a duplicate.
const fs = require("fs");
const path = require("path");

const DIR = process.env.AXLE_SPROCKET_DIR || path.join(__dirname, "..", "sprocket");
const JSONL = path.join(DIR, "feature-requests.jsonl");
const MD = path.join(DIR, "feature-requests.md");

const STATUSES = ["new", "approved", "in_progress", "done", "declined"];
const OPEN = new Set(["new", "approved", "in_progress"]);
const DEDUPE_THRESHOLD = 0.6;   // goal-token overlap at/above which two requests are "the same"

// ---------- load ----------
function loadRequests() {
  let raw;
  try { raw = fs.readFileSync(JSONL, "utf8"); } catch (e) { return []; }
  return raw.split("\n").filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch (e) { return null; }
  }).filter(Boolean);
}

// ---------- de-dupe similarity (deterministic; no model) ----------
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const STOP = new Set(["the", "and", "for", "with", "that", "this", "have", "from", "can", "could", "would", "axle", "able", "want", "need", "when", "they", "you", "your", "our", "are", "but", "not"]);
const tokenSet = (s) => new Set(norm(s).split(" ").filter((w) => w.length > 2 && !STOP.has(w)));
function goalSimilarity(a, b) {
  const A = tokenSet(a), B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);   // overlap relative to the smaller set
}
function findSimilarOpen(goal, requests) {
  let best = null, score = 0;
  for (const r of requests) {
    if (!OPEN.has(r.status)) continue;
    const s = goalSimilarity(goal, r.goal);
    if (s > score) { score = s; best = r; }
  }
  return score >= DEDUPE_THRESHOLD ? best : null;
}

// ---------- id ----------
function nextId(requests) {
  let max = 0;
  for (const r of requests) {
    const m = /^FR-(\d+)$/.exec(String(r.id || ""));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return "FR-" + String(max + 1).padStart(4, "0");
}

// ---------- markdown mirror ----------
function esc(s) { return String(s == null ? "" : s).replace(/\r?\n/g, " ").trim(); }
function renderMd(requests) {
  const byStatus = (st) => requests.filter((r) => r.status === st);
  const lines = ["# Sprocket — feature requests", "",
    `_Auto-generated mirror of feature-requests.jsonl. Last updated ${new Date().toISOString()}._`,
    `_${requests.length} request(s) total. Edit status/notes in the .jsonl (source of truth) — this file is regenerated on each save._`, ""];
  for (const st of STATUSES) {
    const rows = byStatus(st);
    if (!rows.length) continue;
    lines.push(`## ${st} (${rows.length})`, "");
    for (const r of rows.sort((a, b) => (b.votes || 1) - (a.votes || 1))) {
      lines.push(`### ${r.id} — ${esc(r.goal) || "(no goal)"}  ·  ${r.votes || 1} vote(s)`);
      lines.push(`- created: ${r.created}  ·  by: ${esc(r.requester)}  ·  lang: ${r.language || "?"}`);
      if (r.workaround_today) lines.push(`- today: ${esc(r.workaround_today)}`);
      if (r.frequency) lines.push(`- frequency: ${esc(r.frequency)}`);
      if (r.impact) lines.push(`- impact: ${esc(r.impact)}`);
      if (r.example) lines.push(`- example: ${esc(r.example)}`);
      if (r.also_requested_by && r.also_requested_by.length) lines.push(`- also requested by: ${r.also_requested_by.map(esc).join("; ")}`);
      if (r.original_question) lines.push(`- original words: "${esc(r.original_question)}"`);
      if (r.notes) lines.push(`- Brad's notes: ${esc(r.notes)}`);
      lines.push("");
    }
  }
  if (requests.length === 0) lines.push("_No requests yet._", "");
  return lines.join("\n");
}

// ---------- write (atomic-ish: temp + rename) ----------
function writeAll(requests) {
  fs.mkdirSync(DIR, { recursive: true });
  const jsonl = requests.map((r) => JSON.stringify(r)).join("\n") + (requests.length ? "\n" : "");
  const tmpJ = JSONL + ".tmp", tmpM = MD + ".tmp";
  fs.writeFileSync(tmpJ, jsonl, "utf8"); fs.renameSync(tmpJ, JSONL);
  fs.writeFileSync(tmpM, renderMd(requests), "utf8"); fs.renameSync(tmpM, MD);
}

// ---------- the one write Sprocket performs ----------
// fields: { goal, workaround_today, frequency, impact, example, original_question, requester, language }
// Returns { deduped, id, votes, record } so the caller can word the confirmation + audit it.
function saveRequest(fields) {
  const requests = loadRequests();
  const goal = String(fields.goal || "").trim();
  const requester = String(fields.requester || "unknown").trim();

  // De-dupe: prefer Sprocket's semantic judgement (dupe_of an OPEN request id), then fall back to
  // deterministic goal-token overlap. Paraphrased duplicates ("order ships" vs "parcel dispatched")
  // share few tokens, so the model's id is the reliable signal; the overlap is the safety net.
  let match = null;
  const dupeId = String(fields.dupe_of || "").trim();
  if (dupeId) match = requests.find((r) => r.id === dupeId && OPEN.has(r.status)) || null;
  if (!match && goal) match = findSimilarOpen(goal, requests);
  if (match) {
    match.also_requested_by = Array.isArray(match.also_requested_by) ? match.also_requested_by : [];
    const already = requester === match.requester || match.also_requested_by.includes(requester);
    if (requester && !already) match.also_requested_by.push(requester);
    match.votes = 1 + match.also_requested_by.length;
    writeAll(requests);
    return { deduped: true, selfDupe: already, id: match.id, votes: match.votes, record: match };
  }

  const record = {
    id: nextId(requests),
    created: new Date().toISOString(),
    requester,
    language: fields.language || "en",
    original_question: String(fields.original_question || "").slice(0, 1000),
    goal: goal.slice(0, 500),
    workaround_today: String(fields.workaround_today || "").slice(0, 500),
    frequency: String(fields.frequency || "").slice(0, 120),
    impact: String(fields.impact || "").slice(0, 120),
    example: String(fields.example || "").slice(0, 1000),
    status: "new",
    votes: 1,
    also_requested_by: [],
    notes: "",
  };
  requests.push(record);
  writeAll(requests);
  return { deduped: false, id: record.id, votes: 1, record };
}

module.exports = {
  STATUSES, OPEN, JSONL, MD, DIR,
  loadRequests, saveRequest, findSimilarOpen, goalSimilarity, renderMd, nextId, writeAll,
};
