// harness-bugs.js - targeted harness for the two 2026-06-11 shell bugfixes.
// Runs the REAL db.js/routes/server (step0 stub kit; only network/model stubbed):
//   Bug 1 (click does nothing):
//     - translate.js API call is bounded (static: timeout + maxRetries options)
//     - async safety net: a rejecting async route returns a response instead of
//       hanging, through the REAL error middleware (500 + audit 'route_error',
//       pane-shaped for HX-Request, full page for plain)
//     - client: htmx-config carries a timeout; page script listens for
//       htmx:responseError/sendError/timeout and surfaces into #workpane
//   Bug 2 (item erratically closes):
//     - NO <meta http-equiv="refresh"> on any shell render (/, /item/:id), even
//       while sync is running or an item is investigating
//     - queue self-poll singleton present, sec=8 while syncing / 15 investigating /
//       0 idle; /queue fragment carries the same config (self-extinguishing)
//     - busy item: htmx self-poll div present on BOTH the fragment and full-shell
// Run: AXLE_MIRROR=<box-code> node harness-bugs.js
"use strict";
const path = require("path");
const fs = require("fs");

const MIRROR = process.env.AXLE_MIRROR || "/sessions/upbeat-vigilant-allen/mnt/Axle/box-code";
const STEP0 = process.env.AXLE_STEP0 || "/sessions/upbeat-vigilant-allen/mnt/Axle/harness/step0";
process.env.AXLE_MIRROR = MIRROR;
process.env.AXLE_DB = path.join(require("os").tmpdir(), "axle-bugs-" + process.pid + ".db");
process.env.MAILBOX_INFO = "info@budget-parts.nl";
process.env.MAILBOX_DRACHTEN = "drachten@budget-parts.nl";
process.env.ANTHROPIC_API_KEY = "harness-stub-key";

let n = 0, fails = 0;
const ok = (cond, name, detail) => {
  n++;
  if (!cond) { fails++; console.log(`FAIL ${n}: ${name}${detail ? " - " + detail : ""}`); }
  else console.log(`ok ${n}: ${name}`);
};

// ---- static asserts -----------------------------------------------------------------
const trSrc = fs.readFileSync(path.join(MIRROR, "translate.js"), "utf8");
ok(/\{\s*timeout:\s*25000,\s*maxRetries:\s*1\s*\}/.test(trSrc), "translate.js API call bounded (25s, 1 retry)");
const uiSrc = fs.readFileSync(path.join(MIRROR, "views", "ui.js"), "utf8");
ok(/"timeout":60000/.test(uiSrc), "htmx-config carries a 60s client timeout");

require(path.join(STEP0, "stubs.js"));
const { db } = require(path.join(MIRROR, "db.js"));

// seed: user + a plain item + a busy (investigating) item
db.prepare("INSERT INTO users (tailscale_login, display_name, role, owner_label) VALUES (?,?,?,?)")
  .run("admin@budget-parts.nl", "Brad", "admin", null);
const WI = `INSERT INTO work_items (id, mailbox, conversation_key, sender_email, sender_name, subject,
  language, intent, priority, status, injection_flag, summary, email_text, email_received,
  created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
const T = "2026-06-11 10:00:00";
db.prepare(WI).run(1, "info", "c1", "a@b.nl", "A", "Plain item", "en", "other", 2, "ready", 0, "s", "Hello", T, T, T);
db.prepare(WI).run(2, "info", "c2", "c@d.nl", "C", "Busy item", "en", "other", 2, "investigating", 0, "s", "Hi", T, T, T);

// boot the real server on an ephemeral port, capturing the app instance
const express = require(path.join(MIRROR, "node_modules", "express"));
const origListen = express.application.listen;
let port, capturedApp;
const ready = new Promise((resolve) => {
  express.application.listen = function (...args) {
    capturedApp = this;
    const srv = origListen.call(this, 0, "127.0.0.1", () => { port = srv.address().port; resolve(); });
    return srv;
  };
});
require(path.join(MIRROR, "server.js"));

(async () => {
  await ready;

  const get = async (p, opts) => {
    const headers = { "Tailscale-User-Login": "admin@budget-parts.nl", ...(opts && opts.headers) };
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers });
    return { status: r.status, text: await r.text() };
  };
  const META = '<meta http-equiv="refresh" content=';

  // ---- Bug 2: idle shell (item 2 not yet busy; startup resets investigating anyway) ----
  db.prepare("UPDATE sync_state SET running = 0, finished_at = datetime('now') WHERE id = 1").run();
  let r = await get("/");
  ok(r.status === 200, "GET / 200");
  ok(!r.text.includes(META), "idle shell: no meta refresh");
  ok(r.text.includes("__axQPoll"), "idle shell: queue poll singleton present");
  ok(/__axQPoll = \{ sec: 0,/.test(r.text), "idle shell: poll sec=0 (dormant)");

  // ---- Bug 2: sync running ----
  db.prepare("UPDATE sync_state SET running = 1 WHERE id = 1").run();
  r = await get("/");
  ok(!r.text.includes(META), "syncing shell: STILL no meta refresh (the bug)");
  ok(/__axQPoll = \{ sec: 8,/.test(r.text), "syncing shell: poll sec=8");
  r = await get("/queue?mailbox=all&show=open&scope=all&sel=1");
  ok(/__axQPoll = \{ sec: 8,/.test(r.text), "queue fragment carries the poll config");
  db.prepare("UPDATE sync_state SET running = 0 WHERE id = 1").run();

  // ---- Bug 2: investigating -> sec 15; busy item self-poll on both branches ----
  db.prepare("UPDATE work_items SET status = 'investigating' WHERE id = 2").run();
  r = await get("/");
  ok(/__axQPoll = \{ sec: 15,/.test(r.text), "investigating: poll sec=15");
  r = await get("/item/2");
  ok(!r.text.includes(META), "busy item full shell: no meta refresh");
  ok(r.text.includes('hx-trigger="load delay:10s"'), "busy item full shell: htmx self-poll div");
  r = await get("/item/2", { headers: { "HX-Request": "true" } });
  ok(r.text.includes('hx-trigger="load delay:10s"'), "busy item fragment: htmx self-poll div");
  r = await get("/item/1");
  ok(!r.text.includes('load delay:10s'), "non-busy item: no self-poll");

  // ---- Bug 1: client error surface in the page script ----
  ok(r.text.includes("htmx:responseError"), "page script listens for htmx errors");
  const nl = await get("/item/1", { headers: { Cookie: "axle_lang=nl" } });
  ok(nl.text.includes("kon niet worden geladen"), "NL error text wired in");

  // ---- Bug 1: rejected async handler -> REAL error middleware, end to end ----
  // (Express 5 forwards async rejections to error middleware natively.) Register a
  // rejecting route, then move its layer in front of the error middleware so the
  // error flows through the real one.
  capturedApp.get("/__harness_throw", async () => { throw new Error("boom-async"); });
  const stack = capturedApp.router.stack;
  const layer = stack.pop();
  const errIdx = stack.findIndex((l) => l.handle && l.handle.length === 4);
  ok(errIdx > -1, "error middleware registered");
  stack.splice(errIdx, 0, layer);

  const t0 = Date.now();
  r = await get("/__harness_throw", { headers: { "HX-Request": "true" } });
  ok(Date.now() - t0 < 5000, "rejecting async route RESPONDS (no hang)", (Date.now() - t0) + "ms");
  ok(r.status === 500, "HX error response is 500", String(r.status));
  ok(r.text.includes("workpanes") || r.text.includes("could not be loaded"), "HX error is pane-shaped + readable");
  ok(r.text.includes("boom-async"), "short error message included");
  r = await get("/__harness_throw");
  ok(r.status === 500 && r.text.includes("<!doctype html>"), "plain navigation error = full page");
  const auditRows = db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'route_error'").get();
  ok(auditRows.c >= 2, "route_error audited", String(auditRows.c));

  console.log(fails ? `\n${fails}/${n} FAILED` : `\nALL ${n} PASS`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
