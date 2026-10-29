"use strict";
// prose-send.test.js - AI parity Step B on the item page and the send route (AXLE_OUTPUT=prose): the gate
// flags as a strip above the reply, Send live with a quiet amber warning while a blocking question is open
// (never a hold since 19 Oct 2026), and the route sending with the edited reply and recording open_blocking
// on the audit row. Throwaway database; Graph is stubbed, nothing leaves the machine.
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
const SEND = require("./send.js");                 // stubbed: no Graph call ever leaves this test
const sent = [];
SEND.sendReply = async (o) => { sent.push(o); return { messageId: "m-test", threaded: true }; };
SEND.markRead = async () => ({ ok: false, reason: "test" });

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
const req = (method, p, login, body, extra) => new Promise((resolve, reject) => {
  const data = body ? new URLSearchParams(body).toString() : "";
  const r = http.request({ host: "127.0.0.1", port, path: p, method, headers: { "Tailscale-User-Login": login, "X-Axle-Inline": "1", "HX-Request": "true", ...extra,
    ...(body ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(data) } : {}) } }, (res) => {
    let b = ""; res.on("data", (c) => { b += c; }); res.on("end", () => resolve({ status: res.statusCode, body: b }));
  });
  r.on("error", reject);
  if (data) r.write(data);
  r.end();
});
const sendTag = (html) => /<button type="submit" class="wb-btn wb-btn--commit" formaction="[^"]*\/send"[^>]*data-send[^>]*>/.exec(html)[0];

test("item page: the flag strip quotes the fragment; Send is live with the open-question warning; no Send anyway", async () => {
  for (const login of ["jack@bp", "brad@bp"]) {
    const { body } = await req("GET", `/item/${held}`, login);
    assert.match(body, /Check before sending: the Email assistant flagged part of this reply\./);
    assert.match(body, /<mark data-ax-flag="fits your VIN">fits your VIN<\/mark>/);
    assert.match(body, /Recommends a part whose fitment is not confirmed\./);
    assert.doesNotMatch(sendTag(body), / disabled/, login);
    assert.match(body, /class="wb-hint ax-openq">Open question for the customer not yet answered</);
    assert.doesNotMatch(body, /ax-override|override_reason|Send anyway/);
  }
});

test("item page: the warning in the Dutch UI", async () => {
  const { body } = await req("GET", `/item/${held}`, "jack@bp", null, { Cookie: "axle_lang=nl" });
  assert.match(body, /class="wb-hint ax-openq">Openstaande vraag aan de klant nog niet beantwoord</);
});

test("item page: no open blocking question, Send is live and no strip", async () => {
  const { body } = await req("GET", `/item/${answered}`, "jack@bp");
  assert.doesNotMatch(sendTag(body), / disabled/);
  assert.doesNotMatch(body, /ax-openq|Check before sending/);
});

test("item page: a JSON-drafted item keeps today's Send even with a blocking question open", async () => {
  const { body } = await req("GET", `/item/${jsonDrafted}`, "jack@bp");
  assert.doesNotMatch(sendTag(body), / disabled/);
  assert.doesNotMatch(body, /ax-openq/);
});

test("item page: notes on a ready item show as Notes from the Email assistant and never hold Send", async () => {
  const { body } = await req("GET", `/item/${withNotes}`, "jack@bp");
  assert.match(body, /Notes from the Email assistant<\/b><ul class="ax-gflags"><li><span[^>]*>Create the credit note on receipt</);
  assert.doesNotMatch(sendTag(body), / disabled/);
});

test("send route: sends the edited reply while a blocking question is open and records open_blocking", async () => {
  const r = await req("POST", `/item/${held}/send`, "jack@bp", { reply: "Dear Carlos,\n\nMy own edited reply.\n\nKind regards,\nJack" });
  assert.strictEqual(r.status, 302, r.body);
  assert.strictEqual(sent.length, 1);
  assert.match(sent[0].html, /My own edited reply\./);
  const s = db.prepare("SELECT status, body FROM sends WHERE work_item_id = ?").get(held);
  assert.strictEqual(s.status, "sent");
  assert.match(s.body, /My own edited reply\./);
  const row = db.prepare("SELECT detail FROM audit_log WHERE action = 'email_sent' AND work_item_id = ?").get(held);
  assert.match(row.detail, / open_blocking=1 /);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('send_blocked_questions', 'send_override_blocking')").get().n, 0);
});

test("send route: no open_blocking on a send without open blocking questions", async () => {
  const r = await req("POST", `/item/${answered}/send`, "jack@bp", { reply: "Dear Carlos,\n\nIt is on the shelf.\n\nKind regards,\nJack" });
  assert.strictEqual(r.status, 302, r.body);
  const row = db.prepare("SELECT detail FROM audit_log WHERE action = 'email_sent' AND work_item_id = ?").get(answered);
  assert.doesNotMatch(row.detail, /open_blocking/);
});

test("send route: the other guards still refuse, and the typed reply is kept for the retry", async () => {
  const before = sent.length;
  const r = await req("POST", `/item/${jsonDrafted}/send`, "jack@bp", { reply: "Dear Carlos,\n\nSee https://evil.example/x for the part.\n\nKind regards,\nJack" });
  assert.strictEqual(r.status, 400, r.body);
  assert.strictEqual(JSON.parse(r.body).kind, "refused");
  assert.strictEqual(sent.length, before);
  assert.match(db.prepare("SELECT draft_edit FROM work_items WHERE id = ?").get(jsonDrafted).draft_edit, /evil\.example/);
});
