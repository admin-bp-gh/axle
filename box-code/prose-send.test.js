"use strict";
// prose-send.test.js - AI parity Step B on the item page and the send route (AXLE_OUTPUT=prose): the gate
// flags as a strip above the reply, Send held with "Answer first" while a blocking question is open, Send
// anyway for owners only, and the route refusing a send without an owner's reason. Throwaway database;
// nothing reaches the send itself (every request here is refused before the reply is assembled).
// Run: node --test prose-send.test.js
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axle-prose-"));
process.env.AXLE_DB = path.join(dir, "axle.db");   // never the live database
process.env.AXLE_OUTPUT = "prose";                 // before server.js loads the env file, which never overrides
const { db } = require("./db.js");

db.prepare("INSERT INTO users (tailscale_login, display_name, role, owner_label) VALUES (?, ?, ?, ?)").run("jack@bp", "Jack", "sales", "Sales(Gouda)");
db.prepare("INSERT INTO users (tailscale_login, display_name, role, owner_label) VALUES (?, ?, ?, ?)").run("brad@bp", "Brad", "admin", "Brad");
const FLAGS = JSON.stringify([{ gate: "vin_claim", fragment: "fits your VIN", reason: "x" }, { gate: "fitment", fragment: "", reason: "y" }]);
const item = (o) => {
  const id = db.prepare(`INSERT INTO work_items (mailbox, conversation_key, sender_email, subject, status, owner, priority, injection_flag, email_received, origin, draft_flags, draft_output, email_text, language)
    VALUES ('info', @key, 'carlos@example.com', 'Flywheel', 'awaiting_input', 'Sales(Gouda)', 2, 0, '2026-10-16T09:00:00Z', 'inbound', @flags, @output, 'Flywheel please', 'en')`)
    .run({ key: "k" + Math.random(), flags: FLAGS, output: "prose", ...o }).lastInsertRowid;
  db.prepare("INSERT INTO drafts (work_item_id, version, is_interim, body) VALUES (?, 1, 1, ?)").run(id, "Dear Carlos,\n\nThe ERR5205 fits your VIN.\n\nKind regards,\nTeam Budget Parts");
  return id;
};
const held = item({});
db.prepare("INSERT INTO questions (work_item_id, kind, question) VALUES (?, 'blocking', 'Quote price and lead time for STC50512?')").run(held);
const answered = item({ flags: null });
db.prepare("INSERT INTO questions (work_item_id, kind, question) VALUES (?, 'physical', 'Check the shelf')").run(answered);
const withNotes = item({ flags: null });
db.prepare("UPDATE work_items SET status = 'ready' WHERE id = ?").run(withNotes);
db.prepare("INSERT INTO questions (work_item_id, kind, question) VALUES (?, 'optional', 'Create the credit note on receipt')").run(withNotes);
const jsonDrafted = item({ flags: null, output: null });   // drafted before the flip, or by compose: today's Send
db.prepare("INSERT INTO questions (work_item_id, kind, question) VALUES (?, 'blocking', 'Which engine?')").run(jsonDrafted);

const root = require("./server.js");
let port, srv;
test.before(() => new Promise((r) => { srv = root.listen(0, "127.0.0.1", () => { port = srv.address().port; r(); }); }));
test.after(() => srv.close());
const req = (method, p, login, body) => new Promise((resolve, reject) => {
  const data = body ? new URLSearchParams(body).toString() : "";
  const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: { "Tailscale-User-Login": login, "X-Axle-Inline": "1", "HX-Request": "true",
    ...(body ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(data) } : {}) } }, (res) => {
    let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, body: b }));
  });
  r.on("error", reject);
  if (data) r.write(data);
  r.end();
});
const sendTag = (html) => /<button type="submit" class="wb-btn wb-btn--commit" formaction="[^"]*\/send"[^>]*data-send[^>]*>/.exec(html)[0];

test("item page: the flag strip quotes the fragment; Send held with Answer first; no Send anyway for sales", async () => {
  const { body } = await req("GET", `/item/${held}`, "jack@bp");
  assert.match(body, /Check before sending: Axle flagged part of this reply\./);
  assert.match(body, /<mark data-ax-flag="fits your VIN">fits your VIN<\/mark>/);
  assert.match(body, /Recommends a part whose fitment is not confirmed\./);
  assert.match(sendTag(body), / disabled/);
  assert.match(body, /class="wb-hint ax-answerfirst">Answer first</);
  assert.doesNotMatch(body, /data-overlay="ax-override"/);
});

test("item page: an owner gets Send anyway with a reason field on the work form", async () => {
  const { body } = await req("GET", `/item/${held}`, "brad@bp");
  assert.match(body, /data-overlay="ax-override"/);
  assert.match(body, /<textarea id="ax-ovr" name="override_reason" form="workform"/);
});

test("item page: no open blocking question, Send is live and no strip", async () => {
  const { body } = await req("GET", `/item/${answered}`, "jack@bp");
  assert.doesNotMatch(sendTag(body), / disabled/);
  assert.doesNotMatch(body, /ax-answerfirst|Check before sending/);
});

test("item page: a JSON-drafted item keeps today's Send even with a blocking question open", async () => {
  const { body } = await req("GET", `/item/${jsonDrafted}`, "jack@bp");
  assert.doesNotMatch(sendTag(body), / disabled/);
  assert.doesNotMatch(body, /ax-answerfirst/);
});

test("item page: notes on a ready item show as Notes from Axle and never hold Send", async () => {
  const { body } = await req("GET", `/item/${withNotes}`, "jack@bp");
  assert.match(body, /Notes from Axle<\/b><ul class="ax-gflags"><li><span[^>]*>Create the credit note on receipt</);
  assert.doesNotMatch(sendTag(body), / disabled/);
});

test("send route: refused while a blocking question is open, for sales and for an owner without a reason", async () => {
  for (const [login, body] of [["jack@bp", { reply: "x", override_reason: "please" }], ["brad@bp", { reply: "x" }], ["brad@bp", { reply: "x", override_reason: "   " }]]) {
    const r = await req("POST", `/item/${held}/send`, login, body);
    assert.strictEqual(r.status, 409, login);
    assert.match(JSON.parse(r.body).message, /open questions/);
  }
  const rows = db.prepare("SELECT user FROM audit_log WHERE action = 'send_blocked_questions' AND work_item_id = ?").all(held);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM sends WHERE work_item_id = ?").get(held).n, 0);
});
