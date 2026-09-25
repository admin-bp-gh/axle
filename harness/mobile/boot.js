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
// the sync lock, a forced 500"), using the real schema directly via node:sqlite. No-op
// today: Phase 0 needs no extra seeding beyond the 9 Step-0 fixture items.
function seed(dbPath, phase) {
  void phase;
  const d = new DatabaseSync(dbPath);
  try {
    // Intentionally empty. A future phase module adds rows here, guarded by `phase`.
  } finally {
    d.close();
  }
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
