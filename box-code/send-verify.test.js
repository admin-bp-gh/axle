"use strict";
// Tests for send-verify.js: run: node --test send-verify.test.js
// Never touches the live database: AXLE_DB is pinned to a throwaway file before db.js loads, and
// Graph is a stub (messageState / sendDraft), so nothing is looked up or sent.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.AXLE_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "axle-send-verify-")), "t.db");
assert.ok(!/[\\/](Axle|axle)[\\/]data[\\/]/.test(process.env.AXLE_DB), "refusing to run against a real Email data dir");
process.env.MAILBOX_INFO = "info@example.test";
process.env.AXLE_ACTION_SEND_VERIFY = "on";
const SV = require("./send-verify.js");
const { db } = require("./db.js");

let n = 0;
// A work item closed by a reply, and its send, sent `ago` minutes ago in verify state `vs`.
function sent(vs, ago = 5) {
  n++;
  const wid = db.prepare("INSERT INTO work_items (mailbox, conversation_key, sender_email, subject, status, resolution) VALUES ('info', ?, 'c@example.test', 'Re: x', 'done', 'replied')")
    .run("k" + n).lastInsertRowid;
  const sid = db.prepare(`INSERT INTO sends (work_item_id, draft_id, to_addr, subject, body_sha256, body, graph_message_id, status, sent_by, sent_at, verify_state)
                          VALUES (?, ?, 'c@example.test', 'Re: x', ?, 'Hello', ?, 'sent', 'u', datetime('now', ?), ?)`)
    .run(wid, 1000 + n, "sha" + n, "msg" + n, `-${ago} minutes`, vs).lastInsertRowid;
  return { wid, sid };
}
const item = (id) => db.prepare("SELECT * FROM work_items WHERE id = ?").get(id);
const send = (id) => db.prepare("SELECT * FROM sends WHERE id = ?").get(id);
const stub = (state) => { const calls = []; return { calls, messageState: async () => state, sendDraft: async (mb, id) => { calls.push([mb, id]); } }; };
const only = (ids) => db.prepare(`UPDATE sends SET verify_state = 'verified' WHERE id NOT IN (${ids.join(",")}) AND verify_state <> 'verified'`).run();

test("decide", () => {
  assert.equal(SV.decide({ sent: true }, "pending", 0), "verified");
  assert.equal(SV.decide({ gone: true }, "stuck", 0), "gone");
  assert.equal(SV.decide({ inDrafts: true }, "pending", 2), null);
  assert.equal(SV.decide({ inDrafts: true }, "pending", 3), "retry");
  assert.equal(SV.decide({ inDrafts: true }, "retried", 3), "stuck");
  assert.equal(SV.decide({ inDrafts: true }, "stuck", 60), null);
});

test("still in Drafts: sent again once, then flagged Not sent and reopened", async () => {
  const { wid, sid } = sent("pending");
  only([sid]);
  const g = stub({ inDrafts: true });
  let r = await SV.verifyBoxes(["info"], { graph: g });
  assert.equal(r.retried, 1);
  assert.deepEqual(g.calls, [["info@example.test", "msg" + n]]);
  assert.equal(send(sid).verify_state, "retried");
  assert.equal(item(wid).status, "done", "not reopened on the first retry");

  db.prepare("UPDATE sends SET verify_at = datetime('now', '-4 minutes') WHERE id = ?").run(sid);
  r = await SV.verifyBoxes(["info"], { graph: g });
  assert.equal(r.stuck, 1);
  assert.equal(g.calls.length, 1, "no second automatic resend");
  assert.equal(item(wid).status, "ready");
  assert.equal(item(wid).send_stuck_id, sid);

  db.prepare("UPDATE sends SET verify_at = datetime('now', '-4 minutes') WHERE id = ?").run(sid);
  r = await SV.verifyBoxes(["info"], { graph: stub({ sent: true }) });
  assert.equal(r.verified, 1, "a stuck send that leaves later is verified");
  assert.equal(item(wid).status, "done");
  assert.equal(item(wid).resolution, "replied");
  assert.equal(item(wid).send_stuck_id, null);
});

test("too recent: not looked at", async () => {
  const { sid } = sent("pending", 1);
  only([sid]);
  const r = await SV.verifyBoxes(["info"], { graph: stub({ inDrafts: true }) });
  assert.equal(r.checked, 0);
});

test("normal send: verified quietly, item untouched", async () => {
  const { wid, sid } = sent("pending");
  only([sid]);
  const r = await SV.verifyBoxes(["info"], { graph: stub({ sent: true }) });
  assert.equal(r.verified, 1);
  assert.equal(send(sid).verify_state, "verified");
  assert.equal(item(wid).status, "done");
});

test("deleted from Drafts unsent: send row dropped, item reopened with the reply restored", async () => {
  const { wid, sid } = sent("retried");
  only([sid]);
  const r = await SV.verifyBoxes(["info"], { graph: stub({ gone: true }) });
  assert.equal(r.gone, 1);
  assert.equal(send(sid), undefined);
  assert.equal(item(wid).status, "ready");
  assert.equal(item(wid).draft_edit, "Hello");
});

test("flagged, then closed by hand, then deleted from Drafts: stays closed", async () => {
  const { wid, sid } = sent("stuck");
  only([sid]);
  db.prepare("UPDATE work_items SET send_stuck_id = ?, status = 'done', resolution = 'done' WHERE id = ?").run(sid, wid);
  await SV.verifyBoxes(["info"], { graph: stub({ gone: true }) });
  assert.equal(item(wid).status, "done");
  assert.equal(item(wid).send_stuck_id, null);
});

test("Try again: sends the same draft and closes the item; a lookup fault leaves it flagged", async () => {
  const { wid, sid } = sent("stuck");
  db.prepare("UPDATE work_items SET send_stuck_id = ?, status = 'ready', resolution = NULL WHERE id = ?").run(sid, wid);
  const bad = { messageState: async () => { throw new Error("HTTP 503"); }, sendDraft: async () => {} };
  await assert.rejects(SV.retryStuck(wid, "u", bad));
  assert.equal(item(wid).send_stuck_id, sid);
  const g = stub({ inDrafts: true });
  assert.equal(await SV.retryStuck(wid, "u", g), "sent");
  assert.equal(g.calls.length, 1);
  assert.equal(item(wid).status, "done");
  assert.equal(item(wid).send_stuck_id, null);
  assert.equal(send(sid).verify_state, "retried", "checked again by the next sync");
});

test("switched off: does nothing", async () => {
  process.env.AXLE_ACTION_SEND_VERIFY = "";
  const r = await SV.verifyBoxes(["info"], { graph: stub({ inDrafts: true }) });
  assert.ok(r.skipped);
  process.env.AXLE_ACTION_SEND_VERIFY = "on";
});
