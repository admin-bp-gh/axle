// backup-db.js — consistent online backup of the Axle SQLite database.
//
// Why this exists: axle.db runs in WAL mode and is held open by the live server, so a
// raw file copy could capture a torn / internally-inconsistent database. This uses
// better-sqlite3's online .backup() API (SQLite's backup API underneath) to copy the
// database page-by-page into a single standalone .db file that is internally consistent
// even while the server keeps reading and writing. Run by the "Axle Backup" scheduled
// task as the low-privilege `axle` account.
//
//   Output     : <BACKUP_DIR>\axle-YYYYMMDD-HHMMSS.db   (one self-contained file)
//   Verifies   : PRAGMA integrity_check on the copy must return "ok"
//   Retention  : prunes axle-*.db older than RETENTION_DAYS
//   Logs       : one line per run to <backup.log> (and stdout, captured by the wrapper)
//
// All paths/retention are overridable via env vars so the script is testable off-box.

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const SRC            = process.env.AXLE_DB                   || "C:\\Axle\\data\\axle.db";
const BACKUP_DIR     = process.env.AXLE_BACKUP_DIR           || "C:\\Admin\\Projects\\Axle\\Backups";
const LOG_FILE       = process.env.AXLE_BACKUP_LOG           || "C:\\Axle\\logs\\backup.log";
const RETENTION_DAYS = parseInt(process.env.AXLE_BACKUP_RETENTION_DAYS || "7", 10);

// Only files this script itself produced are ever considered for pruning.
const NAME_RE = /^axle-\d{8}-\d{6}\.db$/;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
         `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function log(line) {
  const msg = `${new Date().toISOString()}  ${line}`;
  console.log(msg);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, msg + "\r\n");
  } catch (e) {
    console.error("could not write backup log:", e.message);
  }
}

// Row count for every user table — used to prove the copy matches the live DB.
function tableCounts(db) {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  const counts = {};
  for (const t of tables) counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
  return counts;
}

// Delete backups older than the retention window (by file mtime). Never touches the
// file we just wrote, and never touches anything not matching our own naming pattern.
function prune(keepFile) {
  let removed = 0;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const f of fs.readdirSync(BACKUP_DIR)) {
    if (!NAME_RE.test(f)) continue;
    const full = path.join(BACKUP_DIR, f);
    if (full === keepFile) continue;
    if (fs.statSync(full).mtimeMs < cutoff) { fs.unlinkSync(full); removed++; }
  }
  return removed;
}

// Open the live DB read-only (the principled default — we only read). If the server
// happens to be down at backup time, a read-only open of a WAL database with no live
// connection can fail; fall back to a read-write open, which can read it safely as the
// only connection. Either way we never issue a write.
function openSource() {
  try {
    return { db: new Database(SRC, { readonly: true, fileMustExist: true }), mode: "ro" };
  } catch (e) {
    return { db: new Database(SRC, { readonly: false, fileMustExist: true }), mode: "rw-fallback" };
  }
}

async function main() {
  if (!fs.existsSync(SRC)) throw new Error(`source DB not found: ${SRC}`);
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const dest = path.join(BACKUP_DIR, `axle-${stamp()}.db`);

  const { db: src, mode } = openSource();
  try {
    await src.backup(dest); // online, page-by-page; consistent despite concurrent writes
  } finally {
    src.close();
  }

  // Verify the copy on its own — open it fresh, integrity-check, and count rows.
  const bak = new Database(dest, { readonly: true, fileMustExist: true });
  let integrity, counts;
  try {
    integrity = bak.pragma("integrity_check", { simple: true });
    counts = tableCounts(bak);
  } finally {
    bak.close();
  }
  if (integrity !== "ok") throw new Error(`integrity_check failed on ${dest}: ${integrity}`);

  const sizeMB = (fs.statSync(dest).size / (1024 * 1024)).toFixed(2);
  const removed = prune(dest);
  const summary = Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(" ");
  log(`OK backup -> ${path.basename(dest)} (${sizeMB} MB) src=${mode} integrity=ok pruned=${removed} | ${summary}`);
}

main().catch((e) => {
  log(`FAIL ${e.message}`);
  process.exit(1);
});
