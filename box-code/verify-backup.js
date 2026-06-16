// verify-backup.js — prove a backup matches the live Axle database.
//
// Opens the live DB and a backup (the newest one by default) read-only, compares the
// table set and per-table row counts, and runs PRAGMA integrity_check on the backup.
//
// The live DB keeps changing while the team uses the tool, so the snapshot is always a
// hair behind a moving database. Therefore "live >= backup for every table" is a PASS;
// only a structural mismatch (a table present in one and not the other), a failed
// integrity check, or a backup that somehow holds MORE rows than live counts as a FAIL.
//
//   node verify-backup.js [backupFile] [liveDb]
//   defaults: newest <BACKUP_DIR>\axle-*.db   vs   C:\Axle\data\axle.db

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const LIVE       = process.argv[3] || process.env.AXLE_DB         || "C:\\Axle\\data\\axle.db";
const BACKUP_DIR = process.env.AXLE_BACKUP_DIR                    || "C:\\Admin\\Projects\\Axle\\Backups";
const NAME_RE = /^axle-\d{8}-\d{6}\.db$/;

function newestBackup() {
  const files = fs.readdirSync(BACKUP_DIR).filter((f) => NAME_RE.test(f));
  if (!files.length) throw new Error(`no backups found in ${BACKUP_DIR}`);
  files.sort(); // timestamped names sort chronologically
  return path.join(BACKUP_DIR, files[files.length - 1]);
}

function tableCounts(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((r) => r.name);
  const counts = {};
  for (const t of tables) counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
  return counts;
}

const backupPath = process.argv[2] || newestBackup();

const live = new Database(LIVE, { readonly: true, fileMustExist: true });
const bak  = new Database(backupPath, { readonly: true, fileMustExist: true });
const integrity = bak.pragma("integrity_check", { simple: true });
const lc = tableCounts(live);
const bc = tableCounts(bak);
live.close(); bak.close();

const allTables = Array.from(new Set([...Object.keys(lc), ...Object.keys(bc)])).sort();

console.log(`live   : ${LIVE}`);
console.log(`backup : ${backupPath}`);
console.log(`integrity_check(backup) = ${integrity}\n`);
console.log("table".padEnd(20) + "live".padStart(8) + "backup".padStart(9) + "  status");
console.log("-".repeat(46));

let fail = false;
for (const t of allTables) {
  const l = lc[t], b = bc[t];
  let status;
  if (l === undefined)      { status = "MISSING in live";   fail = true; }
  else if (b === undefined) { status = "MISSING in backup"; fail = true; }
  else if (b === l)         { status = "match"; }
  else if (b < l)           { status = `live +${l - b} (live moved on)`; }
  else                      { status = `backup +${b - l} (!)`; fail = true; }
  const ls = l === undefined ? "-" : String(l);
  const bs = b === undefined ? "-" : String(b);
  console.log(t.padEnd(20) + ls.padStart(8) + bs.padStart(9) + "  " + status);
}

const ok = integrity === "ok" && !fail;
console.log("\n" + (ok ? "PASS - backup is consistent and complete."
                       : "FAIL - see rows above."));
process.exit(ok ? 0 : 1);
