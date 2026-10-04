// teach.test.js - Teach Axle (Phase 6, 2026-10-05): flag, approve, reject, withdraw, the prompt
// block format, and that an approval reaches the prompt on the next call with no reload.
// Run: node teach.test.js
const assert = require("assert");
const K = require("./knowledge.js");

// better-sqlite3 on the box; node:sqlite where the native build does not load (the Linux sandbox
// Claude builds in). Same prepare/run/get/all surface for everything this test does.
let db;
try { db = new (require("better-sqlite3"))(":memory:"); }
catch (e) { db = new (require("node:sqlite").DatabaseSync)(":memory:"); }

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };

db.exec(`
  CREATE TABLE users (tailscale_login TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'sales');
  CREATE TABLE teach_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT, work_item_id INTEGER NOT NULL, flagged_by TEXT NOT NULL, text TEXT NOT NULL,
    draft_snapshot TEXT, status TEXT NOT NULL DEFAULT 'pending', reviewed_by TEXT, reviewed_at TEXT, final_text TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')));
  INSERT INTO users VALUES ('jack@bp', 'Jack', 'sales'), ('brad@bp', 'Brad', 'admin');
`);
const row = (id) => db.prepare("SELECT * FROM teach_flags WHERE id = ?").get(id);
const today = new Date().toISOString().slice(0, 10);

console.log("teach");

test("cleanText strips invisible characters, collapses whitespace, caps length", () => {
  assert.strictEqual(K.cleanText("  Drachten​ closes\n\n at  17:00‮ "), "Drachten closes at 17:00");
  assert.strictEqual(K.cleanText("x".repeat(K.MAX_TEXT + 50)).length, K.MAX_TEXT);
  assert.strictEqual(K.cleanText(null), "");
});

test("empty prompt block when nothing is approved", () => {
  const b = K.block(db);
  assert.ok(b.startsWith("<business_knowledge>\n# Axle business knowledge"));
  assert.ok(b.endsWith("</business_knowledge>"));
  assert.ok(!b.includes(K.HEADING));
});

let f1, f2, f3;
test("flag stores cleaned text and the draft snapshot; empty text is refused", () => {
  f1 = K.flag(db, { workItemId: 2410, by: "jack@bp", text: " Drachten is closed on\nSaturdays ", snapshot: "Dear customer, ..." });
  assert.ok(f1);
  const r = row(f1);
  assert.strictEqual(r.text, "Drachten is closed on Saturdays");
  assert.strictEqual(r.draft_snapshot, "Dear customer, ...");
  assert.strictEqual(r.status, "pending");
  assert.strictEqual(K.flag(db, { workItemId: 1, by: "jack@bp", text: "  ​ " }), null);
  f2 = K.flag(db, { workItemId: 2411, by: "jack@bp", text: "Wrong idea" });
  f3 = K.flag(db, { workItemId: 2412, by: "jack@bp", text: "Mine to withdraw" });
  assert.strictEqual(K.pendingCount(db), 3);
});

test("pending and rejected flags never reach the prompt", () => {
  assert.ok(K.reject(db, f2, "brad@bp"));
  assert.strictEqual(row(f2).status, "rejected");
  assert.strictEqual(row(f2).reviewed_by, "brad@bp");
  assert.ok(!K.block(db).includes("Wrong idea"));
  assert.ok(!K.block(db).includes("Drachten is closed"));
  assert.ok(!K.reject(db, f2, "brad@bp"), "a decided row cannot be decided again");
});

test("approve stores Brad's edited text and it appears on the very next block() call", () => {
  const final = K.approve(db, f1, "brad@bp", "Drachten (Budget Parts Noord) is closed on Saturdays;\n collection there is weekdays only.");
  assert.strictEqual(final, "Drachten (Budget Parts Noord) is closed on Saturdays; collection there is weekdays only.");
  const b = K.block(db);
  const line = `- ${today} (Jack, item #2410): ${final}`;
  assert.ok(b.includes(`\n\n${K.HEADING}\n${line}\n</business_knowledge>`), b.slice(-300));
  assert.strictEqual(K.approve(db, f1, "brad@bp", "again"), null, "approving twice changes nothing");
  assert.strictEqual(row(f1).final_text, final);
  assert.strictEqual(K.approve(db, f3, "brad@bp", "   "), null, "empty final text is refused and the row stays pending");
  assert.strictEqual(row(f3).status, "pending");
});

test("withdraw: author or admin, pending only", () => {
  assert.ok(!K.withdraw(db, f3, "rob@bp", false), "someone else cannot withdraw");
  assert.ok(!K.withdraw(db, f1, "jack@bp", false), "an approved row cannot be withdrawn");
  assert.ok(K.withdraw(db, f3, "jack@bp", false));
  assert.strictEqual(row(f3), undefined);
  const f4 = K.flag(db, { workItemId: 2413, by: "jack@bp", text: "Admin removes this" });
  assert.ok(K.withdraw(db, f4, "brad@bp", true));
  assert.strictEqual(K.pendingCount(db), 0);
});

test("learned lines keep approval order and fall back to the login when the user is unknown", () => {
  const f5 = K.flag(db, { workItemId: 2500, by: "ghost@bp", text: "Later fact" });
  K.approve(db, f5, "brad@bp", "Later fact");
  const b = K.block(db);
  assert.ok(b.indexOf("item #2410") < b.indexOf("item #2500"));
  assert.ok(b.includes(`(ghost@bp, item #2500): Later fact`));
});

test("retire takes an approved entry out of the prompt and keeps the row", () => {
  const f6 = K.flag(db, { workItemId: 2600, by: "jack@bp", text: "Folded into the file" });
  K.approve(db, f6, "brad@bp", "Folded into the file");
  assert.ok(K.block(db).includes("Folded into the file"));
  assert.ok(K.retire(db, f6, "brad@bp"));
  assert.strictEqual(row(f6).status, "retired");
  assert.ok(!K.block(db).includes("Folded into the file"));
  assert.ok(!K.retire(db, f6, "brad@bp"), "only approved rows can be retired");
  assert.ok(!K.retire(db, f2, "brad@bp"), "a rejected row cannot be retired");
});

console.log(`\n${pass} passed`);
