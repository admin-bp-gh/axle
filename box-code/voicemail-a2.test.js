"use strict";
// voicemail-a2.test.js: the voicemail call back sheet (Change A2, design D54, 12 Oct 2026).
//
// A voicemail item becomes a call back sheet: how often this number called (P1), the customer's
// open issues (P2), a supplier panel (P3), no writing tools (P4), no AI draft (P5), and company
// names in "people we know" replaced by the sender's address (P6). These tests pin each part, and
// render the real item page and inbox list against a throwaway database to prove what shows.
// No live SAP: every SAP read is either a fake pool or a stub, and nothing is ever sent.
// Only made-up numbers and names: 0499000000 (confirmed unused) in several spellings, and
// 0100000000 (Dutch local numbers never start with 0) where a second number is needed.
// Run: node --test voicemail-a2.test.js
//
// SAFETY: AXLE_DB is pinned to a throwaway file BEFORE db.js loads, so the live database is never touched.
const fs = require("fs");
const os = require("os");
const path = require("path");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axle-vm-a2-"));
process.env.AXLE_DB = path.join(tmpDir, "test.db");

const test = require("node:test");
const assert = require("node:assert");
const express = require("express");
const C = require("./connectors.js");
const E = require("./engine.js");
const VS = require("./voicemail-sheet.js");
const UI = require("./views/ui.js");
const RULES = require("./rules.js");
const { db } = require("./db.js");

const DASHES = new RegExp("[\u2013\u2014]");   // en dash, em dash
const NOW = new Date("2026-10-12T10:00:00Z");
const VM_FROM = "voicemail@hipservice.nl";
const subj = (n) => `Voice Message Attached from ${n} - ${n}`;
const body = (s) => `Time: ${s}\r\nClick attachment to listen to Voice Message`;
const vm = (id, number, kpn, extra = {}) => ({ id, subject: subj(number), email_text: kpn ? body(kpn) : "Click attachment to listen", ...extra });

// --- one app with the real item page and inbox, a fixed user --------------------------------
let LANG = "en";
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => { req.user = { tailscale_login: "tester@example.com", name: "Tester", role: "admin", lang: LANG }; next(); });
require("./routes/item.js")(app, {});
require("./routes/inbox.js")(app, {});
let server, base;
test.before(() => new Promise((ok) => { server = app.listen(0, "127.0.0.1", () => { base = `http://127.0.0.1:${server.address().port}`; ok(); }); }));
test.after(() => { server.close(); try { db.close(); } catch (e) { /* already closed */ } fs.rmSync(tmpDir, { recursive: true, force: true }); });
const get = async (p) => (await fetch(base + p)).text();

const sqlTime = (d) => d.toISOString().replace("T", " ").slice(0, 19);
const ago = (days) => new Date(Date.now() - days * 24 * 3600 * 1000);
function insert(o) {
  const row = { mailbox: "info", conversation_key: "k" + Math.random(), sender_email: "klant@example.com", sender_name: "Test Klant",
    subject: "Vraag", email_text: "Hallo", email_received: new Date().toISOString(), rule_id: "catch_all", status: "new",
    owner: "Jack", intent: "other", caller_info: null, caller_card: null, cust_card: null, attachments_json: null,
    created_at: sqlTime(new Date()), updated_at: sqlTime(new Date()), ...o };
  const cols = Object.keys(row);
  return db.prepare(`INSERT INTO work_items (${cols.join(", ")}) VALUES (${cols.map((c) => "@" + c).join(", ")})`).run(row).lastInsertRowid;
}
const insertVm = (o) => insert({ sender_email: VM_FROM, sender_name: "Voicemail", rule_id: "voicemail", owner: "Sales(Gouda)", intent: "other", ...o });

// ================================================================ P1: time
test("KPN's body time is read with Dutch months, in Amsterdam time (summer and winter)", () => {
  assert.strictEqual(VS.kpnBodyTime(body("9 okt. 2026 10:03:13")).toISOString(), "2026-10-09T08:03:13.000Z");
  assert.strictEqual(VS.kpnBodyTime(body("2 dec. 2026 09:00:00")).toISOString(), "2026-12-02T08:00:00.000Z");
  assert.strictEqual(VS.kpnBodyTime(body("5 mrt. 2026 14:30:00")).toISOString(), "2026-03-05T13:30:00.000Z");
  assert.strictEqual(VS.kpnBodyTime(body("12 mei 2026 08:15:00")).toISOString(), "2026-05-12T06:15:00.000Z");
  assert.strictEqual(VS.kpnBodyTime("Click attachment to listen"), null);
});

test("the attachment name's time is read when the body has none", () => {
  const atts = JSON.stringify([{ name: "0499000000_20261006_115700.wav" }]);
  assert.strictEqual(VS.attachmentTime(atts).toISOString(), "2026-10-06T09:57:00.000Z");
  assert.strictEqual(VS.voicemailTime({ email_text: "", attachments_json: atts, email_received: "2026-10-06T12:00:00Z" }).toISOString(), "2026-10-06T09:57:00.000Z");
});

test("the received time is the last fallback, and the ingest time is never used", () => {
  assert.strictEqual(VS.voicemailTime({ email_text: "", email_received: "2026-10-06T12:00:00Z", created_at: "2026-10-01 00:00:00" }).toISOString(), "2026-10-06T12:00:00.000Z");
  assert.strictEqual(VS.voicemailTime({ email_text: "", email_received: null, created_at: "2026-10-06 12:00:00" }), null);
  // Body time wins over a received time that ingest stamped hours later.
  assert.strictEqual(VS.voicemailTime({ email_text: body("9 okt. 2026 10:03:13"), email_received: "2026-10-09T14:00:00Z" }).toISOString(), "2026-10-09T08:03:13.000Z");
});

// ================================================================ P1: count
test("the same number in different spellings counts once each, earlier ones only", () => {
  const me = vm(10, "0499000000", "12 okt. 2026 09:00:00");
  const rows = [me,
    vm(1, "+31499000000", "6 okt. 2026 11:57:00"),
    vm(2, "0031499000000", "8 okt. 2026 09:36:00"),
    vm(3, "0100000000", "9 okt. 2026 09:00:00"),          // another number
    vm(4, "0499000000", "12 okt. 2026 15:00:00")];        // later than this one
  const e = VS.earlierVoicemails(me, rows);
  assert.deepStrictEqual(e.map((x) => x.id), [1, 2]);
});

test("the 14 day window: exactly 14 days back counts, one second more does not", () => {
  const me = vm(10, "0499000000", "20 okt. 2026 12:00:00");
  const rows = [me, vm(1, "0499000000", "6 okt. 2026 12:00:00"), vm(2, "0499000000", "6 okt. 2026 11:59:59")];
  assert.deepStrictEqual(VS.earlierVoicemails(me, rows).map((x) => x.id), [1]);
});

test("a voicemail timed outside the window never counts because of when Axle ingested it", () => {
  const me = vm(10, "0499000000", "20 okt. 2026 12:00:00");
  const old = vm(1, "0499000000", "1 okt. 2026 12:00:00", { created_at: "2026-10-19 12:00:00", email_received: "2026-10-19T12:00:00Z" });
  assert.deepStrictEqual(VS.earlierVoicemails(me, [me, old]), []);
});

test("hidden numbers are never counted, as this voicemail or as an earlier one", () => {
  const hidden = { id: 5, subject: "Voice Message Attached from Anonymous - Anonymous", email_text: body("8 okt. 2026 10:00:00") };
  const me = vm(10, "0499000000", "12 okt. 2026 09:00:00");
  assert.strictEqual(VS.callerNumber(hidden), null);
  assert.deepStrictEqual(VS.earlierVoicemails(me, [me, hidden]), []);
  assert.deepStrictEqual(VS.earlierVoicemails(hidden, [me, hidden, { ...hidden, id: 6 }]), []);
  assert.strictEqual(VS.voicemailCounts([hidden, { ...hidden, id: 6 }]).size, 0);
});

test("the inbox count includes the voicemail itself, so the tag shows from the second", () => {
  const rows = [vm(1, "0499000000", "6 okt. 2026 11:57:00"), vm(2, "+31 499 000 000", "8 okt. 2026 09:36:00"),
    vm(3, "0499000000", "12 okt. 2026 09:00:00"), vm(4, "0100000000", "12 okt. 2026 09:00:00")];
  const n = VS.voicemailCounts(rows);
  assert.deepStrictEqual([n.get(1), n.get(2), n.get(3), n.get(4)], [1, 2, 3, 1]);
});

test("ordinals and short times in English and Dutch", () => {
  assert.deepStrictEqual([2, 3, 4, 11, 12, 13, 21, 22, 23].map((n) => VS.ordinal(n, "en")), ["2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd"]);
  assert.strictEqual(VS.ordinal(3, "nl"), "3e");
  const d = new Date("2026-10-06T09:57:00Z");
  assert.strictEqual(VS.shortWhen(d, "en"), "Tue 6 Oct 11:57");
  assert.strictEqual(VS.shortWhen(d, "nl"), "di 6 okt 11:57");
});

// ================================================================ P2: open issues
const issue = (o) => ({ intent: "return_complaint", rule_id: "catch_all", status: "new", owner: "Jack",
  email_received: "2026-10-05T10:00:00Z", updated_at: "2026-10-05 10:00:00", sender_email: "other@example.com", ...o });

test("open issues: open first, then closed within 30 days marked closed; older closed left out", () => {
  const rows = [
    issue({ id: 1, cust_card: "C99999", status: "done", updated_at: "2026-10-01 10:00:00" }),
    issue({ id: 2, cust_card: "C99999", status: "ready", email_received: "2026-10-02T10:00:00Z" }),
    issue({ id: 3, cust_card: "C99999", status: "archived", updated_at: "2026-09-01 10:00:00" }),   // 41 days
    issue({ id: 4, cust_card: "C99999", status: "new", email_received: "2026-10-08T10:00:00Z" }),
  ];
  const r = VS.openIssues(rows, { card: "C99999", addrs: [], now: NOW });
  assert.deepStrictEqual(r.shown.map((x) => x.id), [4, 2, 1]);
  assert.strictEqual(r.more, 0);
});

test("open issues match by card code or by an on-file address, and only returns, complaints and warranty", () => {
  const rows = [
    issue({ id: 1, cust_card: "C99999" }),
    issue({ id: 2, sender_email: " Inkoop@Example.nl " }),
    issue({ id: 3, rule_id: "warranty_warp", intent: "other", cust_card: "C99999" }),
    issue({ id: 4, intent: "order_status", cust_card: "C99999" }),        // not an issue
    issue({ id: 5, cust_card: "C88888" }),                                // another customer
    issue({ id: 6, cust_card: "C99999", status: "new" }),                 // the voicemail itself
  ];
  const r = VS.openIssues(rows, { card: "C99999", addrs: ["inkoop@example.nl"], now: NOW, selfId: 6 });
  assert.deepStrictEqual(r.shown.map((x) => x.id).sort(), [1, 2, 3]);
  assert.deepStrictEqual(VS.openIssues(rows, { card: null, addrs: [], now: NOW }).shown, []);
});

test("open issues stop at 6 and say how many more", () => {
  const rows = Array.from({ length: 9 }, (_, i) => issue({ id: i + 1, cust_card: "C99999" }));
  const r = VS.openIssues(rows, { card: "C99999", addrs: [], now: NOW });
  assert.strictEqual(r.shown.length, 6);
  assert.strictEqual(r.more, 3);
});

// ================================================================ P3: supplier
test("supplier domains: company domains from the card and its contacts; free mail and our own never count", () => {
  const ds = VS.supplierDomains("creditcontrol@example.co.uk; a2-test-only@gmail.com", ["psp@example.co.uk", "a2-test-only@hotmail.co.uk", "a2-test-only@outlook.de", "a2-test-only@ziggo.nl", "s@budget-parts.nl", ""],
    (a) => a.endsWith("@budget-parts.nl"));
  assert.deepStrictEqual([...ds], ["example.co.uk"]);
  for (const d of ["gmail.com", "hotmail.com", "hotmail.nl", "outlook.com", "live.nl", "icloud.com", "ziggo.nl", "kpnmail.nl", "yahoo.fr"]) assert.ok(VS.isFreeMail(d), d);
  assert.ok(!VS.isFreeMail("example.co.uk"));
});

test("supplier warranty items match on the domain, not the exact address, and only open ones", () => {
  const rows = [
    issue({ id: 1, rule_id: "warranty_warp", intent: "other", sender_email: "psp@example.co.uk" }),
    issue({ id: 2, sender_email: "creditcontrol@example.co.uk", status: "done" }),
    issue({ id: 3, sender_email: "a2-test-only@gmail.com" }),
    issue({ id: 4, sender_email: "psp@other.example.co.uk" }),
  ];
  assert.deepStrictEqual(VS.supplierIssues(rows, new Set(["example.co.uk"])).shown.map((x) => x.id), [1]);
});

test("purchase order lines: own currency, EUR otherwise, and overdue against today's date", () => {
  const now = new Date("2026-10-12T10:00:00Z");
  assert.deepStrictEqual(VS.poLine({ DocNum: 101, DocDueDate: "2026-10-20", DocTotal: 1000, DocTotalFC: 850, DocCur: "GBP" }, now),
    { docNum: 101, value: 850, currency: "GBP", due: "2026-10-20", overdue: false });
  assert.deepStrictEqual(VS.poLine({ DocNum: 102, DocDueDate: new Date("2026-10-11T00:00:00Z"), DocTotal: 500, DocTotalFC: 0, DocCur: "EUR" }, now),
    { docNum: 102, value: 500, currency: "EUR", due: "2026-10-11", overdue: true });
  assert.strictEqual(VS.poLine({ DocNum: 103, DocDueDate: "2026-10-12", DocTotal: 7, DocCur: "" }, now).currency, "EUR");
  assert.strictEqual(VS.poLine({ DocNum: 103, DocDueDate: "2026-10-12", DocTotal: 7, DocCur: "" }, now).overdue, false);
});

test("supplierSheet reads only, with the card code as a parameter, and returns the open count", async () => {
  const seen = [];
  const pool = { request() {
    const inputs = {};
    return { input(k, t, v) { inputs[k] = v; return this; }, async query(text) {
      seen.push({ text, inputs: { ...inputs } });
      if (/FROM OCRD/.test(text)) return { recordset: [{ CardCode: "S99999", CardName: "Voorbeeld Parts Ltd", E_Mail: "sales@example.co.uk" }] };
      if (/FROM OCPR/.test(text)) return { recordset: [{ Name: "Pat Example", Position: "Sales", E_MailL: "pat@example.co.uk" }] };
      if (/COUNT\(\*\)/.test(text)) return { recordset: [{ n: 8 }] };
      return { recordset: [1, 2, 3, 4, 5].map((i) => ({ DocNum: 900 + i, DocDueDate: "2026-10-0" + i, DocTotal: 10, DocTotalFC: 0, DocCur: "EUR" })) };
    } };
  } };
  const d = await C.supplierSheet("S99999", { pool });
  assert.strictEqual(d.openCount, 8);
  assert.strictEqual(d.orders.length, 5);
  assert.deepStrictEqual(d.contacts, [{ name: "Pat Example", position: "Sales", email: "pat@example.co.uk" }]);
  for (const q of seen) {
    assert.match(q.text.trim(), /^SELECT /, "read-only");
    assert.doesNotMatch(q.text, /\b(INSERT|UPDATE|DELETE|MERGE|EXEC|DROP|ALTER)\b/i);
    assert.strictEqual(q.inputs.cc, "S99999");
    assert.match(q.text, /@cc/);
  }
});

// ================================================================ P6: people list
test("a sender named like the company, or named by an address, shows as the email address", () => {
  const rows = [
    { name: "  voorbeeld   AANHANGWAGENS ", email: "Contact@Example.nl", last: "2026-10-08T10:00:00Z" },
    { name: "info@example.nl", email: "info@example.nl", last: "2026-10-01T10:00:00Z" },
    { name: "", email: "noname@example.nl", last: "2026-09-01T10:00:00Z" },
    { name: "Jan Voorbeeld", email: "jan@example.nl", last: "2026-10-02T10:00:00Z" },
    { name: "Jan Voorbeeld", email: "jan.v@example.nl", last: "2026-10-05T10:00:00Z" },
  ];
  assert.deepStrictEqual(C.emailerPeople(rows, "Voorbeeld Aanhangwagens"), [
    { name: "contact@example.nl", last: "2026-10-08T10:00:00Z" },
    { name: "info@example.nl", last: "2026-10-01T10:00:00Z" },
    { name: "noname@example.nl", last: "2026-09-01T10:00:00Z" },
    { name: "Jan Voorbeeld", last: "2026-10-05T10:00:00Z" },
  ]);
});

// ================================================================ P5: no AI draft
test("ingest: a KPN voicemail matches the voicemail rule, which never drafts, in both mailboxes", () => {
  const email = { from: { address: VM_FROM, name: "Voicemail" }, subject: subj("0499000000") };
  for (const box of ["info", "drachten"]) {
    const rule = RULES.matchRule(email, RULES[box].rules);
    assert.strictEqual(rule.id, "voicemail", box);
    assert.ok(!rule.draft, `${box}: the voicemail rule must not draft`);
  }
  const normal = RULES.matchRule({ from: { address: "klant@example.com", name: "" }, subject: "Vraag over onderdeel" }, RULES.info.rules);
  assert.ok(normal.draft, "a normal email still drafts");
});

test("redraft: a voicemail is skipped quietly and put back to New; a normal item still redrafts", async () => {
  const { runRedraft } = require("./routes/shared.js");
  const calls = [];
  const saved = { gatherSeed: E.gatherSeed, agenticDraft: E.agenticDraft };
  E.gatherSeed = async () => ({});
  E.agenticDraft = async () => { calls.push(1); return { result: { status: "ready", draft: "Beste klant, dit is een test.", confidence: 0.9, language: "nl" }, toolLog: [] }; };
  try {
    const v = insertVm({ subject: subj("0499000000"), status: "investigating" });
    await runRedraft(v, "tester@example.com");
    assert.strictEqual(calls.length, 0, "no draft call for a voicemail");
    assert.strictEqual(db.prepare("SELECT status FROM work_items WHERE id = ?").get(v).status, "new");
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE work_item_id = ?").get(v).n, 0);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE work_item_id = ? AND action = 'redraft_skipped'").get(v).n, 1);
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE work_item_id = ? AND action = 'redraft_failed'").get(v).n, 0, "never an error");

    const n = insert({ status: "investigating", latest_message_id: "m-test-1" });
    await runRedraft(n, "tester@example.com");
    assert.strictEqual(calls.length, 1, "a normal item still gets its draft call");
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM drafts WHERE work_item_id = ?").get(n).n, 1);
  } finally { Object.assign(E, saved); }
});

test("redraft: a skipped voicemail keeps its status exactly; Done never reopens", async () => {
  const { runRedraft } = require("./routes/shared.js");
  for (const status of ["done", "archived", "ready", "awaiting_input", "new"]) {
    const id = insertVm({ subject: subj("0499000000"), status });
    await runRedraft(id, "tester@example.com");
    assert.strictEqual(db.prepare("SELECT status FROM work_items WHERE id = ?").get(id).status, status, status);
  }
});

const post = (p, form) => fetch(base + p, { method: "POST", redirect: "manual", body: new URLSearchParams(form) });

test("Create order hand-back on a voicemail: Done stays Done, an open one keeps its status and is not redrafted", async () => {
  const SAPDOC = require("./sap-doc-pdf.js");
  const saved = { resolveDocument: SAPDOC.resolveDocument, customersByEmail: SAPDOC.customersByEmail, renderPdf: SAPDOC.renderPdf };
  SAPDOC.resolveDocument = async (type, num) => ({ ok: true, candidates: [{ docNum: Number(num), docEntry: 1, objectId: "17", cardCode: "C99999" }] });
  SAPDOC.customersByEmail = async () => [{ cardCode: "C99999", cardName: "Voorbeeld BV" }];   // put the order in scope
  SAPDOC.renderPdf = async () => ({ ok: false, error: "no SAP in tests" });
  try {
    const done = insertVm({ subject: subj("0499000000"), status: "done", resolution: "phone" });
    await post(`/item/${done}/order-created`, { docnum: "123456" });
    assert.strictEqual(db.prepare("SELECT status, resolution FROM work_items WHERE id = ?").get(done).status, "done");

    const ready = insertVm({ subject: subj("0499000000"), status: "ready" });
    const r = await post(`/item/${ready}/order-created`, { docnum: "123456" });
    assert.strictEqual(r.status, 200, "no error back to Ratchet");
    await new Promise((ok) => setTimeout(ok, 20));
    const row = db.prepare("SELECT status, feedback FROM work_items WHERE id = ?").get(ready);
    assert.strictEqual(row.status, "ready");
    assert.strictEqual(row.feedback, null, "no staff note for a draft that will never be written");
    assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE work_item_id = ? AND action IN ('redraft_skipped', 'redraft_started', 'redraft_failed')").get(ready).n, 0);
  } finally { Object.assign(SAPDOC, saved); }
});

test("handing a voicemail to a colleague keeps its status and starts no redraft", async () => {
  const id = insertVm({ subject: subj("0499000000"), status: "ready", owner: "Sales(Gouda)" });
  await post(`/item/${id}/owner`, { owner: "Tom", note: "Graag terugbellen" });
  await new Promise((ok) => setTimeout(ok, 20));
  const row = db.prepare("SELECT status, owner FROM work_items WHERE id = ?").get(id);
  assert.strictEqual(row.owner, "Tom");
  assert.strictEqual(row.status, "ready");
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE work_item_id = ? AND action IN ('redraft_started', 'redraft_skipped')").get(id).n, 0);
});

// ================================================================ the rendered page and list
test("page: a repeat voicemail shows the count with linked earlier times, in English and Dutch", async () => {
  const a = insertVm({ subject: subj("+31 499 000 000"), email_text: body("6 okt. 2026 11:57:00") });
  const b = insertVm({ subject: subj("0499000000"), email_text: body("8 okt. 2026 09:36:00") });
  const me = insertVm({ subject: subj("0499000000"), email_text: body("12 okt. 2026 09:00:00"), caller_info: "Caller number 0499000000, no SAP match" });
  LANG = "en";
  let html = await get(`/item/${me}`);
  assert.match(html, new RegExp(`3rd voicemail from this number in 14 days\\. Earlier: <a class="wb-link" href="[^"]*/item/${a}">Tue 6 Oct 11:57</a>, <a class="wb-link" href="[^"]*/item/${b}">Thu 8 Oct 09:36</a>`));
  LANG = "nl";
  html = await get(`/item/${me}`);
  assert.match(html, /3e voicemail van dit nummer in 14 dagen\. Eerder: <a [^>]*>di 6 okt 11:57<\/a>, <a [^>]*>do 8 okt 09:36<\/a>/);
  LANG = "en";
  html = await get(`/item/${a}`);
  assert.doesNotMatch(html, /voicemail from this number/, "the first one has no count line");
});

test("list: the voicemail row carries the Nx tag from 2, other rows none", async () => {
  const html = await get("/queue?show=open&scope=all&mailbox=all");
  assert.match(html, /data-tone="neutral" title="3 voicemails from this number in 14 days">3x<\/span>/);
  assert.match(html, />2x<\/span>/);
  assert.doesNotMatch(html, />1x<\/span>/);
});

test("page: the caller number is a tel: link, shown exactly as before", async () => {
  const id = insertVm({ subject: subj("0499000000"), email_text: body("1 okt. 2026 09:00:00"), caller_info: "Caller number 0499000000, no SAP match" });
  const html = await get(`/item/${id}`);
  assert.match(html, /<p class="ax-caller">Caller number <a class="wb-link" href="tel:0499000000">0499000000<\/a>, no SAP match<\/p>/);
  const hidden = insertVm({ subject: "Voice Message Attached from Anonymous - Anonymous", caller_info: "Caller number not shown by KPN" });
  assert.match(await get(`/item/${hidden}`), /<p class="ax-caller">Caller number not shown by KPN<\/p>/);
});

test("page: a voicemail has no reply box, draft or documents panel, open or closed; a normal email has all three", async () => {
  const open = insertVm({ subject: subj("0499000000"), email_text: body("2 okt. 2026 09:00:00"), caller_info: "Caller number 0499000000, no SAP match" });
  const closed = insertVm({ subject: subj("0499000000"), email_text: body("3 okt. 2026 09:00:00"), status: "done" });
  const mail = insert({ status: "ready", doc_suggestions_json: "[]" });
  for (const id of [open, closed, mail]) db.prepare("INSERT INTO drafts (work_item_id, version, is_interim, body) VALUES (?, 1, 0, 'Beste klant, testtekst A2.')").run(id);
  for (const id of [open, closed]) {
    const html = await get(`/item/${id}`);
    assert.doesNotMatch(html, /id="replybox"|class="wb-card ax-reply"/, "no reply box");
    assert.doesNotMatch(html, /testtekst A2|id="ai_seed"|value="redraft"/, "no AI draft, no redraft");
    assert.doesNotMatch(html, /id="ax-doc"|data-overlay="ax-doc"/, "no documents panel");
    assert.match(html, /class="wb-card ax-mail"/, "the message card stays");
  }
  const openHtml = await get(`/item/${open}`);
  assert.match(openHtml, /value="phone"/, "Resolved by phone stays");
  assert.match(openHtml, /value="done"/, "Mark done stays");
  assert.match(openHtml, /data-menu="owner"/, "assigning stays");
  const html = await get(`/item/${mail}`);
  assert.match(html, /id="replybox"/);
  assert.match(html, /testtekst A2/);
  assert.match(html, /id="ax-doc"/);
});

test("page: open issues for the caller's card, linked, with owner and status", async () => {
  const me = insertVm({ subject: subj("0100000000"), email_text: body("11 okt. 2026 09:00:00"), caller_card: "C99999", caller_info: "Caller: Voorbeeld BV (C99999), 0100000000" });
  const openOne = insert({ subject: "Kapotte remklauw", intent: "return_complaint", cust_card: "C99999", status: "ready", owner: "Jack" });
  const closedOne = insert({ subject: "Verkeerd onderdeel", intent: "return_complaint", cust_card: "C99999", status: "done", updated_at: sqlTime(ago(3)) });
  insert({ subject: "Oude klacht", intent: "return_complaint", cust_card: "C99999", status: "done", updated_at: sqlTime(ago(45)) });
  insert({ subject: "Ander klant", intent: "return_complaint", cust_card: "C88888", status: "new" });
  const html = await get(`/item/${me}`);
  assert.match(html, /Open issues with this customer/);
  assert.match(html, new RegExp(`<a class="wb-link" href="[^"]*/item/${openOne}">Kapotte remklauw</a> · [^<]+ · Jack · `));
  assert.match(html, new RegExp(`/item/${closedOne}">Verkeerd onderdeel</a>.*?>closed<`));
  assert.ok(html.indexOf("Kapotte remklauw") < html.indexOf("Verkeerd onderdeel"), "open first");
  assert.doesNotMatch(html, /Oude klacht|Ander klant/);
});

test("page: the supplier panel for a supplier-only caller; a customer hit means no panel", async () => {
  const saved = { findCustomersByPhone: C.findCustomersByPhone, supplierSheet: C.supplierSheet };
  let hits = [{ CardCode: "S99999", CardName: "Voorbeeld Parts Ltd", CardType: "S", frozen: false, contacts: [] }];
  C.findCustomersByPhone = async () => hits;
  C.supplierSheet = async (cc) => ({ cardCode: cc, cardName: "Voorbeeld Parts Ltd", email: "creditcontrol@example.co.uk",
    contacts: [{ name: "Pat Example", position: "Sales", email: "a2-test-only@gmail.com" }],
    orders: [{ DocNum: 7001, DocDueDate: "2026-01-05", DocTotal: 1200, DocTotalFC: 1000, DocCur: "GBP" },
      { DocNum: 7002, DocDueDate: "2099-01-05", DocTotal: 50, DocTotalFC: 0, DocCur: "EUR" }],
    openCount: 9 });
  try {
    insert({ sender_email: "psp@example.co.uk", sender_name: "Voorbeeld Parts Ltd", subject: "WARP 12345 claim", rule_id: "warranty_warp", intent: "other", status: "new" });
    const me = insertVm({ subject: subj("0499000000"), email_text: body("4 okt. 2026 09:00:00"),
      caller_info: "Caller number 0499000000: Voorbeeld Parts Ltd (S99999), a supplier, not a customer" });
    const html = await get(`/item/${me}`);
    assert.match(html, /Voorbeeld Parts Ltd · S99999 <span[^>]*>Supplier<\/span>/);
    assert.match(html, /People we know at this supplier/);
    assert.match(html, /<li>Pat Example · Sales<\/li>/);
    assert.match(html, /<li>psp@example\.co\.uk · last email /, "a sender named like the supplier shows as the address");
    assert.match(html, /PO 7001 · £1,000\.00 · due 5 Jan 2026 <span[^>]*>overdue<\/span>/);
    assert.match(html, /PO 7002 · €50\.00 · due 5 Jan 2099<\/li>/);
    assert.match(html, /9 open purchase orders in total/);
    assert.match(html, /Open warranty items with this supplier.*WARP 12345 claim/s);
    assert.doesNotMatch(html, /Not a SAP customer/);

    hits = [...hits, { CardCode: "C99999", CardName: "Voorbeeld BV", CardType: "C", frozen: false, contacts: [] }];
    const html2 = await get(`/item/${me}`);
    assert.doesNotMatch(html2, /People we know at this supplier|Open purchase orders/);

    C.supplierSheet = async () => { throw new Error("SAP down"); };
    hits = hits.slice(0, 1);
    const html3 = await get(`/item/${me}`);
    assert.match(html3, /Not a SAP customer/, "a SAP failure hides the panel, never the page");
  } finally { Object.assign(C, saved); }
});

// ================================================================ wording
test("every new label exists in English and Dutch, and nothing new carries an em or en dash", async () => {
  const keys = Object.keys(UI.STRINGS.en).filter((k) => /^vm_/.test(k));
  assert.ok(keys.length >= 15);
  for (const k of keys) {
    assert.ok(UI.STRINGS.nl[k], `nl ${k}`);
    assert.doesNotMatch(UI.STRINGS.en[k] + UI.STRINGS.nl[k], DASHES, k);
  }
  for (const f of ["voicemail-sheet.js", "voicemail-a2.test.js"]) assert.doesNotMatch(fs.readFileSync(path.join(__dirname, f), "utf8"), DASHES, f);
  const ids = db.prepare("SELECT id FROM work_items WHERE sender_email = ?").all(VM_FROM).map((r) => r.id);
  for (const lang of ["en", "nl"]) {
    LANG = lang;
    for (const id of ids) {
      const html = await get(`/item/${id}`);
      const head = html.slice(html.indexOf('class="ax-head"'), html.indexOf('class="ax-pair"'));
      assert.doesNotMatch(head, DASHES, `item ${id} ${lang}`);
    }
  }
  LANG = "en";
});
