"use strict";
// round-2026-10-15.test.js - the Open list order and the list that follows an opened email
// (15 Oct 2026), through the real queue route on a throwaway database.
// Run: node --test round-2026-10-15.test.js
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axle-1015-"));
process.env.AXLE_DB = path.join(dir, "axle.db");   // never the live database
const { db } = require("./db.js");

db.prepare("INSERT INTO users (tailscale_login, display_name, role, owner_label) VALUES (?, ?, ?, ?)").run("jack@bp", "Jack", "sales", "Sales(Gouda)");
db.prepare("INSERT INTO users (tailscale_login, display_name, role, owner_label) VALUES (?, ?, ?, ?)").run("brad@bp", "Brad", "admin", "Brad");
const add = (o) => db.prepare(`INSERT INTO work_items (mailbox, conversation_key, sender_email, subject, status, owner, priority, injection_flag, email_received, created_at, updated_at, origin)
  VALUES (@mailbox, @key, @from, @subject, @status, @owner, @priority, @inj, @received, @created, @updated, @origin)`).run({
  mailbox: "info", key: "k" + Math.random(), from: "c@x.nl", status: "ready", owner: "Sales(Gouda)", priority: 2, inj: 0,
  received: null, created: "2026-10-15 08:00:00", updated: "2026-10-15 08:00:00", origin: "inbound", ...o }).lastInsertRowid;

// Newest customer message per item, deliberately against every old sort key.
const ids = {
  p1new: add({ subject: "P1 newest", priority: 1, status: "awaiting_input", received: "2026-10-15T12:00:00Z", updated: "2026-10-15 07:00:00" }),
  flagged: add({ subject: "flagged", inj: 1, received: "2026-10-15T11:00:00Z" }),
  oldest: add({ subject: "oldest", priority: 3, status: "new", received: "2026-10-12T09:00:00Z", updated: "2026-10-15 16:00:00" }),
  compose: add({ subject: "compose", origin: "compose", received: null, created: "2026-10-13 10:00:00" }),
  tieA: add({ subject: "tie A", received: "2026-10-14T10:00:00Z" }),
  tieB: add({ subject: "tie B", received: "2026-10-14T10:00:00.000Z" }),
  sameDay: add({ subject: "same day, earlier hour", received: "2026-10-14T09:59:59Z" }),
  closed: add({ subject: "closed", status: "done", updated: "2026-10-10 10:00:00" }),
  drachten: add({ subject: "drachten", mailbox: "drachten", owner: "Drachten", received: "2026-10-11T10:00:00Z" }),
};

const root = require("./server.js");   // after the rows, so its start-up fills the search index
let port, srv;
test.before(() => new Promise((r) => { srv = root.listen(0, "127.0.0.1", () => { port = srv.address().port; r(); }); }));
test.after(() => srv.close());
const get = (p, login = "jack@bp") => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path: p, headers: { "Tailscale-User-Login": login } }, (res) => {
    let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve(b));
  }).on("error", reject);
});
const rowIds = (html) => [...html.matchAll(/class="wb-row"[^>]*data-id="(\d+)"/g)].map((m) => +m[1]);
const qsOf = (html) => /data-qs="([^"]*)"/.exec(html)[1].replace(/&amp;/g, "&");

test("Open list: oldest customer message first, nothing pinned, ties by id", async () => {
  const order = rowIds(await get("/queue?show=open&scope=all&mailbox=info"));
  assert.deepStrictEqual(order, [ids.oldest, ids.compose, ids.sameDay, ids.tieA, ids.tieB, ids.flagged, ids.p1new]);
});

test("Open list rows show when the customer's newest message came in", async () => {
  const html = await get("/queue?show=open&scope=all&mailbox=info");
  const meta = (id) => new RegExp(`data-id="${id}"[^>]*>\\s*<span class="wb-row__title">[^<]*</span><span class="wb-row__meta">([^<]*)<`).exec(html)[1];
  assert.match(meta(ids.oldest), /Monday|12 Oct/, "received (Mon 12 Oct), not the later update (15 Oct)");
});

test("History stays newest first", async () => {
  const order = rowIds(await get("/queue?show=history&scope=all&mailbox=all"));
  assert.deepStrictEqual(order, [ids.closed]);
});

test("follow: a closed email opened from outside the Open list brings History", async () => {
  const html = await get(`/queue?show=open&scope=mine&sel=${ids.closed}&follow=${ids.closed}`);
  assert.ok(rowIds(html).includes(ids.closed));
  assert.match(qsOf(html), /show=history/);
  assert.match(html, new RegExp(`data-followed="${ids.closed}"`));
});

test("follow: another owner's email widens Mine to All; another mailbox widens to all mailboxes", async () => {
  let html = await get(`/queue?show=open&scope=mine&follow=${ids.drachten}`);
  assert.ok(rowIds(html).includes(ids.drachten));
  assert.match(qsOf(html), /scope=all/);
  html = await get(`/queue?follow=${ids.drachten}`, "brad@bp");   // an owner lands on info@
  assert.ok(rowIds(html).includes(ids.drachten));
  assert.match(qsOf(html), /mailbox=all/);
});

test("follow: an email already in the list leaves the filter as it is, the search included", async () => {
  const html = await get(`/queue?show=open&scope=all&mailbox=info&q=oldest&follow=${ids.oldest}`);
  assert.deepStrictEqual(rowIds(html), [ids.oldest]);
  assert.match(qsOf(html), /^mailbox=info&scope=all&show=open&q=oldest$/);
});

test("follow: a search that leaves the email out is dropped", async () => {
  const html = await get(`/queue?show=open&scope=all&mailbox=info&q=flagged&follow=${ids.oldest}`);
  assert.ok(rowIds(html).includes(ids.oldest));
  assert.doesNotMatch(qsOf(html), /q=/);
});

test("follow: a closed email past the first History page is shown by its #id", async () => {
  for (let i = 0; i < 55; i++) add({ subject: "h" + i, status: "done", updated: `2026-10-14 ${String(10 + (i % 10)).padStart(2, "0")}:00:00` });
  const html = await get(`/queue?show=history&scope=all&mailbox=all&follow=${ids.closed}`);
  assert.deepStrictEqual(rowIds(html), [ids.closed]);
  assert.match(qsOf(html), new RegExp(`q=%23${ids.closed}$`));
});

test("follow: an unknown id changes nothing", async () => {
  const html = await get("/queue?show=open&scope=all&mailbox=info&follow=999999");
  assert.match(qsOf(html), /^mailbox=info&scope=all&show=open$/);
});

test("a deep link loads the list that holds the email", async () => {
  const html = await get(`/item/${ids.closed}`);
  assert.match(html, new RegExp(`hx-get="/queue\\?sel=${ids.closed}&amp;follow=${ids.closed}"`));
});
