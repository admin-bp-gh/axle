// boot.js - boots harness/step0/fixtures.js then harness/step0/child.js as child
// processes against a temp fixture DB, the way harness/step0/run.js does (startChild,
// runOne). The mobile harness requires nothing else from step0: fixtures.js and child.js
// set AXLE_MIRROR themselves from the env this module passes them.
"use strict";
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { STEP0_DIR } = require("./env.js");

const BASE_ENV = {
  MAILBOX_INFO: "info@budget-parts.nl",
  MAILBOX_DRACHTEN: "drachten@budget-parts.nl",
  ANTHROPIC_API_KEY: "harness-stub-key",
};

function spawnP(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(cmd + " " + args.join(" ") + " exited " + code + "\n" + out + err))));
    p.on("error", reject);
  });
}

function startChild(entry, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(STEP0_DIR, "child.js")], { env: { ...env, HARNESS_ENTRY: entry } });
    let out = "", err = "";
    const to = setTimeout(() => { p.kill("SIGKILL"); reject(new Error("child boot timeout (30s)\n--- stdout ---\n" + out + "\n--- stderr ---\n" + err)); }, 30000);
    p.stdout.on("data", (d) => {
      out += d;
      const m = /HARNESS_PORT=(\d+)/.exec(out);
      if (m) { clearTimeout(to); resolve({ proc: p, port: +m[1] }); }
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (code) => { clearTimeout(to); reject(new Error("child exited early (code " + code + ")\n--- stdout ---\n" + out + "\n--- stderr ---\n" + err)); });
    p.on("error", reject);
  });
}

// seed(dbPath, phase) - a hook for later phases to extend the fixture DB that
// step0/fixtures.js just built (e.g. Phase 3's "120 done items, an investigating item,
// the sync lock, a forced 500"), using the real schema directly via node:sqlite. Phase 0
// needs no extra seeding beyond the 9 Step-0 fixture items.
const PHASES_WITH_LONG_EMAIL = new Set(["1b", "2", "3"]);   // M-23: the clamp needs a long message to clamp

function seed(dbPath, phase) {
  const d = new DatabaseSync(dbPath);
  try {
    // M-23: item 1's fixture email (MAIL1, harness/step0/fixtures.js) is 8 lines - too
    // short to exercise the 12-line clamp/fade/"Show full message" toggle. From Phase 1b
    // onward, prepend numbered lines so it runs well past the clamp; item 2 stays short
    // (it is the needs-answer fixture, not the long-message one). Prepended, not appended:
    // MAIL1 already contains a "Von: ..." reply marker, and ui.js's splitQuoted() folds
    // everything from the FIRST such marker onward into the collapsed quoted-history
    // block - text appended after it never reaches the visible (clamped) "top" portion.
    if (PHASES_WITH_LONG_EMAIL.has(String(phase))) {
      const row = d.prepare("SELECT email_text FROM work_items WHERE id = 1").get();
      if (row && row.email_text != null) {
        const extra = [];
        for (let i = 1; i <= 40; i++) extra.push("Extra line " + i + " for the mobile clamp fixture.");
        const longText = extra.join("\n") + "\n" + row.email_text;
        d.prepare("UPDATE work_items SET email_text = ? WHERE id = 1").run(longText);
      }
    }
    if (String(phase) === "3") seedPhase3(d);
  } finally {
    d.close();
  }
}

// Phase 3 (mobile plan 3.7, C1 / C4):
//  - 120 extra done work_items, ids 100 to 219, each a copy of fixture row 6's columns with
//    status 'done', mailbox 'info', subject "Done fixture N" and its own conversation_key
//    (UNIQUE(mailbox, conversation_key)). updated_at steps back one minute per id from
//    2026-06-05 12:00, all older than fixture 6, so the Done tab's ORDER BY updated_at DESC
//    is deterministic: item 6, then 100, 101, ... 219 (121 done items: pages of 50, 50, 21).
//  - item 300 "Forced 500 fixture", a copy of item 1 (status ready, so its card sits in the
//    Open tab where a tap can reach it). GET /item/300 is made to throw by extra-stubs.js
//    (AXLE_HARNESS_FAIL_ITEM=300, set by bootServer for phase 3); see the note there.
//  - item 8 (fixture "new") is left as is; no 'investigating' row (that is Phase 4).
//  - The sync lock is NOT seeded here: server.js clears sync_state.running on startup
//    ("stuckSync", server.js:67), so a lock written before the boot never survives it.
//    harness/mobile/phase-3.js sets and clears sync_state.running directly in the running
//    server's DB (ctx.dbPath) around the assertions that need it, so the walk screenshots
//    stay non-syncing.
function seedPhase3(d) {
  const cols = d.prepare("PRAGMA table_info(work_items)").all().map((c) => c.name);
  const OVERRIDE = new Set(["id", "status", "mailbox", "subject", "conversation_key", "latest_message_id", "updated_at", "created_at"]);
  const copy = cols.filter((c) => !OVERRIDE.has(c));
  const insDone = d.prepare(
    "INSERT INTO work_items (id, status, mailbox, subject, conversation_key, latest_message_id, updated_at, created_at, " + copy.join(", ") + ") " +
    "SELECT ?, 'done', 'info', ?, ?, ?, ?, ?, " + copy.join(", ") + " FROM work_items WHERE id = 6"
  );
  const base = Date.parse("2026-06-05T12:00:00Z");
  const sqlTs = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
  for (let i = 0; i < 120; i++) {
    const id = 100 + i;
    const ts = sqlTs(base - i * 60000);
    insDone.run(id, "Done fixture " + (i + 1), "done-fixture|" + id, "MSGD" + id, ts, ts);
  }
  const insFail = d.prepare(
    "INSERT INTO work_items (id, subject, conversation_key, latest_message_id, " +
    cols.filter((c) => !["id", "subject", "conversation_key", "latest_message_id"].includes(c)).join(", ") + ") " +
    "SELECT 300, 'Forced 500 fixture', 'forced-500|300', 'MSG300', " +
    cols.filter((c) => !["id", "subject", "conversation_key", "latest_message_id"].includes(c)).join(", ") + " FROM work_items WHERE id = 1"
  );
  insFail.run();
}

// Boots fixtures.js + child.js (with the mobile harness's extra module stubs layered on
// top via NODE_OPTIONS, see extra-stubs.js) against a fresh temp DB.
// opts: { tree, keep, phase }
async function bootServer(opts) {
  const tree = opts.tree;
  const runId = crypto.randomBytes(4).toString("hex");
  const tmpDir = path.join(os.tmpdir(), "axle-harness-mobile-" + runId);
  fs.mkdirSync(tmpDir, { recursive: true });
  const dbPath = path.join(tmpDir, "fixtures.db");
  const gateDir = path.join(tmpDir, "gate");
  fs.mkdirSync(gateDir, { recursive: true });

  const env = { ...process.env, ...BASE_ENV, AXLE_MIRROR: tree, AXLE_DB: dbPath, HARNESS_GATE: gateDir };
  await spawnP(process.execPath, [path.join(STEP0_DIR, "fixtures.js")], env);
  seed(dbPath, opts.phase);

  const extraStubs = path.join(__dirname, "extra-stubs.js");
  const priorNodeOptions = process.env.NODE_OPTIONS || "";
  const childEnv = { ...env, NODE_OPTIONS: ("--require " + extraStubs + " " + priorNodeOptions).trim() };
  // Phase 3 (C4): GET /item/300 throws in the child (extra-stubs.js); other phases never set it.
  if (String(opts.phase) === "3") childEnv.AXLE_HARNESS_FAIL_ITEM = "300";
  const { proc, port } = await startChild(path.join(tree, "server.js"), childEnv);

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    try { proc.kill("SIGKILL"); } catch (e) { /* already dead */ }
    await new Promise((r) => setTimeout(r, 150));
    if (!opts.keep) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    }
  }

  return { proc, port, baseUrl: "http://127.0.0.1:" + port, dbPath, tmpDir, stop };
}

module.exports = { bootServer, seed, BASE_ENV };
