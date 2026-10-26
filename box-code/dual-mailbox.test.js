// dual-mailbox.test.js - A3: the same email in info@ and drachten@ is kept in one mailbox.
// Runs on a throwaway database; SAP and the mailbox are stubbed. Run: node dual-mailbox.test.js
"use strict";
const os = require("os"), path = require("path"), fs = require("fs");
process.env.AXLE_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "axle-dual-")), "t.db");
const assert = require("assert");
const { db } = require("./db.js");
const DUAL = require("./dual-mailbox.js");

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const SENDER = "klant@example.nl";
function item(box, subject, internetId) {
  const id = db.prepare("INSERT INTO work_items (mailbox, conversation_key, sender_email, sender_name, subject, email_text, email_received) VALUES (?, ?, ?, 'Klant', ?, 'x', datetime('now'))")
    .run(box, box + "|" + subject + "|" + Math.random(), SENDER, subject).lastInsertRowid;
  if (internetId) db.prepare("INSERT INTO messages (work_item_id, mailbox, graph_id, internet_id, from_addr) VALUES (?, ?, ?, ?, ?)").run(id, box, "g" + id, internetId, SENDER);
  return id;
}
// SAP stub: 232416 is a Gouda order, 232400 a Drachten invoice, S12345 a Gouda webshop order.
const SAP = {
  "232416": [{ objectId: 17, docEntry: 1, docNum: 232416, whs: ["10-GOU"] }],
  "232400": [{ objectId: 13, docEntry: 2, docNum: 232400, whs: ["20-DRA"] }],
  "S12345": [{ objectId: 17, docEntry: 3, docNum: 232300, whs: ["10-GOU"] }],
};
function deps(log) {
  return {
    db,
    audit: (u, a, id, d) => log.push({ a, id, d }),
    resolveReference: async (ref) => ({ docs: SAP[ref.number] || [] }),
    docWarehouses: async (obj, entry) => Object.values(SAP).flat().find((d) => d.docEntry === entry).whs,
    closeItem: async (w, note) => {
      db.prepare("UPDATE work_items SET status = 'done', resolution = 'duplicate' WHERE id = ?").run(w.id);
      log.push({ a: "closed", id: w.id, d: note });
    },
  };
}
const status = (id) => db.prepare("SELECT status FROM work_items WHERE id = ?").get(id).status;
const mail = (subject, text, mid) => ({ from: { address: SENDER }, subject, text, internetMessageId: mid || null });

test("reference to a Gouda document keeps info@, closes the drachten@ copy", async () => {
  const first = item("info", "Order 232416 status", "<a@x>");
  const second = item("drachten", "Order 232416 status");
  const log = [];
  const r = await DUAL.handle(second, "drachten", mail("Order 232416 status", "Where is order 232416?", "<a@x>"), { branch_topic: "parts_quote" }, deps(log));
  assert.strictEqual(r.action, "closed_this");
  assert.strictEqual(r.keep, "info");
  assert.strictEqual(status(second), "done");
  assert.strictEqual(status(first), "new");
  assert.ok(log.some((l) => l.a === "dual_mailbox_closed" && /kept in info@ \(Gouda\): reference 232416 10-GOU/.test(l.d)));
});

test("reference to a Drachten document keeps drachten@, closes the info@ copy", async () => {
  const first = item("info", "Factuur 232400");
  const second = item("drachten", "RE: Factuur 232400");
  const log = [];
  const r = await DUAL.handle(second, "drachten", mail("RE: Factuur 232400", "Factuur 232400 klopt niet"), { branch_topic: "general" }, deps(log));
  assert.strictEqual(r.action, "closed_other");
  assert.strictEqual(status(first), "done");
  assert.strictEqual(status(second), "new");
});

test("Shopify #S reference resolves to a Gouda order", async () => {
  const first = item("drachten", "Bestelling #S12345");
  const second = item("info", "Bestelling #S12345");
  const r = await DUAL.handle(second, "info", mail("Bestelling #S12345", "Waar blijft #S12345?"), { branch_topic: "parts_quote" }, deps([]));
  assert.strictEqual(r.action, "closed_other");
  assert.strictEqual(status(first), "done");
});

test("no reference, quote: Drachten keeps it (AI topic)", async () => {
  const first = item("info", "Offerte remschijven");
  const second = item("drachten", "Offerte remschijven");
  const r = await DUAL.handle(second, "drachten", mail("Offerte remschijven", "Graag een prijs voor remschijven Defender"), { branch_topic: "parts_quote" }, deps([]));
  assert.strictEqual(r.action, "closed_other");
  assert.strictEqual(r.keep, "drachten");
  assert.strictEqual(status(first), "done");
});

test("no reference, general enquiry: Gouda keeps it (AI topic)", async () => {
  const first = item("info", "Openingstijden");
  const second = item("drachten", "Openingstijden");
  const r = await DUAL.handle(second, "drachten", mail("Openingstijden", "Zijn jullie zaterdag open?"), { branch_topic: "general" }, deps([]));
  assert.strictEqual(r.action, "closed_this");
  assert.strictEqual(r.keep, "info");
  assert.strictEqual(status(second), "done");
  assert.strictEqual(status(first), "new");
});

test("AI unsure keeps both open and flags them", async () => {
  const first = item("info", "Vraag");
  const second = item("drachten", "Vraag");
  const log = [];
  const r = await DUAL.handle(second, "drachten", mail("Vraag", "Hallo, ik heb een vraag"), { branch_topic: "unsure" }, deps(log));
  assert.strictEqual(r.action, "flagged");
  assert.ok(/also in info@ \(Gouda\)/.test(r.flag) && /also in drachten@ \(Drachten\)/.test(r.twinFlag));
  assert.strictEqual(status(first), "new");
  assert.strictEqual(status(second), "new");
  assert.ok(log.some((l) => l.a === "dual_mailbox_flagged"));
});

test("failed classifier keeps both open", async () => {
  const first = item("info", "Iets anders");
  const second = item("drachten", "Iets anders");
  const r = await DUAL.handle(second, "drachten", mail("Iets anders", "tekst"), { branch_topic: "unsure", summary: "UNPARSEABLE CLASSIFIER OUTPUT" }, deps([]));
  assert.strictEqual(r.action, "flagged");
  assert.strictEqual(status(first), "new");
});

test("references to both branches keep both open", async () => {
  item("info", "Twee orders");
  const second = item("drachten", "Twee orders");
  const r = await DUAL.handle(second, "drachten", mail("Twee orders", "Order 232416 en factuur 232400"), { branch_topic: "general" }, deps([]));
  assert.strictEqual(r.action, "flagged");
});

test("single-mailbox message is untouched", async () => {
  const only = item("info", "Alleen hier");
  const log = [];
  const r = await DUAL.handle(only, "info", mail("Alleen hier", "Graag een offerte"), { branch_topic: "parts_quote" }, deps(log));
  assert.strictEqual(r.action, "none");
  assert.strictEqual(status(only), "new");
  assert.strictEqual(log.length, 0);
});

test("another sender with the same subject is not a twin", async () => {
  db.prepare("INSERT INTO work_items (mailbox, conversation_key, sender_email, subject) VALUES ('info', 'k-other', 'iemand@anders.nl', 'Offerte')").run();
  const mine = item("drachten", "Offerte");
  const r = await DUAL.handle(mine, "drachten", mail("Offerte", "prijs?"), { branch_topic: "parts_quote" }, deps([]));
  assert.strictEqual(r.action, "none");
});

(async () => {
  console.log("dual-mailbox");
  for (const [name, fn] of tests) { await fn(); pass++; console.log("  ok  " + name); }
  console.log(`${pass} passed`);
})().catch((e) => { console.error("  FAIL", e.message); process.exit(1); });
