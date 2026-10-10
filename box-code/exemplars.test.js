// exemplars.test.js - style exemplar selection (2026-10-04; 2026-10-10 the first-draft filter and
// the new ranking, covered in depth by learning-loop.test.js). Run: node exemplars.test.js
const assert = require("assert");
const { pickExemplars, exemplarBlock, MIN_LEN } = require("./exemplars.js");

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };

// better-sqlite3 on the box; node:sqlite where the native build does not load.
let db;
try { db = new (require("better-sqlite3"))(":memory:"); }
catch (e) { db = new (require("node:sqlite").DatabaseSync)(":memory:"); }
db.exec(`
  CREATE TABLE work_items (id INTEGER PRIMARY KEY, mailbox TEXT, intent TEXT, language TEXT, origin TEXT DEFAULT 'inbound');
  CREATE TABLE drafts (id INTEGER PRIMARY KEY, work_item_id INTEGER, body TEXT, version INTEGER NOT NULL DEFAULT 1, is_interim INTEGER NOT NULL DEFAULT 0,
    source TEXT NOT NULL DEFAULT 'ai', created_at TEXT);
  CREATE TABLE sends (id INTEGER PRIMARY KEY, work_item_id INTEGER, source_draft_id INTEGER, body TEXT, status TEXT, sent_by TEXT, sent_at TEXT);
  CREATE TABLE users (tailscale_login TEXT PRIMARY KEY, display_name TEXT, role TEXT);
  CREATE TABLE audit_log (id INTEGER PRIMARY KEY, ts TEXT, user TEXT, action TEXT, work_item_id INTEGER, detail TEXT);
`);
const long = (tag) => `Hi,\n\n${tag} `.padEnd(MIN_LEN + 50, "x") + "\n\nKind regards,\nTeam Budget Parts";
let wid = 0, did = 0, sid = 0;
// edited: the sent text differs from the draft by one word in about twenty (light, still eligible).
function seed({ mailbox = "info", intent = "return_complaint", language = "en", origin = "inbound", edited = true, status = "sent", sentAt, body }) {
  const w = ++wid;
  db.prepare("INSERT INTO work_items VALUES (?,?,?,?,?)").run(w, mailbox, intent, language, origin);
  const sent = body || long(`send${sid + 1}`);
  const d = ++did, s = ++sid;
  const at = sentAt || `2026-09-${String(s).padStart(2, "0")} 10:00:00`;
  db.prepare("INSERT INTO drafts (id, work_item_id, body, created_at) VALUES (?,?,?,?)").run(d, w, edited ? sent.replace(/^Hi,/, "Hello,") : sent, at.replace("10:00", "09:00"));
  db.prepare("INSERT INTO sends VALUES (?,?,?,?,?,?,?)").run(s, w, d, sent, status, "jack@bp", at);
  return { w, s };
}

console.log("exemplars");

const a = seed({ edited: false });                           // info, verbatim, oldest
const b = seed({ edited: true });                            // info, edited
const c = seed({ mailbox: "drachten", edited: true });       // other mailbox
const d = seed({ intent: "order_status" });                  // wrong intent
const e = seed({ language: "nl" });                          // wrong language
const f = seed({ origin: "compose" });                       // compose, excluded
const g = seed({ status: "pending" });                       // never went out
const h = seed({ body: "Thanks, noted." });                  // too short (acknowledgement)
const i = seed({ edited: true });                            // info, edited, newest

test("same mailbox first, unchanged before lightly edited, then newest; filters applied", () => {
  const out = pickExemplars({ intent: "return_complaint", language: "en", mailbox: "info", n: 5 }, db);
  assert.deepStrictEqual(out.map((x) => x.sendId), [a.s, i.s, b.s, c.s]);
  assert.strictEqual(out[0].edited, false);
  assert.strictEqual(out[1].edited, true);
});

test("n caps the list", () => {
  const out = pickExemplars({ intent: "return_complaint", language: "en", mailbox: "info", n: 2 }, db);
  assert.deepStrictEqual(out.map((x) => x.sendId), [a.s, i.s]);
});

test("the current item is never its own exemplar", () => {
  const out = pickExemplars({ intent: "return_complaint", language: "en", mailbox: "info", excludeItemId: a.w, n: 1 }, db);
  assert.strictEqual(out[0].sendId, i.s);
});

test("missing intent or language -> nothing", () => {
  assert.deepStrictEqual(pickExemplars({ intent: null, language: "en", mailbox: "info" }, db), []);
  assert.deepStrictEqual(pickExemplars({ intent: "other", language: "other", mailbox: "info" }, db), []);
});

test("block wraps bodies, numbers them and runs the sanitiser", () => {
  const blk = exemplarBlock([{ sendId: 1, body: "one​" }, { sendId: 2, body: "two" }], (s) => s.replace(/​/g, ""));
  assert.ok(blk.startsWith("<style_exemplars>"));
  assert.ok(/<example n="1">\none\n<\/example>/.test(blk));
  assert.ok(/<example n="2">/.test(blk));
  assert.ok(/never reuse their facts/.test(blk));
  assert.strictEqual(exemplarBlock([]), "");
});

console.log(`${pass} passed`);
