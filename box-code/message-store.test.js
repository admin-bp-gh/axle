// message-store.test.js - stored messages and attachments (round 2, request 1): every message's
// attachments are listed whatever Graph's hasAttachments says, files land beside the database named
// by row id, one failing or oversized file never stops the others, failures are retried, a moved
// message is found again, and serving is inline only for png, jpeg, gif, webp and PDF.
// SAFETY: AXLE_DB is a throwaway file and Graph is a fake (the connectors functions are replaced).
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axle-msgstore-"));
process.env.AXLE_DB = path.join(tmp, "test.db");
process.env.MAILBOX_INFO = "info@example.test";
const C = require("./connectors.js");
const { db } = require("./db.js");
const MS = require("./message-store.js");

// --- a fake Graph mailbox -------------------------------------------------------------------------
const PHOTO = Buffer.alloc(40000, 1), PDF = Buffer.from("%PDF-1.4 test"), BIG = 30 * 1024 * 1024;
const graph = {
  // message id -> attachments as Graph lists them (before pickAttachments)
  atts: {
    m1: [
      { "@odata.type": "#microsoft.graph.fileAttachment", id: "a1", name: "front.jpg", contentType: "image/jpeg", size: PHOTO.length, isInline: false },
      { "@odata.type": "#microsoft.graph.fileAttachment", id: "a2", name: "back.jpg", contentType: "image/jpeg", size: PHOTO.length, isInline: false },
      { "@odata.type": "#microsoft.graph.fileAttachment", id: "a3", name: "invoice.pdf", contentType: "application/pdf", size: PDF.length, isInline: false },
      { "@odata.type": "#microsoft.graph.itemAttachment", id: "a4", name: "fwd.msg", contentType: "", size: 900, isInline: false },
    ],
    m2: [
      { "@odata.type": "#microsoft.graph.fileAttachment", id: "b1", name: "photo.jpg", contentType: "image/jpeg", size: PHOTO.length, isInline: true },
      { "@odata.type": "#microsoft.graph.fileAttachment", id: "b2", name: "logo.png", contentType: "image/png", size: 3000, isInline: true },
      { "@odata.type": "#microsoft.graph.fileAttachment", id: "b3", name: "broken.jpg", contentType: "image/jpeg", size: PHOTO.length, isInline: false },
      { "@odata.type": "#microsoft.graph.fileAttachment", id: "b4", name: "huge.zip", contentType: "application/zip", size: BIG, isInline: false },
    ],
    m3: [],
  },
  listFails: new Set(), moved: {}, calls: { get: 0, list: 0 },
};
const bytesOf = (id) => (id === "a3" ? PDF : PHOTO);
C.listAttachments = async (mbx, msgId) => {
  graph.calls.list++;
  if (graph.listFails.has(msgId) || !graph.atts[msgId]) throw new Error("Graph 503: list failed");
  return C.pickAttachments(graph.atts[msgId]);
};
C.getAttachment = async (mbx, msgId, attId) => {
  graph.calls.get++;
  if (!graph.atts[msgId]) throw new Error("Graph 404: message not found");
  if (attId === "b3") throw new Error("Graph 500: fetch failed");
  return { name: attId, contentType: "x", size: 1, contentBytes: bytesOf(attId.replace(/^n/, "")).toString("base64") };
};
C.findMessageByInternetId = async (mbx, imid) => graph.moved[imid] || null;

const msg = (id, received, extra) => ({
  id, internetMessageId: `<${id}@mail.test>`, subject: "Brake discs", received,
  from: { name: "Anna Klant", address: "anna@klant.test" }, to: [{ name: "Info", address: "info@example.test" }],
  cc: [{ name: "Piet", address: "piet@klant.test" }], text: `Body of ${id}`, hasAttachments: false, ...extra,
});
const itemId = Number(db.prepare("INSERT INTO work_items (mailbox, conversation_key, sender_email, subject, status) VALUES ('info', 'anna|brake discs', 'anna@klant.test', 'Brake discs', 'new')").run().lastInsertRowid);
const rows = () => db.prepare("SELECT * FROM message_attachments WHERE work_item_id = ? ORDER BY id").all(itemId);
const byName = (n) => rows().find((r) => r.name === n);

test("serving: inline only for png, jpeg, gif, webp and PDF; everything else downloads", () => {
  for (const [ct, name] of [["image/png", "a.png"], ["image/jpeg", "a.jpg"], ["image/jpg", "a.jpg"], ["image/gif", "a"], ["image/webp", "a"], ["application/pdf", "a.pdf"]]) {
    const p = MS.servePlan(ct, name);
    assert.ok(p.inline, ct);
    assert.ok(p.disposition.startsWith("inline;"), ct);
  }
  for (const [ct, name] of [["image/svg+xml", "x.svg"], ["text/html", "x.html"], ["image/heic", "x.heic"], ["application/zip", "x.zip"], ["", "x.svg"]]) {
    const p = MS.servePlan(ct, name);
    assert.strictEqual(p.inline, false, ct);
    assert.strictEqual(p.contentType, "application/octet-stream", ct);
    assert.ok(p.disposition.startsWith("attachment;"), ct);
  }
  // a declared octet-stream takes the type of an inline-safe extension
  assert.strictEqual(MS.servePlan("application/octet-stream", "IMG_1.JPG").contentType, "image/jpeg");
});

test("serving: the file name cannot break the header", () => {
  const p = MS.servePlan("application/pdf", 'evil"\r\nSet-Cookie: x=1; ../../ä.pdf');
  assert.ok(!/[\r\n]/.test(p.disposition));
  const ascii = /filename="([^"]*)"/.exec(p.disposition)[1];
  assert.ok(/^[\w. ()\[\]-]+$/.test(ascii), ascii);
  assert.ok(p.disposition.includes("filename*=UTF-8''evil%22Set-Cookie"));
  assert.ok(MS.servePlan("image/png", "").disposition.includes('filename="attachment"'));
});

test("a three-message thread: every message listed, files on disk by row id", async () => {
  const thread = [msg("m3", "2026-10-07T10:00:00Z"), msg("m2", "2026-10-06T10:00:00Z"), msg("m1", "2026-10-05T10:00:00Z")];
  const newest = await MS.storeThread(itemId, "info", "info@example.test", thread);
  assert.deepStrictEqual(newest, []);   // m3 has none, and that is a real listing, not a failure
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE work_item_id = ?").get(itemId).n, 3);
  // m1: two photos and a PDF (the item attachment is left out); m2: the inline photo, not the logo
  assert.deepStrictEqual(rows().map((r) => r.name).sort(), ["back.jpg", "broken.jpg", "front.jpg", "huge.zip", "invoice.pdf", "photo.jpg"]);
  for (const n of ["front.jpg", "back.jpg", "invoice.pdf", "photo.jpg"]) {
    const r = byName(n);
    assert.strictEqual(r.fetch_state, "stored", n);
    assert.strictEqual(r.file, String(r.id));
    assert.ok(fs.readFileSync(path.join(tmp, "attachments", String(r.id))).equals(bytesOf(r.graph_att_id)), n);
  }
  assert.strictEqual(byName("broken.jpg").fetch_state, "error");
  assert.match(byName("broken.jpg").fetch_error, /fetch failed/);
  assert.strictEqual(byName("huge.zip").fetch_state, "live");
  assert.ok(!fs.existsSync(path.join(tmp, "attachments", String(byName("huge.zip").id))));
  assert.deepStrictEqual(fs.readdirSync(path.join(tmp, "attachments")).filter((f) => f.endsWith(".tmp")), []);
});

test("the same thread again adds nothing and retries only what failed", async () => {
  const before = rows().length, gets = graph.calls.get;
  await MS.storeThread(itemId, "info", "info@example.test", [msg("m3", "2026-10-07T10:00:00Z"), msg("m2", "2026-10-06T10:00:00Z")]);
  assert.strictEqual(rows().length, before);
  assert.strictEqual(graph.calls.get - gets, 1);   // broken.jpg only
});

test("a failed listing is recorded, not stored as none, and retried", async () => {
  graph.atts.m4 = [{ "@odata.type": "#microsoft.graph.fileAttachment", id: "c1", name: "late.png", contentType: "image/png", size: PHOTO.length, isInline: false }];
  graph.listFails.add("m4");
  const newest = await MS.storeThread(itemId, "info", "info@example.test", [msg("m4", "2026-10-08T10:00:00Z")]);
  assert.strictEqual(newest, null);
  const m4 = db.prepare("SELECT * FROM messages WHERE graph_id = 'm4'").get();
  assert.strictEqual(m4.list_state, "error");
  graph.listFails.delete("m4");
  await MS.retryItem(itemId, "info@example.test");
  assert.strictEqual(db.prepare("SELECT list_state FROM messages WHERE graph_id = 'm4'").get().list_state, "listed");
  assert.strictEqual(byName("late.png").fetch_state, "stored");
});

test("the thread for the screens: oldest first, attachments with their state", () => {
  const t = MS.itemThread(itemId);
  assert.deepStrictEqual(t.map((m) => m.graphId), ["m1", "m2", "m3", "m4"]);
  assert.deepStrictEqual(t[0].cc, [{ name: "Piet", address: "piet@klant.test" }]);
  assert.strictEqual(t[0].from.address, "anna@klant.test");
  assert.strictEqual(t[0].body, "Body of m1");
  const front = t[0].attachments.find((a) => a.name === "front.jpg");
  assert.strictEqual(front.image, true);
  assert.strictEqual(front.url, `/item/${itemId}/file/${front.id}`);
  assert.strictEqual(t[0].attachments.find((a) => a.name === "invoice.pdf").pdf, true);
  const broken = t[1].attachments.find((a) => a.name === "broken.jpg");
  assert.strictEqual(broken.failed, true);
  assert.match(broken.error, /fetch failed/);
});

test("serving loads from disk, fetches again when the file has gone, and checks the item", async () => {
  const r = byName("front.jpg");
  const gets = graph.calls.get;
  const a = await MS.loadAttachment(itemId, r.id);
  assert.strictEqual(a.path, path.join(tmp, "attachments", String(r.id)));
  assert.strictEqual(graph.calls.get, gets);
  fs.unlinkSync(a.path);
  const b = await MS.loadAttachment(itemId, r.id);
  assert.ok(fs.existsSync(b.path));
  assert.strictEqual(graph.calls.get, gets + 1);
  assert.strictEqual(await MS.loadAttachment(itemId + 1, r.id), null);
  const big = await MS.loadAttachment(itemId, byName("huge.zip").id);
  assert.ok(Buffer.isBuffer(big.buffer) && !big.path);
  await assert.rejects(MS.loadAttachment(itemId, byName("broken.jpg").id), /fetch failed/);
});

test("a moved message is found again by its internet message id", async () => {
  const r = byName("back.jpg");
  fs.unlinkSync(path.join(tmp, "attachments", String(r.id)));
  graph.atts.n1 = graph.atts.m1.map((a) => ({ ...a, id: "n" + a.id }));   // a move mints new ids
  delete graph.atts.m1;
  graph.moved["<m1@mail.test>"] = "n1";
  const f = await MS.loadAttachment(itemId, r.id);
  assert.ok(fs.readFileSync(f.path).equals(PHOTO));
  assert.strictEqual(db.prepare("SELECT graph_id FROM messages WHERE id = ?").get(r.message_id).graph_id, "n1");
  assert.strictEqual(byName("back.jpg").graph_att_id, "na2");
});

test("pruning drops the files of emails closed over 90 days ago and keeps the rows", async () => {
  const other = Number(db.prepare("INSERT INTO work_items (mailbox, conversation_key, sender_email, status) VALUES ('info', 'k2', 'x@y.test', 'new')").run().lastInsertRowid);
  graph.atts.m9 = [{ "@odata.type": "#microsoft.graph.fileAttachment", id: "a1", name: "recent.jpg", contentType: "image/jpeg", size: PHOTO.length, isInline: false }];
  await MS.storeThread(other, "info", "info@example.test", [msg("m9", "2026-10-07T10:00:00Z")]);
  db.prepare("UPDATE work_items SET status = 'done', updated_at = datetime('now', '-91 days') WHERE id = ?").run(itemId);
  db.prepare("UPDATE work_items SET status = 'done', updated_at = datetime('now', '-89 days') WHERE id = ?").run(other);
  const held = rows().filter((r) => r.fetch_state === "stored");
  assert.strictEqual(MS.pruneClosed(), held.length);
  for (const r of held) assert.ok(!fs.existsSync(path.join(tmp, "attachments", String(r.id))));
  assert.ok(rows().every((r) => r.fetch_state !== "stored"));
  assert.strictEqual(db.prepare("SELECT fetch_state FROM message_attachments WHERE work_item_id = ?").get(other).fetch_state, "stored");
});
