// run.js - UI rework STEP-1 verification harness (2026-06-10). Two parts:
//
//  1) BEHAVIOUR EQUIVALENCE vs the pre-Step-0 monolith snapshot, reusing the Step-0
//     fixtures/stubs/battery verbatim across the same 3 env phases. Every transport
//     field (status / redirect location / content-type / cookies / disposition),
//     every JSON and binary body, and the FINAL DB STATE must be byte-identical.
//     HTML bodies are EXPECTED to differ (that is the point of Step 1), so they are
//     excluded - the DB dump comparison is what proves no behaviour change.
//
//  2) STRUCTURE ASSERTIONS on the post tree only (fresh fixtures, actions on): the
//     Step-1 page contract - chip menus (F5), single reply card + reset/translate
//     toggle (F6), conversation timeline (F7), state-driven section order (F8),
//     sticky action bar + overflow close menu (F9), combined SAP-documents card
//     (F11), stylesheet links + identity-gated /assets (F13).
//
// Run from this directory:  node run.js
// env AXLE_MIRROR (post tree) / AXLE_PRE (monolith snapshot) override the defaults.
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const STEP0 = path.join(HERE, "..", "step0");
const { runBattery } = require(path.join(STEP0, "battery.js"));

const TMP = "/tmp/axle-step1";
const MIRROR = process.env.AXLE_MIRROR || "/sessions/pensive-zen-noether/mnt/Axle/box-code";
const PRE = process.env.AXLE_PRE || path.join(STEP0, "pre-app");
const ENTRIES = { pre: path.join(PRE, "server.js"), post: path.join(MIRROR, "server.js") };
const PHASES = [
  { key: "A", battery: "full", env: { AXLE_ACTION_COMPOSE_SEND: "on", AXLE_ACTION_CONTACTFORM_SEND: "on" } },
  { key: "B", battery: "off", env: {} },
  { key: "C", battery: "csrf", env: { AXLE_ACTION_COMPOSE_SEND: "on", AXLE_ACTION_CONTACTFORM_SEND: "on", AXLE_ALLOWED_ORIGIN: "https://axle-box.tail58a804.ts.net" } },
];
const BASE_ENV = {
  AXLE_MIRROR: MIRROR,            // fixtures.js resolves the real db.js through this
  MAILBOX_INFO: "info@budget-parts.nl",
  MAILBOX_DRACHTEN: "drachten@budget-parts.nl",
  ANTHROPIC_API_KEY: "harness-stub-key",
};
const BRAD = "admin@budget-parts.nl";

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
    const p = spawn(process.execPath, [path.join(STEP0, "child.js")], { env: { ...process.env, ...env, HARNESS_ENTRY: entry } });
    let out = "", err = "";
    const to = setTimeout(() => { p.kill("SIGKILL"); rej(new Error("child start timeout\n" + out + err)); }, 20000);
    p.stdout.on("data", (d) => {
      out += d;
      const m = /HARNESS_PORT=(\d+)/.exec(out);
      if (m) { clearTimeout(to); res({ proc: p, port: +m[1] }); }
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("exit", () => { clearTimeout(to); rej(new Error("child exited early\n" + out + err)); });
  });
}

async function bootFresh(version, phase, tag) {
  const dbPath = path.join(TMP, `axle-${version}-${tag}.db`);
  const gateDir = path.join(TMP, `gate-${version}-${tag}`);
  for (const suf of ["", "-wal", "-shm"]) { try { fs.unlinkSync(dbPath + suf); } catch (e) {} }
  fs.rmSync(gateDir, { recursive: true, force: true });
  fs.mkdirSync(gateDir, { recursive: true });
  fs.mkdirSync(TMP, { recursive: true });
  const env = { ...BASE_ENV, ...phase.env, AXLE_DB: dbPath, HARNESS_GATE: gateDir };
  await spawnP(process.execPath, [path.join(STEP0, "fixtures.js")], env);
  const child = await startChild(ENTRIES[version], env);
  return { child, dbPath, gateDir };
}

async function runOne(version, phase) {
  const { child, dbPath, gateDir } = await bootFresh(version, phase, phase.key);
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

// Part-1 comparison: transport fields always; bodies ONLY for JSON + binary records
// (HTML intentionally changed in Step 1). DB dump must match to the byte.
function diffPhase(phase, pre, post) {
  const issues = [];
  if (pre.records.length !== post.records.length) issues.push(`record count ${pre.records.length} vs ${post.records.length}`);
  const n = Math.min(pre.records.length, post.records.length);
  let htmlDiffers = 0;
  for (let i = 0; i < n; i++) {
    const A = pre.records[i], B = post.records[i];
    for (const f of ["name", "method", "path", "status", "location", "ctype", "setCookie", "disp"]) {
      if (String(A[f]) !== String(B[f])) issues.push(`[${A.name}] ${f}: "${A[f]}" vs "${B[f]}"`);
    }
    const isJson = /json/.test(A.ctype);
    const isBin = A.body.startsWith("<binary");
    if (isJson || isBin) {
      if (A.body !== B.body || A.bodySha !== B.bodySha) {
        const i0 = firstDiff(A.body, B.body);
        issues.push(`[${A.name}] ${isJson ? "JSON" : "binary"} body differs at ${i0}:\n  pre : …${A.body.slice(Math.max(0, i0 - 60), i0 + 120)}…\n  post: …${B.body.slice(Math.max(0, i0 - 60), i0 + 120)}…`);
      }
    } else if (A.body !== B.body) htmlDiffers++;
  }
  if (pre.dump !== post.dump) {
    const i0 = firstDiff(pre.dump, post.dump);
    issues.push(`DB dump differs at offset ${i0}:\n  pre : …${pre.dump.slice(Math.max(0, i0 - 80), i0 + 160)}…\n  post: …${post.dump.slice(Math.max(0, i0 - 80), i0 + 160)}…`);
  }
  return { issues, htmlDiffers };
}

// ---------- Part 2: structure assertions on the post tree ----------
async function get(base, p, { user = BRAD, lang } = {}) {
  const headers = {};
  if (user !== null) headers["Tailscale-User-Login"] = user;
  if (lang) headers.Cookie = "axle_lang=" + lang;
  const r = await fetch(base + p, { headers, redirect: "manual" });
  return { status: r.status, ctype: String(r.headers.get("content-type") || ""), body: await r.text() };
}
const between = (html, a, b) => { const i = html.indexOf(a), j = html.indexOf(b); return i >= 0 && j >= 0 && i < j; };

async function structureChecks(base) {
  const checks = [];
  const ok = (name, cond) => checks.push([name, !!cond]);

  // F13: assets are served, css, and identity-gated like every other route
  const tok = await get(base, "/assets/tokens.css?v=s1");
  const comp = await get(base, "/assets/components.css?v=s1");
  const tok403 = await get(base, "/assets/tokens.css", { user: null });
  ok("assets: tokens.css 200 text/css", tok.status === 200 && /text\/css/.test(tok.ctype) && tok.body.includes("--accent: #166534"));
  ok("assets: components.css 200 text/css", comp.status === 200 && /text\/css/.test(comp.ctype) && comp.body.includes(".actionbar"));
  ok("assets: 403 without tailnet identity", tok403.status === 403);

  const inbox = await get(base, "/");
  ok("inbox: links tokens.css + components.css", inbox.body.includes("/assets/tokens.css?v=") && inbox.body.includes("/assets/components.css?v="));
  ok("inbox: no inline <style> block", !inbox.body.includes("<style>"));
  ok("inbox: table + compose button intact", inbox.body.includes("rowlink") && inbox.body.includes("compose-open"));

  // item 1: inbound, ready, full draft, suggestions, open optional question
  const i1 = (await get(base, "/item/1")).body;
  ok("item1: reply leads, questions collapsed after (F8)", between(i1, 'id="replybox"', 'name="answer_11"'));
  ok("item1: language chip menu posts /language (F5)", i1.includes('action="/item/1/language"') && i1.includes('value="de" class="on"'));
  ok("item1: owner chip menu posts /owner (F5)", i1.includes('action="/item/1/owner"'));
  ok("item1: old duplicate selectors gone (F5)", !i1.includes('class="relang"') && !i1.includes("Use this as my reply") && !i1.includes('id="ai_full"'));
  ok("item1: single reply card with hidden AI seed (F6)", i1.includes('id="ai_seed"') && i1.includes("Reset to AI draft (v1)"));
  ok("item1: timeline newest msg + folded history (F7)", i1.includes('class="msg"') && i1.includes("Earlier in this conversation"));
  ok("item1: per-message translation toggle (F7)", i1.includes('id="emailtrbtn"') && i1.includes('id="emailtr"'));
  ok("item1: sticky bar submits workform (F9)", i1.includes('form="workform" formaction="/item/1/send"') && i1.includes('form="workform" name="action" value="save"') && i1.includes('class="primary" name="action" value="redraft"'));
  ok("item1: close actions in overflow menu with descriptions (F9)", i1.includes('class="menu"') && i1.includes('value="done"') && i1.includes('value="phone"') && i1.includes('value="archived"') && i1.includes(`action="/item/1/block"`));
  ok("item1: combined SAP documents card (F11)", i1.includes("SAP documents") && i1.includes('value="90021"') && i1.includes('<select name="doctype">'));
  ok("item1: out-of-scope doc behind review fold (F11)", i1.includes('value="90002"') && between(i1, "Different customer", 'value="90002"'));
  ok("item1: brief still reachable", i1.includes("What Axle checked"));

  // item 2: awaiting_input with open questions -> questions card leads (F8)
  const i2 = (await get(base, "/item/2")).body;
  ok("item2: questions lead when blocking (F8)", between(i2, 'name="answer_21"', 'id="replybox"'));
  ok("item2: feedback field inside questions card", between(i2, 'name="answer_21"', 'name="feedback"') && between(i2, 'name="feedback"', 'id="replybox"'));
  ok("item2: reset to AI (interim seed, no version)", i2.includes("Reset to AI draft<") && i2.includes('id="ai_seed"'));
  const i2nl = (await get(base, "/item/2", { lang: "nl" })).body;
  ok("item2 NL: chip menu + bar strings localised", i2nl.includes("Terug naar AI-concept") && i2nl.includes("Meer acties"));

  // item 3: injection-flagged -> no send anywhere, notice in the bar
  const i3 = (await get(base, "/item/3")).body;
  ok("item3: no send button for flagged item", !i3.includes("formaction=\"/item/3/send\""));
  ok("item3: flagged notice in action bar", i3.includes("Sending disabled"));

  // item 4: contact-form -> subject in reply card, picker intact, no SAP docs card
  const i4 = (await get(base, "/item/4")).body;
  ok("item4: cf subject field in reply card", i4.includes('name="cf_subject"') && between(i4, 'name="cf_subject"', 'id="replybox"'));
  ok("item4: recipient picker posts unchanged route", i4.includes(`action="/item/4/contactform-recipient"`));
  ok("item4: no SAP documents card for contact-form", !i4.includes("/item/4/attach-doc"));

  // item 5: compose -> instruction card, subject field, no inbound search, SAP docs, no block
  const i5 = (await get(base, "/item/5")).body;
  ok("item5: compose subject field present", i5.includes('name="compose_subject"') && i5.includes('value="Betaling order 226108"'));
  ok("item5: instruction card, no inbound email search", i5.includes("Vraag om betaling van order 226108") && !i5.includes('id="mq"'));
  ok("item5: language menu carries redraft note", i5.includes("Changing the language re-drafts the email."));
  ok("item5: SAP documents card present, no block-sender", i5.includes("/item/5/attach-doc") && !i5.includes("/item/5/block"));

  // item 6 (done) + item 8 (new, no drafts)
  const i6 = (await get(base, "/item/6")).body;
  ok("item6: closed item gets reopen bar, no workform", i6.includes('value="reopen"') && !i6.includes('id="workform"'));
  const i8 = (await get(base, "/item/8")).body;
  ok("item8: no AI seed -> no reset button", !i8.includes('id="ai_seed"') && !i8.includes("Reset to AI draft"));

  return checks;
}

(async () => {
  let fail = 0;

  // Part 1 - behaviour equivalence across the 3 phases
  for (const phase of PHASES) {
    const pre = await runOne("pre", phase);
    const post = await runOne("post", phase);
    const { issues, htmlDiffers } = diffPhase(phase, pre, post);
    if (issues.length) {
      fail += issues.length;
      console.log(`PHASE ${phase.key} (${phase.battery}, ${pre.records.length} responses): ${issues.length} DIFFERENCE(S)`);
      issues.slice(0, 12).forEach((x) => console.log("  - " + x));
      if (issues.length > 12) console.log(`  … and ${issues.length - 12} more`);
    } else {
      console.log(`PHASE ${phase.key} (${phase.battery}): ${pre.records.length} responses - transport + JSON/binary + DB state identical (${htmlDiffers} HTML bodies differ, as intended) - PASS`);
    }
  }

  // Part 2 - structure assertions (post only, fresh fixtures, actions on)
  const { child, dbPath } = await bootFresh("post", PHASES[0], "X");
  try {
    const checks = await structureChecks(`http://127.0.0.1:${child.port}`);
    const bad = checks.filter(([, okk]) => !okk);
    checks.forEach(([name, okk]) => console.log((okk ? "  PASS " : "  FAIL ") + name));
    console.log(`STRUCTURE: ${checks.length - bad.length}/${checks.length} PASS`);
    fail += bad.length;
  } finally {
    child.proc.kill("SIGKILL");
  }

  console.log(fail ? `\nRESULT: FAIL (${fail} issues)` : "\nRESULT: PASS - behaviour unchanged, Step-1 structure in place");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(2); });
