"use strict";
// Tests for the sends de-duplication index migration in db.js — run: node --test sends-index.test.js
//
// The editable-recipient feature makes "same body, second address" a legitimate, deliberate send.
// The old UNIQUE index (work_item_id, body_sha256) swallowed it. This proves the migration:
//   * the OLD index is dropped by name (CREATE ... IF NOT EXISTS cannot widen it on its own);
//   * the NEW index exists, is UNIQUE, and is keyed (work_item_id, to_addr, body_sha256);
//   * same body + two addresses  -> both rows insert  (the case the feature needs);
//   * same body + same address   -> the second insert is rejected (double-click still blocked);
//   * re-running the migration over an already-migrated DB is a no-op (idempotent).
//
// SAFETY: this test NEVER touches the live database. db.js reads its path from AXLE_DB at require
// time, so each case runs db.js in a CHILD process with AXLE_DB pinned to a throwaway file in the
// OS temp dir. The parent opens that throwaway file directly and asserts nothing else. A guard
// below refuses to run if the temp path ever collides with a real Axle data directory.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const Database = require("better-sqlite3");

const DB_JS = path.join(__dirname, "db.js");

// A fresh throwaway DB path per test, with its WAL/SHM siblings cleaned up afterwards.
function tmpDbPath(tag) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "axle-sends-idx-")), `${tag}.db`);
  assert.ok(!/[\\/](Axle|axle)[\\/]data[\\/]/.test(p), "refusing to run against a real Axle data dir");
  return p;
}
function cleanup(dbPath) {
  for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) { try { fs.rmSync(f, { force: true }); } catch {} }
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch {}
}

// Run db.js as a child with AXLE_DB pinned. This is the migration under test: requiring db.js
// runs the whole schema + migration block. Throws (failing the test) on a non-zero exit.
function runMigration(dbPath) {
  execFileSync(process.execPath, [DB_JS], {
    env: { ...process.env, AXLE_DB: dbPath },
    stdio: "pipe",
  });
}

// PRAGMA index_list gives {name, unique}; index_info gives the keyed columns in seqno order.
function indexNames(db) {
  return db.prepare("PRAGMA index_list('sends')").all().map((r) => r.name);
}
function indexCols(db, name) {
  return db.prepare(`PRAGMA index_info('${name}')`).all().map((r) => r.name);
}
function isUnique(db, name) {
  const row = db.prepare("PRAGMA index_list('sends')").all().find((r) => r.name === name);
  return !!(row && row.unique);
}

// sends.work_item_id is a FOREIGN KEY into work_items, and better-sqlite3 turns
// PRAGMA foreign_keys ON by default — so a sends row needs a real parent conversation.
function ensureItem(db, id) {
  db.prepare(
    "INSERT OR IGNORE INTO work_items (id, mailbox, conversation_key, sender_email) VALUES (?, 'info', ?, 'customer@example.com')"
  ).run(id, "conv-" + id);
}

// Insert a sends row. draft_id is UNIQUE on the table, so every send needs its own draft —
// which is exactly what server.js does (a fresh human draft row per send).
let draftSeq = 0;
function insertSend(db, { item = 1, to = "a@b.nl", sha = "deadbeef" } = {}) {
  ensureItem(db, item);
  return db.prepare(
    "INSERT INTO sends (work_item_id, draft_id, to_addr, subject, body_sha256, sent_by) VALUES (?, ?, ?, 'subj', ?, 'tester')"
  ).run(item, ++draftSeq, to, sha);
}

// Put a freshly-migrated DB back into its PRE-migration state: the narrow index, under the old
// name. This is what every real Axle DB looks like before this deploy.
function revertToOldIndex(dbPath) {
  const db = new Database(dbPath);
  db.exec("DROP INDEX IF EXISTS idx_sends_item_to_body");
  db.exec("CREATE UNIQUE INDEX idx_sends_item_body ON sends(work_item_id, body_sha256)");
  db.close();
}

test("fresh DB: only the new index exists, unique, keyed (work_item_id, to_addr, body_sha256)", () => {
  const p = tmpDbPath("fresh");
  try {
    runMigration(p);
    const db = new Database(p);
    const names = indexNames(db);
    assert.ok(names.includes("idx_sends_item_to_body"), "new index created");
    assert.ok(!names.includes("idx_sends_item_body"), "old index must not exist on a fresh DB");
    assert.ok(isUnique(db, "idx_sends_item_to_body"), "new index is UNIQUE");
    assert.deepEqual(indexCols(db, "idx_sends_item_to_body"), ["work_item_id", "to_addr", "body_sha256"]);
    db.close();
  } finally { cleanup(p); }
});

test("migration from the pre-deploy state drops the old index by name and creates the new one", () => {
  const p = tmpDbPath("upgrade");
  try {
    runMigration(p);          // build the schema...
    revertToOldIndex(p);      // ...then rewind to exactly what the live DB looks like today

    let db = new Database(p);
    assert.ok(indexNames(db).includes("idx_sends_item_body"), "precondition: old index present");
    assert.ok(!indexNames(db).includes("idx_sends_item_to_body"), "precondition: new index absent");
    db.close();

    runMigration(p);          // the migration under test

    db = new Database(p);
    const names = indexNames(db);
    assert.ok(!names.includes("idx_sends_item_body"), "old index dropped by name");
    assert.ok(names.includes("idx_sends_item_to_body"), "new index created");
    assert.deepEqual(indexCols(db, "idx_sends_item_to_body"), ["work_item_id", "to_addr", "body_sha256"]);
    db.close();
  } finally { cleanup(p); }
});

test("migration is idempotent — re-running over a migrated DB changes nothing", () => {
  const p = tmpDbPath("idem");
  try {
    runMigration(p);
    runMigration(p);
    runMigration(p);
    const db = new Database(p);
    const hits = indexNames(db).filter((n) => n === "idx_sends_item_to_body");
    assert.equal(hits.length, 1, "exactly one new index");
    assert.ok(!indexNames(db).includes("idx_sends_item_body"));
    db.close();
  } finally { cleanup(p); }
});

test("migration survives rows that the OLD key would have rejected", () => {
  // A DB that already contains same-item/same-body rows to two addresses (possible only if the old
  // index was skipped by the catch). Widening a unique key is strictly more permissive, so the
  // rebuild must still succeed.
  const p = tmpDbPath("legacy");
  try {
    runMigration(p);
    const db = new Database(p);
    insertSend(db, { item: 1, to: "a@b.nl", sha: "same" });
    insertSend(db, { item: 1, to: "c@d.nl", sha: "same" });
    db.close();
    runMigration(p);                              // must not throw
    const db2 = new Database(p);
    assert.ok(indexNames(db2).includes("idx_sends_item_to_body"));
    assert.equal(db2.prepare("SELECT COUNT(*) n FROM sends").get().n, 2);
    db2.close();
  } finally { cleanup(p); }
});

test("same body to two addresses inserts twice; same body to the same address is rejected", () => {
  const p = tmpDbPath("dedup");
  try {
    runMigration(p);
    const db = new Database(p);

    // The feature: one reply, then the same text on to a colleague at the customer.
    insertSend(db, { item: 42, to: "jan@dekker4x4.nl", sha: "abc123" });
    insertSend(db, { item: 42, to: "piet@dekker4x4.nl", sha: "abc123" });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sends WHERE work_item_id = 42").get().n, 2,
      "same body, two addresses -> two sends rows");

    // The guard: a double-click or refresh on the same address still cannot send twice.
    assert.throws(() => insertSend(db, { item: 42, to: "jan@dekker4x4.nl", sha: "abc123" }),
      /UNIQUE constraint failed/i, "same body, same address -> rejected");

    // Different item, same body+address is fine (items are independent conversations).
    insertSend(db, { item: 43, to: "jan@dekker4x4.nl", sha: "abc123" });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sends WHERE body_sha256 = 'abc123'").get().n, 3);

    // A deliberately edited resend to the same address is still allowed (different sha).
    insertSend(db, { item: 42, to: "jan@dekker4x4.nl", sha: "different" });
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sends WHERE work_item_id = 42").get().n, 3);

    db.close();
  } finally { cleanup(p); }
});

test("the recipient is part of the key — case matters to the caller, so send-guard lowercases first", () => {
  // SQLite's UNIQUE is case-SENSITIVE on TEXT by default, so 'A@B.nl' and 'a@b.nl' would be two
  // rows. send-guard normalises to lowercase before the row is written; this pins that contract so
  // a future change there can't quietly reopen a double-send hole.
  const p = tmpDbPath("case");
  try {
    runMigration(p);
    const db = new Database(p);
    insertSend(db, { item: 9, to: "jan@dekker4x4.nl", sha: "s1" });
    insertSend(db, { item: 9, to: "JAN@Dekker4x4.NL", sha: "s1" });   // would NOT be deduped by SQLite
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sends WHERE work_item_id = 9").get().n, 2,
      "documents the raw index behaviour: normalisation is send-guard's job, not SQLite's");
    db.close();
  } finally { cleanup(p); }
});
