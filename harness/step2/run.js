// run.js - UI rework STEP-2 verification harness (2026-06-10). Two parts:
//
//  1) BEHAVIOUR EQUIVALENCE vs the pre-Step-0 monolith snapshot, reusing the Step-0
//     fixtures/stubs/battery verbatim across the same 3 env phases. Every transport
//     field (status / redirect location / content-type / cookies / disposition),
//     every JSON and binary body, and the FINAL DB STATE must be byte-identical.
//     HTML bodies are EXPECTED to differ (that is the point of Step 2), so they are
//     excluded - the DB dump comparison is what proves no behaviour change.
//     NB: translate.js is stubbed without its cache table, so the translations
//     table stays empty in both trees - summary-translation INSERT order (which
//     changed with the F2 queue order) cannot create a false diff here, and on the
//     box the cache is keyed by sha so order never matters.
//
//  2) STRUCTURE ASSERTIONS on the post tree only (fresh fixtures, actions on): the
//     Step-2 page contract - three-pane shell + lazy queue on item deep links,
//     queue card-rows (F1), action-state vocabulary + needs-me-next order (F2),
//     "Live · updated" indicator (F3), collapsed toolbar with counted status tabs
//     (F4), HX fragment swaps incl. the busy self-poller, htmx vendored + identity-
//     gated, EN/NL parity, and Step-1 contract spot-checks inside the centre pane.
//
// Run from this directory:  node run.js
// env AXLE_MIRROR (post tree) / AXLE_PRE (monolith snapshot) override the defaults.
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const HERE = __dirname;
const STEP0 = path.join(HERE, "..", "step0");
const { runBattery } = require(path.join(STEP0, "battery.js"));

const TMP = "/tmp/axle-step2";
const MIRROR = process.env.AXLE_MIRROR || path.join(HERE, "..", "..", "box-code");
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
  const { child, dbPath } = await bootFresh(version, phase, phase.key);
  try {
    const result = await runBattery(phase.battery, `http://127.0.0.1:${child.port}`, path.join(TMP, `gate-${version}-${phase.key}`), dbPath);
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
// (HTML intentionally changed in Step 2). DB dump must match to the byte.
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
async function get(base, p, { user = BRAD, lang, hx } = {}) {
  const headers = {};
  if (user !== null) headers["Tailscale-User-Login"] = user;
  if (lang) headers.Cookie = "axle_lang=" + lang;
  if (hx) headers["HX-Request"] = "true";
  const r = await fetch(base + p, { headers, redirect: "manual" });
  return { status: r.status, ctype: String(r.headers.get("content-type") || ""), body: await r.text() };
}
const between = (html, a, b) => { const i = html.indexOf(a), j = html.indexOf(b); return i >= 0 && j >= 0 && i < j; };
const before = between;

async function structureChecks(base, dbPath) {
  const checks = [];
  const ok = (name, cond) => checks.push([name, !!cond]);

  // htmx vendored + identity-gated like every other asset (F13 discipline).
  // ASSET_V is read from the mirror so a cache-bust bump can't break the harness.
  const V = require(path.join(MIRROR, "views", "ui.js")).ASSET_V;
  const hjs = await get(base, `/assets/htmx.min.js?v=${V}`);
  const hjs403 = await get(base, "/assets/htmx.min.js", { user: null });
  const sse = await get(base, `/assets/sse.min.js?v=${V}`);
  const css = await get(base, `/assets/components.css?v=${V}`);
  ok("assets: htmx.min.js 200 + looks like htmx", hjs.status === 200 && /javascript/.test(hjs.ctype) && hjs.body.includes("htmx"));
  ok("assets: htmx 403 without tailnet identity", hjs403.status === 403);
  ok("assets: sse ext vendored (parked for Step 4)", sse.status === 200);
  ok("assets: components.css carries shell + qcard styles", css.status === 200 && css.body.includes(".shell {") && css.body.includes(".qcard {") && css.body.includes("ax-pulse"));

  // --- inbox = shell with INLINE queue, empty centre ---
  const ib = (await get(base, "/")).body;
  ok("inbox: three-pane shell present", ib.includes('class="shell"') && ib.includes('id="queuepane"') && ib.includes('id="workpane"'));
  ok("inbox: queue inline, not lazy", ib.includes('id="qlist"') && !ib.includes("queue-lazy"));
  ok("inbox: card-rows replace the table (F1)", ib.includes('class="qcard') && !ib.includes('<table id="inbox">') && !ib.includes("rowlink"));
  ok("inbox: empty-state centre prompt", ib.includes("Select an item from the list"));
  ok("inbox: htmx script tag + config", ib.includes(`src="/assets/htmx.min.js?v=${V}"`) && ib.includes("historyCacheSize"));
  ok("inbox: card click swaps workpane (htmx) with href fallback", ib.includes('hx-get="/item/3" hx-target="#workpane"') && ib.includes('href="/item/3"') && ib.includes('hx-push-url="true"'));
  // F2: action-state vocabulary + needs-me-next default order (fixtures: 3 flagged,
  // 2 awaiting, ready 4>5>1 by freshness, new 9>8)
  ok("queue: action labels (F2)", ib.includes("Needs your answer") && ib.includes("Ready to send"));
  ok("queue: flagged first (F2)", before(ib, 'href="/item/3"', 'href="/item/2"'));
  ok("queue: needs-answer before ready (F2)", before(ib, 'href="/item/2"', 'href="/item/4"'));
  ok("queue: ready by freshness 4,5,1 (F2)", before(ib, 'href="/item/4"', 'href="/item/5"') && before(ib, 'href="/item/5"', 'href="/item/1"'));
  ok("queue: new after ready, fresh first (F2)", before(ib, 'href="/item/1"', 'href="/item/9"') && before(ib, 'href="/item/9"', 'href="/item/8"'));
  ok("queue: flagged card shows single Check chip", ib.includes('<span class="chip inj">Check</span>'));
  ok("queue: paperclip badge on item 1 card (2 attachable suggestions)", ib.includes("&#128206;2"));
  ok("queue: no P1 badge when flagged chip already says check", !ib.includes('class="badge prio1"'));
  ok("queue: search index keeps intent/owner/id (parity)", /data-search="[^"]*order \/ status enquiry[^"]*"/i.test(ib) || ib.includes("order status"));
  // F3: live indicator + manual sync kept, old affordance gone
  ok("queue: Live · updated indicator (F3)", ib.includes("Live · updated") && ib.includes("livedot"));
  ok("queue: manual Sync kept, old 'Last synced' gone (F3)", ib.includes("Sync now") && !ib.includes("Last synced"));
  // F4: collapsed toolbar - Mine/All, counted tabs, search, mailbox in filter menu
  ok("toolbar: Mine/All segments (F4)", ib.includes(">Assigned to me<") && ib.includes('scope=mine"') && ib.includes('scope=all"'));
  ok("toolbar: status tabs with counts (F4)", ib.includes('Open<span class="n">7</span>') && ib.includes('Done<span class="n">1</span>') && ib.includes('Archived<span class="n">1</span>') && ib.includes('All<span class="n">9</span>'));
  ok("toolbar: mailbox filter inside menu (F4)", ib.includes('class="menu down qfilter"') && ib.includes('class="mitem') && !ib.includes('class="flabel"'));
  ok("toolbar: search + sort present", ib.includes('id="q"') && ib.includes('id="qsort"'));
  ok("toolbar: compose button + modal ride with the queue", ib.includes('id="composeBtn"') && ib.includes('id="composeModal"'));

  // NL parity on the new strings
  const ibNl = (await get(base, "/", { lang: "nl" })).body;
  ok("inbox NL: action labels localised", ibNl.includes("Jouw antwoord nodig") && ibNl.includes("Klaar om te versturen"));
  ok("inbox NL: live indicator localised", ibNl.includes("Live · bijgewerkt") && ibNl.includes("Kies een item uit de lijst"));

  // --- item deep link = full shell, queue lazy, centre+context panes ---
  const i1 = (await get(base, "/item/1")).body;
  ok("item1: full page shell (appshell body, wide main)", i1.includes("<!doctype html") && i1.includes('class="appshell"') && i1.includes('class="wide"'));
  ok("item1: queue lazy-loaded with selection", i1.includes('hx-get="/queue?sel=1"') && i1.includes("queue-lazy"));
  ok("item1: centre keeps Step-1 contract - reply card + sticky bar", i1.includes('id="replybox"') && i1.includes('form="workform" formaction="/item/1/send"') && i1.includes('id="ai_seed"'));
  ok("item1: centre keeps timeline + chip menus", i1.includes('class="msg"') && i1.includes('action="/item/1/language"') && i1.includes('action="/item/1/owner"'));
  ok("item1: context pane holds SAP docs + brief", between(i1, 'class="pane-context"', "SAP documents") && between(i1, 'class="pane-context"', "What Axle checked"));
  ok("item1: SAP docs card no longer in centre", between(i1, 'id="workform"', 'class="pane-context"') && between(i1, 'class="pane-context"', '<select name="doctype">'));
  ok("item1: suggested docs intact in context (F11)", i1.includes('value="90021"') && between(i1, "Different customer", 'value="90002"'));
  ok("item1: status chip uses new vocabulary", i1.includes("Ready to send"));

  // HX fragment render: panes only, no page chrome
  const f1 = await get(base, "/item/1", { hx: true });
  const f1b = f1.body;
  ok("item1 HX: fragment only (no doctype/header/title)", !f1b.includes("<!doctype") && !f1b.includes("<header>") && f1b.trim().startsWith('<section class="pane-center"'));
  ok("item1 HX: both panes in the fragment", f1b.includes('class="pane-center"') && f1b.includes('class="pane-context"') && f1b.includes('id="replybox"'));
  ok("item1 HX: no poller when not busy", !f1b.includes("delay:10s"));

  // HX 404 stays pane-shaped; plain 404 unchanged
  const f404 = await get(base, "/item/999", { hx: true });
  const p404 = await get(base, "/item/999");
  ok("404: HX pane-shaped, plain full page", f404.status === 404 && f404.body.includes("pane-center") && !f404.body.includes("<!doctype") && p404.status === 404 && p404.body.includes("<!doctype"));

  // /queue fragment: cards + sel highlight + modal, no chrome
  const qf = (await get(base, "/queue?sel=2")).body;
  ok("/queue: fragment with cards + toolbar", !qf.includes("<!doctype") && qf.includes('id="qlist"') && qf.includes('id="composeModal"'));
  ok("/queue: sel=2 highlights the open item", qf.includes('class="qcard sel" href="/item/2"'));

  // item 2 (awaiting_input): questions-first order survives inside the centre pane
  const i2 = (await get(base, "/item/2")).body;
  ok("item2: questions lead when blocking (F8 intact)", between(i2, 'name="answer_21"', 'id="replybox"'));
  ok("item2: queue card says Needs your answer", ib.includes("Needs your answer"));

  // item 3 (flagged): no send button anywhere, notice in the bar
  const i3 = (await get(base, "/item/3")).body;
  ok("item3: flagged item still cannot send", !i3.includes('formaction="/item/3/send"') && i3.includes("Sending disabled"));

  // item 4 (contact-form): no SAP-docs card -> context holds only the brief
  const i4 = (await get(base, "/item/4")).body;
  ok("item4: cf keeps picker, context has brief but no attach-doc", i4.includes('action="/item/4/contactform-recipient"') && !i4.includes("/item/4/attach-doc") && between(i4, 'class="pane-context"', "What Axle checked"));

  // item 5 (compose): instruction card in centre, subject field, SAP docs in context
  const i5 = (await get(base, "/item/5")).body;
  ok("item5: compose centre + context intact", i5.includes('name="compose_subject"') && !i5.includes('id="mq"') && between(i5, 'class="pane-context"', "/item/5/attach-doc"));

  // busy item: HX fragment self-polls, full page uses the meta refresh
  let d = new DatabaseSync(dbPath);
  d.prepare("UPDATE work_items SET status = 'investigating' WHERE id = 8").run();
  d.close();
  const f8 = (await get(base, "/item/8", { hx: true })).body;
  const p8 = (await get(base, "/item/8")).body;
  ok("busy HX: self-poller re-swaps the panes", f8.includes('hx-get="/item/8"') && f8.includes('hx-trigger="load delay:10s"') && f8.includes('hx-target="#workpane"'));
  ok("busy full page: meta refresh, no poller", p8.includes('content="10"') && !p8.includes("delay:10s"));
  ok("busy: drafting chip animated class present", p8.includes("s-investigating"));
  d = new DatabaseSync(dbPath);
  d.prepare("UPDATE work_items SET status = 'new' WHERE id = 8").run();
  d.close();

  // i18n parity: every EN key has an NL twin (and vice versa)
  const UI = require(path.join(MIRROR, "views", "ui.js"));
  const ek = Object.keys(UI.STRINGS.en), nk = Object.keys(UI.STRINGS.nl);
  ok(`i18n: STRINGS parity ${ek.length}/${nk.length}`, ek.length === nk.length && ek.every((k) => Object.prototype.hasOwnProperty.call(UI.STRINGS.nl, k)));
  ok("i18n: new status vocabulary in both languages", UI.statusLabel("en", "awaiting_input") === "Needs your answer" && UI.statusLabel("nl", "awaiting_input") === "Jouw antwoord nodig");

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
    const checks = await structureChecks(`http://127.0.0.1:${child.port}`, dbPath);
    const bad = checks.filter(([, okk]) => !okk);
    checks.forEach(([name, okk]) => console.log((okk ? "  PASS " : "  FAIL ") + name));
    console.log(`STRUCTURE: ${checks.length - bad.length}/${checks.length} PASS`);
    fail += bad.length;
  } finally {
    child.proc.kill("SIGKILL");
  }

  console.log(fail ? `\nRESULT: FAIL (${fail} issues)` : "\nRESULT: PASS - behaviour unchanged, Step-2 structure in place");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("HARNESS ERROR:", e.message); process.exit(2); });
