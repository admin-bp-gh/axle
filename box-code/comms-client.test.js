// comms-client.test.js - customer comms wave 3 (2026-10-25): the Unsubscribe <token> mail rule, the Notify when
// back in stock quick action, the /api/replies guard and query. Workbench is a fake fetch. Run: node comms-client.test.js
process.env.AXLE_DB = ":memory:";
const assert = require("assert");
const CC = require("./comms-client.js");
const { db } = require("./db.js");

let pass = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  ok  " + name); });
const env = { AGENT_TOKEN: "tok-123", AGENT_URL: "http://127.0.0.1:9999/" };
function fake(status, data, calls) {
  return async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); if (status === "down") throw new Error("ECONNREFUSED"); return { status, text: async () => JSON.stringify(data) }; };
}
const lastAudit = () => db.prepare("SELECT action, detail, user, work_item_id FROM audit_log ORDER BY id DESC LIMIT 1").get();
const TOKEN = "q3Xv_9-AbCdEfGhIjKlMnOpQrStUv";
const mail = (subject, from = "Jan@Example.com") => ({ id: "g1", subject, from: { address: from } });

(async () => {
  await test("an accepted Unsubscribe mail is forwarded with the sender, marked read and audited without the token", async () => {
    const calls = [], reads = [];
    const ok = await CC.handleUnsubscribeMail(mail("Unsubscribe " + TOKEN), { mailbox: "info@x", markRead: async (b, id) => { reads.push([b, id]); return { ok: true }; }, o: { env, fetchImpl: fake(200, { ok: true }, calls) } });
    assert.strictEqual(ok, true);
    assert.strictEqual(calls[0].url, "http://127.0.0.1:9999/api/comms/unsubscribe");
    assert.strictEqual(calls[0].init.headers["X-Agent-Token"], "tok-123");
    assert.deepStrictEqual(calls[0].body, { e: "jan@example.com", t: TOKEN });
    assert.deepStrictEqual(reads, [["info@x", "g1"]]);
    const a = lastAudit();
    assert.strictEqual(a.action, "comms_unsubscribe");
    assert.ok(a.detail.startsWith("ok jan@example.com token#") && a.detail.endsWith(", marked read"));
    assert.ok(!a.detail.includes(TOKEN));
  });
  await test("a refused token or an unreachable Workbench leaves the mail for a human", async () => {
    for (const [status, data] of [[400, { ok: false, error: "bad_token" }], ["down", {}]]) {
      const reads = [];
      const ok = await CC.handleUnsubscribeMail(mail("Unsubscribe " + TOKEN), { mailbox: "info@x", markRead: async () => { reads.push(1); return { ok: true }; }, o: { env, fetchImpl: fake(status, data, []) } });
      assert.strictEqual(ok, false);
      assert.strictEqual(reads.length, 0);
      assert.ok(lastAudit().detail.startsWith("left "));
    }
  });
  await test("a subject without a token is not touched and Workbench is not called", async () => {
    const calls = [];
    assert.strictEqual(await CC.handleUnsubscribeMail(mail("Unsubscribe me please"), { o: { env, fetchImpl: fake(200, { ok: true }, calls) } }), false);
    assert.strictEqual(calls.length, 0);
  });
  await test("no AGENT_TOKEN: nothing is called and the mail stays", async () => {
    const calls = [];
    assert.strictEqual(await CC.handleUnsubscribeMail(mail("Unsubscribe " + TOKEN), { o: { env: {}, fetchImpl: fake(200, { ok: true }, calls) } }), false);
    assert.strictEqual(calls.length, 0);
  });

  await test("Notify when back in stock records the interest with source axle and audits it", async () => {
    const calls = [];
    const r = await CC.notifyStock({ sku: " stc1234 ", email: "Jan@Example.com", lang: "nl", workItemId: 7, user: "vera@x" }, { env, fetchImpl: fake(200, { ok: true, id: 41 }, calls) });
    assert.strictEqual(r.result, "recorded");
    assert.strictEqual(calls[0].url, "http://127.0.0.1:9999/api/comms/interest");
    assert.deepStrictEqual(calls[0].body, { sku: "STC1234", email: "jan@example.com", lang: "nl", source: "axle" });
    assert.deepStrictEqual(lastAudit(), { action: "comms_interest", detail: "recorded STC1234 jan@example.com", user: "vera@x", work_item_id: 7 });
  });
  await test("an already recorded interest, an unknown language and a refusal or outage", async () => {
    const calls = [];
    assert.strictEqual((await CC.notifyStock({ sku: "STC1", email: "a@b.nl", lang: "other", user: "u" }, { env, fetchImpl: fake(200, { ok: true, id: 3, already: true }, calls) })).result, "already");
    assert.strictEqual(calls[0].body.lang, "en");
    const bad = await CC.notifyStock({ sku: "NOPE1", email: "a@b.nl", lang: "en", user: "u" }, { env, fetchImpl: fake(400, { ok: false, error: "unknown_sku" }, []) });
    assert.deepStrictEqual(bad, { result: "failed", error: "unknown_sku" });
    assert.strictEqual(lastAudit().detail, "failed NOPE1 a@b.nl unknown_sku");
    assert.strictEqual((await CC.notifyStock({ sku: "STC1", email: "a@b.nl", user: "u" }, { env, fetchImpl: fake("down", {}, []) })).result, "failed");
  });

  await test("the /api/replies guard: loopback, no Serve header, the exact token", () => {
    const req = (ip, headers) => ({ socket: { remoteAddress: ip }, headers });
    assert.strictEqual(CC.guard(req("127.0.0.1", { "x-agent-token": "tok-123" }), env), true);
    assert.strictEqual(CC.guard(req("::ffff:127.0.0.1", { "x-agent-token": "tok-123" }), env), true);
    assert.strictEqual(CC.guard(req("100.64.0.5", { "x-agent-token": "tok-123" }), env), false);
    assert.strictEqual(CC.guard(req("127.0.0.1", { "x-agent-token": "tok-123", "tailscale-user-login": "x@y" }), env), false);
    assert.strictEqual(CC.guard(req("127.0.0.1", { "x-agent-token": "tok-12" }), env), false);
    assert.strictEqual(CC.guard(req("127.0.0.1", {}), {}), false);
  });
  await test("replies: the first inbound message per address after since, case-insensitive", () => {
    const item = db.prepare("INSERT INTO work_items (mailbox, conversation_key, sender_email) VALUES ('info', 'k', 'jan@example.com')").run().lastInsertRowid;
    const add = (g, from, received) => db.prepare("INSERT INTO messages (work_item_id, mailbox, graph_id, from_addr, received) VALUES (?, 'info', ?, ?, ?)").run(item, g, from, received);
    add("m1", "Jan@Example.com", "2026-10-01T09:00:00Z");
    add("m2", "jan@example.com", "2026-10-03T09:00:00Z");
    add("m3", "JAN@example.com", "2026-10-02T09:00:00Z");
    add("m4", "info@budget-parts.nl", "2026-10-02T10:00:00Z");
    add("m5", "piet@example.nl", "2026-09-01T09:00:00Z");
    assert.deepStrictEqual(CC.replies("2026-10-01T12:00:00.000Z", "JAN@example.com, piet@example.nl,nobody@x.nl"),
      [{ email: "jan@example.com", at: "2026-10-02T09:00:00Z" }]);
    assert.strictEqual(CC.replies("not a date", "a@b.nl"), null);
    const many = Array.from({ length: 600 }, (_, i) => `x${i}@example.com`).concat("jan@example.com").join(",");
    assert.strictEqual(CC.replies("2026-10-01T12:00:00Z", many).length, 0, "the list is cut at 500 addresses");
    assert.strictEqual(CC.replies("2026-10-01T12:00:00Z", Array.from({ length: 250 }, (_, i) => `x${i}@example.com`).concat("jan@example.com").join(",")).length, 1, "chunks of 100 still find it");
  });
  console.log(`comms-client: ${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
