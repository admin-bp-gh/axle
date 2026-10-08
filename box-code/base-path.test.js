// base-path.test.js - W3 shell integration: the AXLE_BASE_PATH helper, and the outer app in
// server.js (healthz before the identity wall, both prefixed and prefix-less requests accepted).
// Run: node --test base-path.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const Module = require("module");

// The server test needs a fixed base path, set BEFORE server.js loads.
process.env.AXLE_BASE_PATH = "/axle";

// db.js is replaced by a counting stub: the test is about routing order, it must run where the
// native SQLite build does not load, and it proves healthz never touches the DB.
const calls = { prepare: 0, audit: [] };
const stmt = { run: () => ({ changes: 0, lastInsertRowid: 0 }), get: () => undefined, all: () => [] };
const dbPath = require.resolve("./db.js");
const fakeDb = new Module(dbPath, module);
fakeDb.filename = dbPath;
fakeDb.loaded = true;
fakeDb.exports = {
  db: { prepare: () => { calls.prepare++; return stmt; }, pragma() {}, exec() {}, transaction: (f) => f },
  audit: (...a) => { calls.audit.push(a); },
  acquireSync: () => false, releaseSync() {}, syncStatus: () => ({}),
  getWatermark: () => null, setWatermark() {}, isBlockedSender: () => false,
  DB_PATH: require("path").join(require("os").tmpdir(), "axle-base-path-test.db"), getMeta: () => "1", setMeta() {},
};
require.cache[dbPath] = fakeDb;

const BASE = require("./base-path.js");

test("normalise: empty and slash-only mean no base path", () => {
  for (const v of [undefined, null, "", "   ", "/", "//"]) assert.strictEqual(BASE.normalise(v), "");
});

test("normalise: leading slash added, trailing and doubled slashes dropped", () => {
  assert.strictEqual(BASE.normalise("/axle"), "/axle");
  assert.strictEqual(BASE.normalise("axle"), "/axle");
  assert.strictEqual(BASE.normalise("/axle/"), "/axle");
  assert.strictEqual(BASE.normalise(" /axle// "), "/axle");
  assert.strictEqual(BASE.normalise("//tools//axle/"), "/tools/axle");
});

test("normalise: anything but a plain path is refused", () => {
  for (const v of ["/ax le", "/axle?x=1", "/axle#x", "/../etc", "/a.b", "/axle\"><script>"]) {
    assert.throws(() => BASE.normalise(v), /AXLE_BASE_PATH/, v);
  }
});

test("url() prefixes app-absolute paths; no base leaves them as they were", () => {
  const b = BASE.make("/axle");
  assert.strictEqual(b.url("/"), "/axle/");
  assert.strictEqual(b.url("/item/5"), "/axle/item/5");
  assert.strictEqual(b.url("/?synced=1"), "/axle/?synced=1");
  assert.strictEqual(b.url("item/5"), "/axle/item/5");
  const none = BASE.make("");
  assert.strictEqual(none.path, "");
  assert.strictEqual(none.url("/"), "/");
  assert.strictEqual(none.url("/item/5"), "/item/5");
});

test("has() spots the prefix only as a whole segment", () => {
  const b = BASE.make("/axle");
  assert.ok(b.has("/axle") && b.has("/axle/") && b.has("/axle/item/5") && b.has("/axle?x=1"));
  assert.ok(!b.has("/") && !b.has("/item/5") && !b.has("/axlefoo"));
  assert.ok(BASE.make("").has("/anything"));
});

test("the module reads AXLE_BASE_PATH", () => {
  assert.strictEqual(BASE.path, "/axle");
});

function get(port, p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: p, headers: headers || {} }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => resolve({ status: res.statusCode, body, type: String(res.headers["content-type"] || "") }));
    });
    req.on("error", reject);
  });
}

test("server: healthz answers without identity, the app itself does not", async (t) => {
  const root = require("./server.js");
  const srv = await new Promise((resolve) => { const s = root.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(() => srv.close());
  const port = srv.address().port;

  for (const p of ["/axle/healthz", "/healthz"]) {
    const before = calls.prepare + calls.audit.length;
    const r = await get(port, p);
    assert.strictEqual(calls.prepare + calls.audit.length, before, p + " touched the DB");
    assert.strictEqual(r.status, 200, p);
    assert.match(r.type, /application\/json/, p);
    const j = JSON.parse(r.body);
    assert.strictEqual(j.ok, true, p);
    assert.strictEqual(typeof j.version, "string", p);
    assert.deepStrictEqual(Object.keys(j).sort(), ["ok", "version"], p);
  }
  for (const p of ["/axle/", "/axle", "/", "/item/1", "/axle/item/1", "/axle/assets/tokens.css"]) {
    const n = calls.audit.length;
    const r = await get(port, p);
    assert.strictEqual(r.status, 403, p);
    assert.strictEqual(calls.audit[n] && calls.audit[n][1], "no_identity_header", p);
  }
});
