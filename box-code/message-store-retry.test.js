// message-store-retry.test.js - the retry bound on failed listings and fetches (round 2, phase 2,
// fix D): ingest passes stop after MAX_AUTO_TRIES failures; a person's view still retries, at most
// once per 10 minutes; a success resets the count.
// SAFETY: AXLE_DB is a throwaway file and Graph is a fake (the connectors functions are replaced).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.AXLE_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "axle-retry-")), "test.db");
process.env.MAILBOX_INFO = "info@example.test";
const C = require("./connectors.js");
const { db } = require("./db.js");
const MS = require("./message-store.js");

const fake = { listFails: true, getFails: true, lists: 0, gets: 0 };
C.listAttachments = async (mbx, id) => {
  fake.lists++;
  if (id === "m2" && fake.listFails) throw new Error("Graph 503");
  return C.pickAttachments(id === "m1" ? [{ "@odata.type": "#microsoft.graph.fileAttachment", id: "a1", name: "photo.jpg", contentType: "image/jpeg", size: 40000, isInline: false }] : []);
};
C.getAttachment = async () => {
  fake.gets++;
  if (fake.getFails) throw new Error("Graph 500");
  return { contentBytes: Buffer.alloc(40000, 1).toString("base64") };
};
C.findMessageByInternetId = async () => null;

const msg = (id) => ({ id, subject: "x", received: "2026-10-07T10:00:00Z", from: { address: "anna@klant.test" }, to: [], cc: [], text: "" });
const itemId = Number(db.prepare("INSERT INTO work_items (mailbox, conversation_key, sender_email, status, origin, latest_message_id) VALUES ('info', 'k', 'anna@klant.test', 'new', 'inbound', 'm1')").run().lastInsertRowid);
const att = () => db.prepare("SELECT * FROM message_attachments WHERE work_item_id = ?").get(itemId);
const m2 = () => db.prepare("SELECT * FROM messages WHERE graph_id = 'm2'").get();
const settle = () => new Promise((r) => setTimeout(r, 50));

test("ingest passes stop after five failures, for fetches and for listings", async () => {
  await MS.storeThread(itemId, "info", "info@example.test", [msg("m1"), msg("m2")]);
  for (let i = 0; i < 7; i++) await MS.retryItem(itemId, "info@example.test");
  assert.strictEqual(att().attempts, MS.MAX_AUTO_TRIES);
  assert.strictEqual(fake.gets, MS.MAX_AUTO_TRIES);
  assert.strictEqual(m2().list_attempts, MS.MAX_AUTO_TRIES);
  assert.strictEqual(att().fetch_state, "error");
});

test("a view retries a row past the bound at most once per 10 minutes", async () => {
  const gets = fake.gets, lists = fake.lists;
  MS.healItem(db.prepare("SELECT * FROM work_items WHERE id = ?").get(itemId));
  await settle();
  assert.strictEqual(fake.gets, gets, "tried moments ago: not yet");
  assert.strictEqual(fake.lists, lists);
  db.prepare("UPDATE message_attachments SET tried_at = datetime('now', '-11 minutes') WHERE work_item_id = ?").run(itemId);
  db.prepare("UPDATE messages SET list_tried_at = datetime('now', '-11 minutes') WHERE work_item_id = ?").run(itemId);
  MS.healItem(db.prepare("SELECT * FROM work_items WHERE id = ?").get(itemId));
  await settle();
  assert.strictEqual(fake.gets, gets + 1);
  assert.strictEqual(fake.lists, lists + 1);
  MS.healItem(db.prepare("SELECT * FROM work_items WHERE id = ?").get(itemId));
  await settle();
  assert.strictEqual(fake.gets, gets + 1, "and not again straight after");
});

test("a success resets the count, so a later failure starts again at one", async () => {
  fake.getFails = false; fake.listFails = false;
  db.prepare("UPDATE message_attachments SET tried_at = datetime('now', '-11 minutes') WHERE work_item_id = ?").run(itemId);
  db.prepare("UPDATE messages SET list_tried_at = datetime('now', '-11 minutes') WHERE work_item_id = ?").run(itemId);
  await MS.retryItem(itemId, "info@example.test", true);   // a view, its window open: it succeeds
  assert.strictEqual(att().fetch_state, "stored");
  assert.strictEqual(att().attempts, 0);
  assert.strictEqual(m2().list_state, "listed");
  assert.strictEqual(m2().list_attempts, 0);
});

test("the start-up backfill stays due when every item failed, and is done once one works", async () => {
  const { getMeta } = require("./db.js");
  const flag = () => getMeta("messages_backfill_v1");
  C.threadMessages = async () => { throw new Error("Graph down"); };
  MS.startBackfillOnce(0);
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(flag(), null, "every item failed: not marked done");
  C.threadMessages = async () => [msg("m1")];
  MS.startBackfillOnce(0);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(flag(), "one item worked: marked done");
});
