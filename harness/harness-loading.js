// harness-loading.js - harness for the loading-UX round (2026-06-11).
// Runs the REAL db.js/routes/server (step0 stub kit; only network/model stubbed;
// the translate stub's cached() always MISSES so renders take the new async path).
//   A. Indicators (static, ui.js + components.css):
//      - page() singletons: qcard->workpane htmx loading, form-submit busy
//        (setTimeout(0) so the submitter's name=value still posts), link-nav top
//        bar, pageshow reset
//      - CSS: spinner keyframe, workpane overlay, busy button, top bar, skeleton
//      - ASSET_V bumped; STRINGS parity for the new 'uploading' key
//   B. Async translations (behavioural, real routes):
//      - GET /item/:id renders INSTANTLY with pending markers instead of awaiting
//        the translator (emailtrpre[data-pending], spin, fill-fetch script)
//      - POST /item/:id/translations returns the email + question translations
//      - NL queue renders English summaries with data-trs markers + batch fill
//        script; POST /queue/summaries translates by id (never client text)
//      - lazy queue skeleton on deep links; investigating banner is class busy
// Run: AXLE_MIRROR=<box-code> AXLE_STEP0=<harness/step0> node harness-loading.js
"use strict";
const path = require("path");
const fs = require("fs");

const MIRROR = process.env.AXLE_MIRROR || "/sessions/dreamy-kind-knuth/mnt/Axle/box-code";
const STEP0 = process.env.AXLE_STEP0 || "/sessions/dreamy-kind-knuth/mnt/Axle/harness/step0";
process.env.AXLE_MIRROR = MIRROR;
process.env.AXLE_DB = path.join(require("os").tmpdir(), "axle-loading-" + process.pid + "-" + Date.now() + ".db");
process.env.MAILBOX_INFO = "info@budget-parts.nl";
process.env.MAILBOX_DRACHTEN = "drachten@budget-parts.nl";
process.env.ANTHROPIC_API_KEY = "harness-stub-key";

let n = 0, fails = 0;
const ok = (cond, name, detail) => {
  n++;
  if (!cond) { fails++; console.log(`FAIL ${n}: ${name}${detail ? " - " + detail : ""}`); }
  else console.log(`ok ${n}: ${name}`);
};

// ---- A. static asserts: the loading-state system ------------------------------------
const uiSrc = fs.readFileSync(path.join(MIRROR, "views", "ui.js"), "utf8");
ok(/htmx:beforeRequest/.test(uiSrc) && /closest\("a\.qcard"\)/.test(uiSrc) && /ax-loading/.test(uiSrc),
  "page(): qcard click -> ax-loading singleton");
ok(/addEventListener\("submit"/.test(uiSrc) && /setTimeout\(function \(\) \{\s*\n\s*if \(e\.defaultPrevented\) return;/.test(uiSrc),
  "page(): submit busy AFTER serialisation (setTimeout + defaultPrevented guard)");
ok(/ax-busy/.test(uiSrc) && /ax-nav/.test(uiSrc), "page(): busy button + top progress bar classes");
ok(/addEventListener\("pageshow"/.test(uiSrc), "page(): pageshow clears stale spinners (bfcache)");
ok(!/ASSET_V = "s2c"/.test(uiSrc), "ASSET_V bumped past s2c");
const css = fs.readFileSync(path.join(MIRROR, "assets", "components.css"), "utf8");
ok(/@keyframes ax-spin/.test(css) && /\.spin \{/.test(css), "css: spinner");
ok(/#workpane\.ax-loading::before/.test(css) && /\.workpanes \{ position: relative/.test(css), "css: workpane overlay spinner");
ok(/\.qcard\.ax-loading \.q-time::after/.test(css), "css: clicked-card spinner");
ok(/body\.ax-nav::before/.test(css), "css: top progress bar");
ok(/button\.ax-busy::after/.test(css), "css: busy submit button");
ok(/\.qskel span \{/.test(css) && /@keyframes ax-shimmer/.test(css), "css: queue skeleton shimmer");
ok(/\.banner\.busy::before/.test(css), "css: investigating banner spinner");

require(path.join(STEP0, "stubs.js"));
const UI = require(path.join(MIRROR, "views", "ui.js"));
ok(UI.STRINGS.en.uploading && UI.STRINGS.nl.uploading, "i18n: 'uploading' present in EN and NL");
ok(Object.keys(UI.STRINGS.en).length === Object.keys(UI.STRINGS.nl).length, "i18n: EN/NL key parity",
  `${Object.keys(UI.STRINGS.en).length} vs ${Object.keys(UI.STRINGS.nl).length}`);

const { db } = require(path.join(MIRROR, "db.js"));

// seed: user + a German item with an open question + a busy item
db.prepare("INSERT INTO users (tailscale_login, display_name, role, owner_label) VALUES (?,?,?,?)")
  .run("admin@budget-parts.nl", "Brad", "admin", null);
const WI = `INSERT INTO work_items (id, mailbox, conversation_key, sender_email, sender_name, subject,
  language, intent, priority, status, injection_flag, summary, email_text, email_received,
  created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
const T = "2026-06-11 10:00:00";
db.prepare(WI).run(3, "info", "c3", "kunde@firma.de", "Knut", "Bestellung", "de", "order_status", 2,
  "awaiting_input", 0, "German customer asks for an ETA", "Hallo Welt\nViele Gruesse", T, T, T);
db.prepare(WI).run(4, "info", "c4", "x@y.nl", "X", "Busy", "en", "other", 2, "investigating", 0, "s", "Hi", T, T, T);
db.prepare("INSERT INTO questions (work_item_id, kind, question) VALUES (?,?,?)")
  .run(3, "blocking", "Is the turret still on the shelf?");
db.prepare("UPDATE work_items SET caller_info = 'called 10:12' WHERE id = 3").run();

// boot the real server on an ephemeral port
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
  const call = async (p, opts) => {
    const headers = { "Tailscale-User-Login": "admin@budget-parts.nl", ...(opts && opts.headers) };
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method: (opts && opts.method) || "GET", headers, body: opts && opts.body });
    const text = await r.text();
    return { status: r.status, text, json: () => JSON.parse(text) };
  };
  db.prepare("UPDATE sync_state SET running = 0, finished_at = datetime('now') WHERE id = 1").run();

  // ---- B1. item view renders instantly with pending markers (EN viewer, DE email) ----
  let r = await call("/item/3");
  ok(r.status === 200, "GET /item/3 200");
  ok(/id="emailtrpre" data-pending="1"/.test(r.text), "item: email translation PENDING marker (not awaited)");
  ok(/<span class="spin"><\/span>/.test(r.text), "item: pending panel shows a spinner");
  ok(r.text.includes("Show translation"), "item: translation toggle still offered");
  ok(r.text.includes(`fetch("/item/3/translations"`), "item: background fill script wired");
  ok(r.text.includes("qskel"), "item deep link: lazy queue shows skeleton rows");
  ok(!/data-trq="\d/.test(r.text), "item EN viewer: questions stay English (no fill markers)");

  // ---- B2. NL viewer: question fill markers ----
  r = await call("/item/3", { headers: { Cookie: "axle_lang=nl" } });
  ok(/data-trq="\d+"/.test(r.text), "item NL viewer: question marked for background fill");

  // ---- B3. the translations endpoint (text comes from the DB, never the client) ----
  r = await call("/item/3/translations", { method: "POST" });
  let d = r.json();
  ok(d.email && d.email.startsWith("«" + "en" + "»"), "POST translations: email translated to viewer lang", d.email);
  ok(Object.keys(d.questions).length === 0, "POST translations EN: no question translations");
  r = await call("/item/3/translations", { method: "POST", headers: { Cookie: "axle_lang=nl" } });
  d = r.json();
  ok(d.email && d.email.startsWith("«nl»"), "POST translations NL: email -> nl");
  const qv = Object.values(d.questions);
  ok(qv.length === 1 && qv[0].startsWith("«nl»"), "POST translations NL: question -> nl");
  r = await call("/item/999/translations", { method: "POST" });
  ok(r.status === 404, "POST translations: unknown item 404");

  // ---- B4. queue: NL summaries render English + marker, batch endpoint fills ----
  r = await call("/", { headers: { Cookie: "axle_lang=nl" } });
  ok(/data-trs="3"/.test(r.text), "queue NL: uncached summary marked for fill");
  ok(r.text.includes("German customer asks for an ETA"), "queue NL: English summary shown meanwhile");
  ok(r.text.includes('fetch("/queue/summaries"'), "queue NL: batch fill script wired");
  ok(r.text.includes("&#128222;") && r.text.includes("called 10:12"), "queue: caller info intact next to summary span");
  r = await call("/");
  ok(!/data-trs=/.test(r.text), "queue EN viewer: no fill markers");
  r = await call("/queue/summaries", { method: "POST", headers: { Cookie: "axle_lang=nl", "Content-Type": "application/x-www-form-urlencoded" }, body: "ids=3,4,999,abc,3" });
  d = r.json();
  ok(d["3"] && d["3"].startsWith("«nl»"), "POST /queue/summaries: translates by id");
  ok(!d["999"] && !d["abc"], "POST /queue/summaries: junk ids skipped");
  r = await call("/queue/summaries", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "ids=3" });
  ok(Object.keys(r.json()).length === 0, "POST /queue/summaries EN viewer: empty (nothing to do)");

  // ---- B5. busy banner + upload busy string ----
  // (server startup heals 'investigating' items, so re-set it after boot)
  db.prepare("UPDATE work_items SET status = 'investigating' WHERE id = 4").run();
  r = await call("/item/4");
  ok(r.text.includes('class="banner busy"'), "investigating banner carries the spinner class");
  r = await call("/item/3");
  ok(r.text.includes("attbusy") && r.text.includes("Uploading"), "attachment upload busy state wired");

  console.log(fails ? `\n${fails}/${n} FAILED` : `\nALL ${n} PASS`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
