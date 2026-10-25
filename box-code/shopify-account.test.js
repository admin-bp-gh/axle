// shopify-account.test.js - the Shopify account card's rules (2026-10-25): which action a state
// allows, the 10-minute cooldown, the audit row on every attempt, userErrors passed on verbatim.
// Shopify is faked. Run: node shopify-account.test.js
process.env.AXLE_DB = ":memory:";
const assert = require("assert");
const SA = require("./shopify-account.js");
const { db } = require("./db.js");

let pass = 0;
const test = (name, fn) => Promise.resolve().then(fn).then(() => { pass++; console.log("  ok  " + name); });

const cust = (state, extra = {}) => ({ id: "gid://shopify/Customer/1", displayName: "Jan Jansen", email: "jan@example.com", state, tags: ["b2b"], companyContactProfiles: [], lastOrder: { name: "#S20001", createdAt: "2026-10-01T10:00:00Z" }, ...extra });
let clock = Date.now();   // the fake clock starts at the real one: the rows carry SQLite datetime('now')
function deps(rows, admin = {}, recoverErrs = []) {
  const calls = [];
  return { calls, d: {
    lookup: async () => rows,
    admin: async (q, v) => { if (/^\{ shop \{/.test(q.trim())) return { shop: { name: "Budget Parts", contactEmail: "info@budget-parts.nl" } }; calls.push({ q, v }); return admin; },
    recover: async (email) => { calls.push({ recover: email }); return recoverErrs; },
    now: () => clock,
  } };
}
const rows = () => db.prepare("SELECT * FROM shopify_account_actions ORDER BY id").all();
const base = { email: "jan@example.com", name: "Jan Jansen", workItemId: 7, user: "jack" };

(async () => {
  console.log("shopify-account");

  await test("allowed actions per state", () => {
    assert.deepStrictEqual(SA.allowedActions(null), ["create_and_invite"]);
    assert.deepStrictEqual(SA.allowedActions("DISABLED"), ["send_invite", "activation_url"]);
    assert.deepStrictEqual(SA.allowedActions("INVITED"), ["send_invite", "activation_url"]);
    assert.deepStrictEqual(SA.allowedActions("DECLINED"), ["send_invite", "activation_url"]);
    assert.deepStrictEqual(SA.allowedActions("ENABLED"), ["password_reset"]);
  });

  await test("lookup shapes one, none and several", async () => {
    const one = await SA.lookup("jan@example.com", deps([cust("INVITED")]).d);
    assert.strictEqual(one.found, 1);
    assert.strictEqual(one.customer.lastOrder.name, "#S20001");
    assert.deepStrictEqual(one.actions, ["send_invite", "activation_url"]);
    const none = await SA.lookup("x@example.com", deps([]).d);
    assert.strictEqual(none.found, 0);
    assert.deepStrictEqual(none.actions, ["create_and_invite"]);
    const near = await SA.lookup("jan@example.com", deps([cust("ENABLED", { email: "jan-archive@example.com" })]).d);
    assert.strictEqual(near.found, 0);   // Shopify's search also returns near matches; only the exact address counts
    const two = await SA.lookup("jan@example.com", deps([cust("INVITED"), cust("ENABLED", { id: "gid://shopify/Customer/2" })]).d);
    assert.strictEqual(two.found, 2);
    assert.deepStrictEqual(two.actions, []);
    assert.strictEqual(two.customers.length, 2);
  });

  await test("state gating is enforced server side, with an audit row", async () => {
    const r = await SA.run({ ...base, action: "password_reset" }, deps([cust("INVITED")]).d);
    assert.deepStrictEqual(r, { ok: false, reason: "not_allowed", state: "INVITED" });
    const r2 = await SA.run({ ...base, action: "send_invite" }, deps([cust("ENABLED")]).d);
    assert.strictEqual(r2.reason, "not_allowed");
    const r3 = await SA.run({ ...base, action: "create_and_invite" }, deps([cust("DISABLED")]).d);
    assert.strictEqual(r3.reason, "not_allowed");
    const r4 = await SA.run({ ...base, action: "send_invite" }, deps([]).d);
    assert.strictEqual(r4.reason, "no_customer");
    const r5 = await SA.run({ ...base, action: "send_invite" }, deps([cust("INVITED"), cust("INVITED", { id: "gid://shopify/Customer/2" })]).d);
    assert.strictEqual(r5.reason, "several");
    const all = rows();
    assert.strictEqual(all.length, 5);
    assert.ok(all.every((x) => x.result === "refused" && x.user === "jack" && x.work_item_id === 7));
    assert.strictEqual(all[0].error, "not_allowed");
    db.exec("DELETE FROM shopify_account_actions");
  });

  await test("send invite: mutation called, ok row written", async () => {
    const { d, calls } = deps([cust("DISABLED")], { customerSendAccountInviteEmail: { userErrors: [] } });
    const r = await SA.run({ ...base, action: "send_invite" }, d);
    assert.deepStrictEqual(r, { ok: true, action: "send_invite", customerId: "gid://shopify/Customer/1", url: null });
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].v, { id: "gid://shopify/Customer/1", email: { from: "Budget Parts <info@budget-parts.nl>" } });
    assert.match(calls[0].q, /customerSendAccountInviteEmail/);
    const all = rows();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].result, "ok");
    assert.strictEqual(all[0].shopify_customer_id, "gid://shopify/Customer/1");
  });

  await test("cooldown: the same action on the same customer within 10 minutes is refused", async () => {
    const { d } = deps([cust("DISABLED")], { customerSendAccountInviteEmail: { userErrors: [] } });
    clock += 3 * 60000;
    const r = await SA.run({ ...base, action: "send_invite" }, d);
    assert.strictEqual(r.reason, "cooldown");
    assert.strictEqual(r.minutes, 7);
    const other = await SA.run({ ...base, action: "activation_url" }, deps([cust("DISABLED")], { customerGenerateAccountActivationUrl: { accountActivationUrl: "https://shop/activate/1", userErrors: [] } }).d);
    assert.strictEqual(other.ok, true);
    assert.strictEqual(other.url, "https://shop/activate/1");
    const all = rows();
    assert.strictEqual(all[1].result, "refused");
    assert.match(all[1].error, /^cooldown/);
    assert.strictEqual(all[2].result, "ok");
  });

  await test("cooldown lapses after 10 minutes; the ts arithmetic reads SQLite UTC", async () => {
    db.exec("UPDATE shopify_account_actions SET ts = datetime('now', '-11 minutes') WHERE action = 'send_invite' AND result = 'ok'");
    const { d } = deps([cust("DISABLED")], { customerSendAccountInviteEmail: { userErrors: [] } });
    const now = Date.now();
    const r = await SA.run({ ...base, action: "send_invite" }, { ...d, now: () => now });
    assert.strictEqual(r.ok, true);
    db.exec("DELETE FROM shopify_account_actions");
  });

  await test("create and invite: customerCreate then the invite, name split", async () => {
    let n = 0;
    const d = { lookup: async () => [], recover: async () => [], now: () => clock,
      admin: async (q, v) => { if (/^\{ shop \{/.test(q.trim())) return { shop: { name: "Budget Parts", contactEmail: "info@budget-parts.nl" } }; n++; if (/customerCreate/.test(q)) { assert.deepStrictEqual(v.input, { email: "jan@example.com", firstName: "Jan", lastName: "Jansen" }); return { customerCreate: { customer: { id: "gid://shopify/Customer/9" }, userErrors: [] } }; }
        assert.deepStrictEqual(v, { id: "gid://shopify/Customer/9", email: { from: "Budget Parts <info@budget-parts.nl>" } }); return { customerSendAccountInviteEmail: { userErrors: [] } }; } };
    const r = await SA.run({ ...base, action: "create_and_invite" }, d);
    assert.strictEqual(n, 2);
    assert.deepStrictEqual(r, { ok: true, action: "create_and_invite", customerId: "gid://shopify/Customer/9", url: null });
    assert.strictEqual(rows()[0].shopify_customer_id, "gid://shopify/Customer/9");
    db.exec("DELETE FROM shopify_account_actions");
  });

  await test("userErrors come back verbatim and are recorded as failed", async () => {
    const { d } = deps([cust("INVITED")], { customerSendAccountInviteEmail: { userErrors: [{ field: ["customerId"], message: "Customer already has an account" }] } });
    const r = await SA.run({ ...base, action: "send_invite" }, d);
    assert.strictEqual(r.reason, "user_errors");
    assert.strictEqual(r.message, "Customer already has an account");
    assert.deepStrictEqual(r.userErrors, [{ field: ["customerId"], message: "Customer already has an account" }]);
    assert.strictEqual(rows()[0].result, "failed");
    assert.strictEqual(rows()[0].error, "Customer already has an account");
  });

  await test("password reset: Storefront recover for an ENABLED customer; a transport error is failed", async () => {
    const { d, calls } = deps([cust("ENABLED")]);
    const r = await SA.run({ ...base, action: "password_reset" }, d);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(calls[0], { recover: "jan@example.com" });
    const bad = { ...deps([cust("ENABLED", { id: "gid://shopify/Customer/3" })]).d, recover: async () => { throw new Error("SHOPIFY_STOREFRONT_TOKEN not configured"); } };
    const r2 = await SA.run({ ...base, action: "password_reset" }, bad);
    assert.strictEqual(r2.reason, "failed");
    assert.match(r2.message, /STOREFRONT_TOKEN/);
    const all = rows();
    assert.strictEqual(all[all.length - 1].result, "failed");
  });

  await test("recent lists an item's attempts, newest first", () => {
    const r = SA.recent(7);
    assert.ok(r.length >= 2);
    assert.strictEqual(r[0].action, "password_reset");
    assert.ok(["ok", "failed", "refused"].includes(r[0].result));
  });

  console.log(`${pass} passed`);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
