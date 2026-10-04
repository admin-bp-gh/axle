// knowledge.js - the business knowledge both drafting prompts (reply and compose) carry, and the
// Teach Axle actions that feed it.
//
// Two parts. The static part is business-knowledge.md, edited by Brad, deployed with the code and
// read once at start. The learned part is the "Teach Axle" entries (Phase 6, 2026-10-05): a
// salesperson flags "Axle should know this" from an item, Brad approves, edits or rejects on
// /teach, and approved rows are read from SQLite on every draft. Nothing reaches the prompt
// without Brad's approval.
//
// Why SQLite and not an append to business-knowledge.md: deploy.ps1 hash-compares every repo file
// with the live tree and overwrites any that differ, so a runtime append to the live file would be
// reverted at the next deploy. The DB rows survive deploys, need no write access to the app tree
// for the low-privilege axle account, and take effect on the next draft with no restart. Brad folds
// entries into the file by hand when he chooses; /teach lists the approved ones for that.
//
// Every action takes the db handle so the test can run it against an in-memory database; the
// routes pass the live one. Audit rows are written by the routes (they know the user).
const fs = require("fs");

const STATIC = fs.readFileSync(__dirname + "/business-knowledge.md", "utf8");
const MAX_TEXT = 1000;
const MAX_SNAPSHOT = 4000;
const HEADING = "## Learned from the team (approved by Brad)";

// Flag and approval text are typed by people and end up in the system prompt, so they are
// treated as untrusted on the way in: invisible/bidi characters stripped (the same sanitiser the
// inbound email passes through), whitespace collapsed to one line, length capped.
function cleanText(raw) {
  const { stripInvisible } = require("./engine.js");   // lazy: engine.js requires this module
  return stripInvisible(String(raw || "")).replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
}

// ---- actions ------------------------------------------------------------------------------

// Queue a flag. Returns the new row id, or null when the cleaned text is empty.
function flag(db, { workItemId, by, text, snapshot }) {
  const clean = cleanText(text);
  if (!clean) return null;
  const snap = String(snapshot || "").slice(0, MAX_SNAPSHOT) || null;
  return db.prepare("INSERT INTO teach_flags (work_item_id, flagged_by, text, draft_snapshot) VALUES (?, ?, ?, ?)")
    .run(workItemId, by, clean, snap).lastInsertRowid;
}

// Approve a pending flag with the text Brad settled on (his edit, or the flag verbatim).
// Returns the stored final text, or null when nothing changed (not pending, or empty text).
function approve(db, id, by, text) {
  const clean = cleanText(text);
  if (!clean) return null;
  const r = db.prepare("UPDATE teach_flags SET status = 'approved', final_text = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'")
    .run(clean, by, id);
  return r.changes ? clean : null;
}

// Reject a pending flag. The row stays, status 'rejected', for the audit trail.
function reject(db, id, by) {
  return db.prepare("UPDATE teach_flags SET status = 'rejected', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'")
    .run(by, id).changes === 1;
}

// Retire an approved entry: it leaves the prompt (folded into business-knowledge.md by hand, or
// found wrong) and stays on record as 'retired'.
function retire(db, id, by) {
  return db.prepare("UPDATE teach_flags SET status = 'retired', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'approved'")
    .run(by, id).changes === 1;
}

// Withdraw a pending flag: its author, or an admin. Decided rows are Brad's and cannot be withdrawn.
function withdraw(db, id, by, isAdmin) {
  const f = db.prepare("SELECT flagged_by FROM teach_flags WHERE id = ? AND status = 'pending'").get(id);
  if (!f || !(isAdmin || f.flagged_by === by)) return false;
  return db.prepare("DELETE FROM teach_flags WHERE id = ?").run(id).changes === 1;
}

const pendingCount = (db) => db.prepare("SELECT COUNT(*) AS n FROM teach_flags WHERE status = 'pending'").get().n;

// ---- the prompt block ---------------------------------------------------------------------

const LEARNED_SQL = `SELECT f.work_item_id, f.reviewed_at, f.final_text, COALESCE(u.display_name, f.flagged_by) AS who
  FROM teach_flags f LEFT JOIN users u ON u.tailscale_login = f.flagged_by
  WHERE f.status = 'approved' ORDER BY f.reviewed_at, f.id`;

function learnedLine(r) {
  return `- ${String(r.reviewed_at || "").slice(0, 10)} (${r.who}, item #${r.work_item_id}): ${r.final_text}`;
}

// The <business_knowledge> block for a system prompt. Production callers pass nothing and get the
// live database. A DB problem must never stop a draft, so the learned part degrades to nothing
// with a warning.
function block(db) {
  let lines = [];
  try { lines = (db || require("./db.js").db).prepare(LEARNED_SQL).all().map(learnedLine); }
  catch (e) { console.warn("[knowledge] learned entries unavailable: " + e.message); }
  const learned = lines.length ? `\n\n${HEADING}\n${lines.join("\n")}\n` : "\n";
  return `<business_knowledge>\n${STATIC}${learned}</business_knowledge>`;
}

module.exports = { block, cleanText, flag, approve, reject, retire, withdraw, pendingCount, learnedLine, MAX_TEXT, HEADING };
