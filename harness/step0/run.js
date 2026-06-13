// run.js - Step-0 equivalence orchestrator. For each phase (allow-list env combos) it
// boots the PRE (monolith snapshot) and POST (refactored) servers against identical
// fixture DBs, fires the same battery, and byte-diffs every recorded response + the
// final DB dumps. PASS = zero differences.
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { runBattery } = require("./battery.js");

const HERE = __dirname;
const TMP = "/tmp/axle-step0";
const ENTRIES = {
  pre: (process.env.AXLE_PRE || "/sessions/stoic-sweet-heisenberg/mnt/outputs/pre-app") + "/server.js",
  post: (process.env.AXLE_MIRROR || "/sessions/stoic-sweet-heisenberg/mnt/Axle/box-code") + "/server.js",
};
const PHASES = [
  { key: "A", battery: "full", env: { AXLE_ACTION_COMPOSE_SEND: "on", AXLE_ACTION_CONTACTFORM_SEND: "on" } },
  { key: "B", battery: "off", env: {} },
  { key: "C", battery: "csrf", env: { AXLE_ACTION_COMPOSE_SEND: "on", AXLE_ACTION_CONTACTFORM_SEND: "on", AXLE_ALLOWED_ORIGIN: "https://axle-box.tail58a804.ts.net" } },
];
const BASE_ENV = {
  MAILBOX_INFO: "info@budget-parts.nl",
  MAILBOX_DRACHTEN: "drachten@budget-parts.nl",
  ANTHROPIC_API_KEY: "harness-stub-key",
};

function spawnP(cmd, args, env) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { env: { ...process.env, ...env } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", (c) => (c === 0 ? res(out) : rej(new Error(cmd + " exited " + c + "\n" + out + err))));
  });
}

function startChild(entry, env) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [path.join(HERE, "child.js")], { env: { ...process.env, ...env, HARNESS_ENTRY: entry } });
    let out = "", err = "";
    const to = setTimeout(() => { p.kill("SIGKILL"); rej(new Error("child start timeout\n" + out + err)); }, 20000);
    p.stdout.on("data", (d) => {
      out += d;
      const m = /HARNESS_PORT=(\d+)/.exec(out);
      if (m) { clearTimeout(to); res({ proc: p, port: +m[1], errRef: () => err }); }
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", () => { clearTimeout(to); rej(new Error("child exited early\n" + out + err)); });
  });
}

async function runOne(version, phase) {
  const dbPath = path.join(TMP, `axle-${version}-${phase.key}.db`);
  const gateDir = path.join(TMP, `gate-${version}-${phase.key}`);
  for (const suf of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + suf); } catch (e) {} }
  fs.rmSync(gateDir, { recursive: true, force: true });
  fs.mkdirSync(gateDir, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });

  const env = { ...BASE_ENV, ...phase.env, AXLE_DB: dbPath, HARNESS_GATE: gateDir };
  await spawnP(process.execPath, [path.join(HERE, "fixtures.js")], env);
  const child = await startChild(ENTRIES[version], env);
  try {
    const result = await runBattery(phase.battery, `http://127.0.0.1:${child.port}`, gateDir, dbPath);
    fs.writeFileSync(path.join(HERE, `result-${version}-${phase.key}.json`), JSON.stringify(result, null, 1));
    return result;
  } finally {
    child.proc.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 150));
  }
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function diffPhase(phase, pre, post) {
  const issues = [];
  if (pre.records.length !== post.records.length) issues.push(`record count ${pre.records.length} vs ${post.records.length}`);
  const n = Math.min(pre.records.length, post.records.length);
  for (let i = 0; i < n; i++) {
    const A = pre.records[i], B = post.records[i];
    for (const f of ["name", "method", "path", "status", "location", "ctype", "setCookie", "disp"]) {
      if (String(A[f]) !== String(B[f])) issues.push(`[${A.name}] ${f}: "${A[f]}" vs "${B[f]}"`);
    }
    if (A.body !== B.body) {
      const i0 = firstDiff(A.body, B.body);
      issues.push(`[${A.name}] body differs at offset ${i0}:\n  pre : …${A.body.slice(Math.max(0, i0 - 60), i0 + 120)}…\n  post: …${B.body.slice(Math.max(0, i0 - 60), i0 + 120)}…`);
    } else if (A.bodySha !== B.bodySha && A.body.startsWith("<binary")) {
      issues.push(`[${A.name}] binary body sha differs`);
    }
  }
  if (pre.dump !== post.dump) {
    const i0 = firstDiff(pre.dump, post.dump);
    issues.push(`DB dump differs at offset ${i0}:\n  pre : …${pre.dump.slice(Math.max(0, i0 - 80), i0 + 160)}…\n  post: …${post.dump.slice(Math.max(0, i0 - 80), i0 + 160)}…`);
  }
  return issues;
}

(async () => {
  let fail = 0;
  for (const phase of PHASES) {
    const pre = await runOne("pre", phase);
    const post = await runOne("post", phase);
    const issues = diffPhase(phase, pre, post);
    const steps = pre.records.length;
    if (issues.length) {
      fail += issues.length;
      console.log(`PHASE ${phase.key} (${phase.battery}, ${steps} responses): ${issues.length} DIFFERENCE(S)`);
      issues.slice(0, 12).forEach((x) => console.log("  - " + x));
      if (issues.length > 12) console.log(`  … and ${issues.length - 12} more`);
    } else {
      console.log(`PHASE ${phase.key} (${phase.battery}): ${steps} responses + DB dump identical - PASS`);
    }
  }
  console.log(fail ? `\nRESULT: FAIL (${fail} differences)` : "\nRESULT: PASS - pre and post are equivalent");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(2); });
