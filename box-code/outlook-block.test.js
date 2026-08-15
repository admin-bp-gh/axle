"use strict";
// Tests for outlook-block.js — the Outlook side of "Block sender". Run: node --test outlook-block.test.js
//
// What is actually being protected here, in priority order:
//
//   1. THE EMPTY-CONDITIONS TRAP. An Exchange rule with no conditions matches EVERY message in the
//      mailbox, so an empty blocklist must DELETE the rule and never write one with an empty
//      condition array. That single slip would file an entire shared inbox into a folder — the same
//      shape of failure as the 2026-07-27 domain-block incident, one order of magnitude worse.
//   2. NEVER OUR OWN DOMAINS. Blocking @budget-parts.nl would file our own internal mail, including
//      the cross-mailbox handover forwards action #6 sends.
//   3. ADDRESSES AND DOMAINS STAY IN SEPARATE RULES. Conditions inside one Exchange rule are ANDed,
//      so a combined rule would match nothing and the block would silently do nothing at all.
//   4. The gate is real: with AXLE_ACTION_OUTLOOK_BLOCK unset, not one write leaves the box.
//   5. Reconciliation is idempotent — an already-correct rule is not rewritten on every sync.
//
// SAFETY: never touches the live database or the real Microsoft Graph. AXLE_DB is pinned to a
// throwaway file before db.js is required, and global.fetch is replaced by an in-memory fake
// mailbox that records every call, so an accidental real write is impossible.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axle-oblock-"));
process.env.AXLE_DB = path.join(tmpDir, "test.db");
assert.ok(!/[\\/](Axle|axle)[\\/]data[\\/]/.test(process.env.AXLE_DB), "refusing to run against a real Axle data dir");
process.env.MAILBOX_INFO = "info@budget-parts.nl";
process.env.MAILBOX_DRACHTEN = "drachten@budget-parts.nl";
process.env.M365_TENANT_ID = "t"; process.env.M365_CLIENT_ID = "c"; process.env.M365_CLIENT_SECRET = "s";
process.env.AXLE_ACTION_OUTLOOK_BLOCK = "on";

const { db } = require("./db.js");
const OB = require("./outlook-block.js");

// ---- fake Graph ---------------------------------------------------------------------------
// One in-memory mailbox per address: its folders, its inbox rules, its messages. Every call is
// recorded so a test can assert on what was NOT sent as easily as on what was.
function makeGraph(seed = {}) {
  const state = {
    folders: seed.folders || [{ id: "inbox-id", displayName: "Inbox", totalItemCount: 10 }],
    rules: seed.rules || [],
    messages: seed.messages || [],   // {id, from, folderId}
    nextId: 1,
  };
  const calls = [];
  const json = (status, body) => ({ status, json: async () => body });
  global.fetch = async (url, opts = {}) => {
    const method = (opts.method || "GET").toUpperCase();
    const u = String(url);
    const body = opts.body && typeof opts.body === "string" && opts.body.startsWith("{") ? JSON.parse(opts.body) : null;
    if (u.includes("/oauth2/v2.0/token")) return json(200, { access_token: "tok", expires_in: 3600 });
    calls.push({ method, url: u, body });

    // rules — checked BEFORE the folder routes, whose paths are a prefix of these
    if (u.includes("/mailFolders/inbox/messageRules")) {
      const m = u.match(/messageRules\/([^?]+)/);
      if (method === "GET") return json(200, { value: state.rules });
      if (method === "POST") {
        const r = { id: "rule-" + state.nextId++, ...body };
        state.rules.push(r);
        return json(201, r);
      }
      if (method === "PATCH") {
        const r = state.rules.find((x) => x.id === decodeURIComponent(m[1]));
        Object.assign(r, body);
        return json(200, r);
      }
      if (method === "DELETE") {
        state.rules = state.rules.filter((x) => x.id !== decodeURIComponent(m[1]));
        return { status: 204, json: async () => null };
      }
    }
    // messages in a folder (sweep / unsweep listing)
    if (/\/mailFolders\/[^/]+\/messages/.test(u)) {
      const folder = decodeURIComponent(u.match(/mailFolders\/([^/]+)\/messages/)[1]);
      const addr = (decodeURIComponent(u).match(/address eq '([^']+)'/) || [])[1];
      const hits = state.messages.filter((m) => m.folderId === folder && (!addr || m.from === addr));
      return json(200, { value: hits.map((m) => ({ id: m.id })) });
    }
    // move
    if (/\/messages\/[^/]+\/move$/.test(u) && method === "POST") {
      const id = decodeURIComponent(u.match(/messages\/([^/]+)\/move/)[1]);
      const msg = state.messages.find((m) => m.id === id);
      if (msg) msg.folderId = body.destinationId;
      return json(201, { id });
    }
    // folders
    if (u.includes("/mailFolders?")) return json(200, { value: state.folders });
    if (/\/mailFolders$/.test(u) && method === "POST") {
      const f = { id: "folder-" + state.nextId++, displayName: body.displayName, totalItemCount: 0 };
      state.folders.push(f);
      return json(201, f);
    }
    return json(404, { error: { code: "NotFound", message: u } });
  };
  return { state, calls, writes: () => calls.filter((c) => c.method !== "GET") };
}

function setBlocks(rows) {
  db.prepare("DELETE FROM sender_blocks").run();
  db.prepare("DELETE FROM sender_block_sync").run();
  for (const [pattern, kind] of rows) {
    db.prepare("INSERT OR IGNORE INTO sender_blocks (pattern, kind, added_by) VALUES (?, ?, 'test')").run(pattern, kind);
  }
}

// ---- 1. the empty-conditions invariant --------------------------------------------------------

test("ruleBody refuses to build a rule with no conditions", () => {
  assert.throws(() => OB.ruleBody("X", "f1", { fromAddresses: [] }, 1), /no conditions/);
  assert.throws(() => OB.ruleBody("X", "f1", {}, 1), /no conditions/);
  assert.throws(() => OB.ruleBody("X", "f1", { senderContains: [] }, 1), /no conditions/);
});

test("ruleBody refuses to build a rule with no destination folder", () => {
  assert.throws(() => OB.ruleBody("X", null, OB.addrConditions(["a@b.com"]), 1), /destination folder/);
});

test("an empty blocklist DELETES the rules and writes nothing else", async () => {
  const g = makeGraph({
    rules: [
      { id: "r1", displayName: OB.RULE_ADDRESSES, sequence: 1, isEnabled: true, conditions: { fromAddresses: [{ emailAddress: { address: "x@y.com" } }] }, actions: {} },
      { id: "r2", displayName: OB.RULE_DOMAINS, sequence: 2, isEnabled: true, conditions: { senderContains: ["@z.com"] }, actions: {} },
    ],
  });
  setBlocks([]);
  const rep = await OB.syncMailbox("info");
  assert.equal(g.state.rules.length, 0, "both Axle rules removed");
  assert.equal(rep.changes.filter((c) => c.startsWith("deleted")).length, 2);
  assert.equal(g.writes().filter((c) => c.method === "POST" || c.method === "PATCH").length, 0,
    "an empty blocklist must never create or patch a rule");
});

// ---- 2. our own domains ------------------------------------------------------------------------

test("isInternal covers our domains and their subdomains, and nothing else", () => {
  for (const a of ["info@budget-parts.nl", "x@roverparts.eu", "y@mail.budget-parts.nl", "Z@BUDGET-PARTS.NL"]) {
    assert.equal(OB.isInternal(a), true, a);
  }
  for (const a of ["a@gmail.com", "b@budget-parts.com", "c@notbudget-parts.nl", ""]) {
    assert.equal(OB.isInternal(a), false, a);
  }
});

test("an internal address in the table is never written into a rule", async () => {
  const g = makeGraph();
  setBlocks([["info@budget-parts.nl", "address"], ["spam@example.com", "address"]]);
  const pat = OB.currentPatterns();
  assert.deepEqual(pat.addresses, ["spam@example.com"]);
  await OB.syncMailbox("info");
  const rule = g.state.rules.find((r) => r.displayName === OB.RULE_ADDRESSES);
  const written = rule.conditions.fromAddresses.map((x) => x.emailAddress.address);
  assert.deepEqual(written, ["spam@example.com"]);
});

// ---- 3. addresses and domains are separate rules ------------------------------------------------

test("addresses and domains go into two separate rules, never combined", async () => {
  const g = makeGraph();
  setBlocks([["spam@example.com", "address"], ["@news.example.org", "domain"]]);
  await OB.syncMailbox("info");
  const addrRule = g.state.rules.find((r) => r.displayName === OB.RULE_ADDRESSES);
  const domRule = g.state.rules.find((r) => r.displayName === OB.RULE_DOMAINS);
  assert.ok(addrRule && domRule, "both rules exist");
  assert.ok(addrRule.conditions.fromAddresses && !addrRule.conditions.senderContains,
    "the address rule must not also carry senderContains — conditions are ANDed");
  assert.ok(domRule.conditions.senderContains && !domRule.conditions.fromAddresses,
    "the domain rule must not also carry fromAddresses");
});

test("a bare domain row is normalised to the @domain form", () => {
  setBlocks([["news.example.org", "domain"]]);
  assert.deepEqual(OB.currentPatterns().domains, ["@news.example.org"]);
});

// ---- 4. the gate ---------------------------------------------------------------------------------

test("with the action off, syncAll writes nothing at all", async () => {
  const g = makeGraph();
  setBlocks([["spam@example.com", "address"]]);
  process.env.AXLE_ACTION_OUTLOOK_BLOCK = "";
  const r = await OB.syncAll();
  process.env.AXLE_ACTION_OUTLOOK_BLOCK = "on";
  assert.equal(r.ok, false);
  assert.match(r.skipped, /not enabled/);
  assert.equal(g.calls.length, 0, "not one Graph call while the gate is off");
});

test("an explicit dry run works while the gate is off, and still writes nothing", async () => {
  // This is the pre-flight: show exactly what enabling the action would do to the live mailboxes
  // before anyone edits .env. It must read, and it must not write.
  const g = makeGraph();
  setBlocks([["spam@example.com", "address"]]);
  process.env.AXLE_ACTION_OUTLOOK_BLOCK = "";
  const r = await OB.syncAll({ dry: true, force: true });
  process.env.AXLE_ACTION_OUTLOOK_BLOCK = "on";
  assert.ok(!r.skipped, "an explicit dry run is not skipped by the gate");
  assert.ok(r.boxes.some((b) => (b.changes || []).some((c) => /would CREATE/.test(c))));
  assert.equal(g.writes().length, 0, "still not one write");
  assert.equal(g.state.rules.length, 0);
});

test("dry run reads but never writes", async () => {
  const g = makeGraph();
  setBlocks([["spam@example.com", "address"]]);
  process.env.AXLE_ACTION_OUTLOOK_BLOCK = "dry";
  const rep = await OB.syncMailbox("info");
  process.env.AXLE_ACTION_OUTLOOK_BLOCK = "on";
  assert.ok(rep.changes.some((c) => /would CREATE/.test(c)));
  assert.equal(g.writes().length, 0, "dry run must issue no POST/PATCH/DELETE");
  assert.equal(g.state.rules.length, 0);
});

// ---- 5. rule content, ordering and idempotency ----------------------------------------------------

test("the created rule moves to the Axle folder, marks read and stops processing", async () => {
  const g = makeGraph();
  setBlocks([["spam@example.com", "address"]]);
  await OB.syncMailbox("info");
  const rule = g.state.rules.find((r) => r.displayName === OB.RULE_ADDRESSES);
  const folder = g.state.folders.find((f) => f.displayName === OB.FOLDER_NAME);
  assert.ok(folder, "the Axle Blocked folder was created");
  assert.equal(rule.actions.moveToFolder, folder.id);
  assert.equal(rule.actions.markAsRead, true);
  assert.equal(rule.actions.stopProcessingRules, true);
  assert.equal(rule.isEnabled, true);
  assert.ok(!("delete" in rule.actions) && !("permanentDelete" in rule.actions),
    "blocked mail is filed, never deleted");
});

test("the rule is sequenced ahead of the mailbox's existing rules", async () => {
  const g = makeGraph({ rules: [{ id: "r9", displayName: "Shopify Contact Form", sequence: 5, isEnabled: true, conditions: {}, actions: {} }] });
  setBlocks([["spam@example.com", "address"]]);
  await OB.syncMailbox("info");
  const rule = g.state.rules.find((r) => r.displayName === OB.RULE_ADDRESSES);
  assert.ok(rule.sequence < 5, `expected to run before sequence 5, got ${rule.sequence}`);
});

test("an already-correct rule is not rewritten", async () => {
  const g = makeGraph();
  setBlocks([["spam@example.com", "address"]]);
  await OB.syncMailbox("info");
  const before = g.writes().length;
  await OB.syncMailbox("info");
  assert.equal(g.writes().length, before, "second sync must issue no further writes");
});

test("a rule someone disabled or edited in Outlook is healed", async () => {
  const g = makeGraph();
  setBlocks([["spam@example.com", "address"]]);
  await OB.syncMailbox("info");
  const rule = g.state.rules.find((r) => r.displayName === OB.RULE_ADDRESSES);
  rule.isEnabled = false;
  rule.conditions.fromAddresses = [];
  await OB.syncMailbox("info");
  const after = g.state.rules.find((r) => r.displayName === OB.RULE_ADDRESSES);
  assert.equal(after.isEnabled, true);
  assert.deepEqual(after.conditions.fromAddresses.map((x) => x.emailAddress.address), ["spam@example.com"]);
});

test("sameRule ignores ordering and case but notices real differences", () => {
  const want = OB.ruleBody("R", "f1", OB.addrConditions(["a@x.com", "b@x.com"]), 1);
  const live = { isEnabled: true, actions: { moveToFolder: "f1", markAsRead: true, stopProcessingRules: true },
    conditions: { fromAddresses: [{ emailAddress: { address: "B@X.com" } }, { emailAddress: { address: "a@x.com" } }] } };
  assert.equal(OB.sameRule(live, want), true);
  assert.equal(OB.sameRule({ ...live, isEnabled: false }, want), false);
  assert.equal(OB.sameRule({ ...live, actions: { ...live.actions, moveToFolder: "other" } }, want), false);
  assert.equal(OB.sameRule({ ...live, actions: { ...live.actions, stopProcessingRules: false } }, want), false);
  assert.equal(OB.sameRule({ ...live, conditions: { fromAddresses: [{ emailAddress: { address: "a@x.com" } }] } }, want), false);
  assert.equal(OB.sameRule(null, want), false);
});

// ---- 6. the retroactive sweep -----------------------------------------------------------------------

test("blocking sweeps that sender's existing inbox mail into the folder, and nobody else's", async () => {
  const g = makeGraph({
    messages: [
      { id: "m1", from: "spam@example.com", folderId: "inbox" },
      { id: "m2", from: "spam@example.com", folderId: "inbox" },
      { id: "m3", from: "customer@example.com", folderId: "inbox" },
    ],
  });
  setBlocks([["spam@example.com", "address"]]);
  await OB.syncMailbox("info");
  const folder = g.state.folders.find((f) => f.displayName === OB.FOLDER_NAME);
  const rep = await OB.sweepSender("info", "spam@example.com");
  assert.equal(rep.moved, 2);
  assert.equal(g.state.messages.find((m) => m.id === "m3").folderId, "inbox", "other senders untouched");
  assert.equal(g.state.messages.find((m) => m.id === "m1").folderId, folder.id);
});

test("the sweep refuses an internal address outright", async () => {
  const g = makeGraph({ messages: [{ id: "m1", from: "info@budget-parts.nl", folderId: "inbox" }] });
  const rep = await OB.sweepSender("info", "info@budget-parts.nl");
  assert.equal(rep.moved, 0);
  assert.equal(g.writes().length, 0);
});

test("unblocking moves the sender's filed mail back to the inbox", async () => {
  const g = makeGraph({
    folders: [{ id: "inbox-id", displayName: "Inbox" }, { id: "blk", displayName: OB.FOLDER_NAME, totalItemCount: 2 }],
    messages: [
      { id: "m1", from: "spam@example.com", folderId: "blk" },
      { id: "m2", from: "other@example.com", folderId: "blk" },
    ],
  });
  const rep = await OB.unsweepSender("info", "spam@example.com");
  assert.equal(rep.moved, 1);
  assert.equal(g.state.messages.find((m) => m.id === "m1").folderId, "inbox");
  assert.equal(g.state.messages.find((m) => m.id === "m2").folderId, "blk", "only the unblocked sender comes back");
});

// ---- 7. failure handling -------------------------------------------------------------------------

test("a Graph failure is reported, never thrown into the caller", async () => {
  global.fetch = async (url) => String(url).includes("/oauth2/")
    ? { status: 200, json: async () => ({ access_token: "tok", expires_in: 3600 }) }
    : { status: 403, json: async () => ({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }) };
  setBlocks([["spam@example.com", "address"]]);
  const r = await OB.syncAll();
  assert.equal(r.ok, false);
  assert.ok(r.boxes.every((b) => /ErrorAccessDenied/.test(b.error || "")));
  const applied = await OB.applyBlock("test@user", "spam@example.com", 1);
  assert.ok(applied, "applyBlock resolves rather than throwing");
});

test("reconcile is a no-op once the mailboxes match the blocklist", async () => {
  const g = makeGraph();
  setBlocks([["spam@example.com", "address"]]);
  await OB.syncAll();
  const before = g.calls.length;
  const r = await OB.reconcile();
  assert.equal(r.upToDate, true);
  assert.equal(g.calls.length, before, "an unchanged blocklist costs no Graph calls");
});

test.after(() => {
  try { db.close(); } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});
