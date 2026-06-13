// wipe-slate.js — reset Axle to a clean slate before live use.
//
// Clears all transactional data (work items + everything hanging off them, plus the audit
// log and the on-view translation cache) so a fresh pilot starts from item #1 with no test
// residue polluting the audit trail used for continuous improvement.
//
// PRESERVES: users (registrations) and sync_state (the ingest lock).
// SAFETY:
//   - exports the full audit_log to C:\Axle\logs\pre-wipe\audit-<timestamp>.json FIRST,
//     so Gate-4 evidence (403s, registrations) is kept outside the live DB.
//   - dry run by default; pass --yes to actually delete.
//
// Usage (on the box, in C:\Axle\app):
//   node wipe-slate.js          # shows what WOULD be deleted, deletes nothing
//   node wipe-slate.js --yes    # exports audit, then wipes

const fs = require("fs");
const path = require("path");
const { db, setWatermark } = require("./db");

// Children first so foreign-key references are gone before their parents.
const TABLES = ["draft_attachments", "sends", "drafts", "questions", "work_items", "audit_log", "translations"];
const LOG_DIR = process.env.AXLE_LOGS || "C:\\Axle\\logs";

const count = (tbl) => db.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).get().n;

console.log("Current row counts:");
for (const tbl of TABLES) console.log(`  ${tbl.padEnd(18)} ${count(tbl)}`);
console.log(`  ${"users (kept)".padEnd(18)} ${count("users")}`);

const go = process.argv.includes("--yes");
if (!go) {
  console.log("\nDry run — nothing deleted. Re-run with --yes to wipe.");
  process.exit(0);
}

// 1) Export the audit log before clearing it.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(LOG_DIR, "pre-wipe");
fs.mkdirSync(outDir, { recursive: true });
const auditRows = db.prepare("SELECT * FROM audit_log ORDER BY id").all();
const outFile = path.join(outDir, `audit-${stamp}.json`);
fs.writeFileSync(outFile, JSON.stringify(auditRows, null, 2), "utf8");
console.log(`\nExported ${auditRows.length} audit rows -> ${outFile}`);

// 2) Wipe transactional tables and reset their AUTOINCREMENT counters, all in one transaction.
const wipe = db.transaction(() => {
  for (const tbl of TABLES) db.prepare(`DELETE FROM ${tbl}`).run();
  // sqlite_sequence may not exist if no AUTOINCREMENT table has ever been written; guard it.
  const seq = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sqlite_sequence'").get();
  if (seq) {
    const del = db.prepare("DELETE FROM sqlite_sequence WHERE name = ?");
    for (const tbl of TABLES) del.run(tbl);
  }
  // Make sure the ingest lock is free.
  db.prepare("UPDATE sync_state SET running = 0, started_at = NULL, finished_at = NULL, trigger = NULL WHERE id = 1").run();
  // Fresh-from-now handover: set every mailbox watermark to this moment, so the first ingest after
  // the wipe only pulls in mail that arrives from here on -- no backlog of old read mail.
  const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  setWatermark("info", nowIso);
  setWatermark("drachten", nowIso);
});
wipe();

console.log("\nWiped. New row counts:");
for (const tbl of TABLES) console.log(`  ${tbl.padEnd(18)} ${count(tbl)}`);
console.log(`  ${"users (kept)".padEnd(18)} ${count("users")}`);
const wm = db.prepare("SELECT watermarks FROM sync_state WHERE id = 1").get();
console.log(`\nWatermarks set to now: ${wm && wm.watermarks}`);
console.log("Clean slate ready. Next item created will be #1. New mail from now on flows in on the next sync.");
