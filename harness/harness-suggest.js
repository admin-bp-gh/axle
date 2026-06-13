// harness-suggest.js - targeted harness for the no_reply auto-close fix.
// Proves on the REAL db.js schema + REAL routes (step0 stub kit: only network/model
// modules stubbed) that:
//   1. db.js migration adds work_items.suggest_close (default 0)
//   2. persistResult maps no_reply -> status 'new' + suggest_close=1 (NOT 'done')
//   3. persistResult maps ready / awaiting_input as before, suggest_close reset to 0
//   4. ingest.js carries the same mapping (static source assert; ingest itself is
//      stubbed by the kit, so its mapping is checked in the file text)
//   5. inbox + item pages show the "No reply needed?" chip ONLY on open suggested
//      items (not on done items, not on plain open items); EN + NL
// Run: AXLE_MIRROR=<box-code> node harness-suggest.js
"use strict";
const path = require("path");
const fs = require("fs");

const MIRROR = process.env.AXLE_MIRROR || "/sessions/upbeat-vigilant-allen/mnt/Axle/box-code";
const STEP0 = process.env.AXLE_STEP0 || "/sessions/upbeat-vigilant-allen/mnt/Axle/harness/step0";
process.env.AXLE_MIRROR = MIRROR;
process.env.AXLE_DB = path.join(require("os").tmpdir(), "axle-suggest-" + process.pid + ".db");
process.env.MAILBOX_INFO = "info@budget-parts.nl";
process.env.MAILBOX_DRACHTEN = "drachten@budget-parts.nl";
process.env.ANTHROPIC_API_KEY = "harness-stub-key";

let n = 0, fails = 0;
function ok(cond, name, detail) {
  n++;
  if (!cond) { fails++; console.log(`FAIL ${n}: ${name}${detail ? " - " + detail : ""}`); }
  else console.log(`ok ${n}: ${name}`);
}

require(path.join(STEP0, "stubs.js")); // module interceptor (better-sqlite3 shim, model/network stubs)
const { db } = require(path.join(MIRROR, "db.js"));

// ---- 1. schema ---------------------------------------------------------------------
const cols = db.prepare("SELECT name, dflt_value FROM pragma_table_info('work_items')").all();
const sc = cols.find((c) => c.name === "suggest_close");
ok(!!sc, "suggest_close column exists");
ok(sc && String(sc.dflt_value) === "0", "suggest_close defaults to 0", sc && sc.dflt_value);

// ---- seed --------------------------------------------------------------------------
db.prepare("INSERT INTO users (tailscale_login, display_name, role, owner_label) VALUES (?,?,?,?)")
  .run("admin@budget-parts.nl", "Brad", "admin", null);
const WI = `INSERT INTO work_items (id, mailbox, conversation_key, sender_email, sender_name, subject,
  language, intent, priority, status, injection_flag, summary, email_text, email_received,
  created_at, updated_at, suggest_close, resolution)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
const T = "2026-06-11 10:00:00";
// #1 open, engine-suggested close (the fixed path)
db.prepare(WI).run(1, "info", "c1", "admin@budget-parts.nl", "Brad", "Jack pls call Ger Zaanland",
  "en", "other", 2, "new", 0, "Internal: ask Jack to call Ger", "Please call Ger.", T, T, T, 1, null);
// #2 done (human-closed) item that ALSO has the flag - chip must NOT show on closed items
db.prepare(WI).run(2, "info", "c2", "ivo@example.com", "Ivo de Bruin", "Thanks, all sorted",
  "nl", "other", 2, "done", 0, "Closing thanks", "Bedankt, opgelost.", T, T, T, 1, "done");
// #3 plain open item, no suggestion
db.prepare(WI).run(3, "info", "c3", "cust@example.com", "Customer", "Order question",
  "en", "order_status", 2, "ready", 0, "Order Q", "Where is my order?", T, T, T, 0, null);

// ---- 2/3. persistResult mapping (REAL routes/shared.js) -----------------------------
const shared = require(path.join(MIRROR, "routes", "shared.js"));
const row = (id) => db.prepare("SELECT status, suggest_close, resolution FROM work_items WHERE id = ?").get(id);

shared.persistResult(3, { status: "no_reply", confidence: "high", questions_for_salesperson: [], physical_checks: [] }, [], {});
let r = row(3);
ok(r.status === "new", "no_reply -> status 'new' (not done)", r.status);
ok(r.suggest_close === 1, "no_reply -> suggest_close=1", String(r.suggest_close));
ok(r.resolution === null, "no_reply sets no resolution", String(r.resolution));

shared.persistResult(3, { status: "ready", draft: "Hello", confidence: "high", questions_for_salesperson: [], physical_checks: [] }, [], {});
r = row(3);
ok(r.status === "ready", "ready -> status 'ready'", r.status);
ok(r.suggest_close === 0, "ready resets suggest_close=0", String(r.suggest_close));

shared.persistResult(3, { status: "awaiting_input", questions_for_salesperson: ["Check shelf"], physical_checks: [], confidence: "low" }, [], {});
r = row(3);
ok(r.status === "awaiting_input", "awaiting_input unchanged", r.status);
ok(r.suggest_close === 0, "awaiting_input keeps suggest_close=0", String(r.suggest_close));

// restore #3 as plain ready for the UI render below
shared.persistResult(3, { status: "ready", draft: "Hello", confidence: "high", questions_for_salesperson: [], physical_checks: [] }, [], {});

// ---- 4. ingest.js mapping (static: ingest is stubbed by the kit) --------------------
const ing = fs.readFileSync(path.join(MIRROR, "ingest.js"), "utf8");
ok(!/no_reply"\s*\?\s*"done"/.test(ing), "ingest.js no longer maps no_reply->done");
ok(/no_reply"\s*\?\s*"new"/.test(ing), "ingest.js maps no_reply->new");
ok(/suggest_close = \?/.test(ing) && /suggest_close = 0/.test(ing), "ingest.js writes + resets suggest_close");
const shr = fs.readFileSync(path.join(MIRROR, "routes", "shared.js"), "utf8");
ok(!/no_reply"\s*\?\s*"done"/.test(shr), "routes/shared.js no longer maps no_reply->done");

// ---- 5. UI: real server, real routes ------------------------------------------------
const express = require(path.join(MIRROR, "node_modules", "express"));
const origListen = express.application.listen;
let port;
const ready = new Promise((resolve) => {
  express.application.listen = function (...args) {
    const srv = origListen.call(this, 0, "127.0.0.1", () => { port = srv.address().port; resolve(); });
    return srv;
  };
});
require(path.join(MIRROR, "server.js"));

(async () => {
  await ready;
  const get = async (p, lang) => {
    const headers = { "Tailscale-User-Login": "admin@budget-parts.nl" };
    if (lang) headers.Cookie = "axle_lang=" + lang;
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers });
    return r.text();
  };
  const CHIP_EN = "No reply needed?", CHIP_NL = "Geen antwoord nodig?";

  const inboxOpen = await get("/?mailbox=all&show=open&scope=all");
  ok(inboxOpen.includes(CHIP_EN), "open inbox: chip on suggested item");
  ok(inboxOpen.split(CHIP_EN).length - 1 === 1, "open inbox: chip on exactly ONE item",
    `count=${inboxOpen.split(CHIP_EN).length - 1}`);
  ok(inboxOpen.includes("Jack pls call Ger Zaanland"), "suggested item IS in the open list");

  const inboxDone = await get("/?mailbox=all&show=done&scope=all");
  ok(!inboxDone.includes(CHIP_EN), "done tab: no suggestion chip on closed items");

  const item1 = await get("/item/1");
  ok(item1.includes(CHIP_EN), "item page: chip on open suggested item");
  const item2 = await get("/item/2");
  ok(!item2.includes(CHIP_EN), "item page: no chip on done item");
  const item3 = await get("/item/3");
  ok(!item3.includes(CHIP_EN), "item page: no chip on plain open item");

  const item1nl = await get("/item/1", "nl");
  ok(item1nl.includes(CHIP_NL), "item page NL: Dutch chip text");

  console.log(fails ? `\n${fails}/${n} FAILED` : `\nALL ${n} PASS`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
