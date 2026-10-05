"use strict";
// caller-match.test.js: the voicemail caller lookup and card choice (connectors.js, ingest.js, db.js).
//
// Exists because of the 2026-10-01 finding: Axle scanned the BODY of KPN voicemail emails for
// the caller's number, but KPN puts it in the SUBJECT ("Voice Message Attached from 0612345678
// - 0612345678"). The SAP lookup therefore never ran: 0 matches on 155 voicemails. These tests
// pin the subject-first extraction, the number normalisation, the exact-match rule for
// international numbers, the all-hits (never silently pick one) behaviour, the confident-guess
// rules and caller-line wording approved for Change A (sections A2, A3), the "people we know"
// merge (A5), and that a new voicemail never leaves an earlier voicemail's card behind.
// No live SAP: the pool is a fake. Run: node --test caller-match.test.js
//
// SAFETY: AXLE_DB is pinned to a throwaway file BEFORE db.js loads, so the live database is never touched.
const fs = require("fs");
const os = require("os");
const path = require("path");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "axle-caller-"));
process.env.AXLE_DB = path.join(tmpDir, "test.db");

const test = require("node:test");
const assert = require("node:assert");
const C = require("./connectors.js");
const { db, setCallerMatch } = require("./db.js");

test.after(() => { try { db.close(); } catch (e) { /* already closed */ } fs.rmSync(tmpDir, { recursive: true, force: true }); });

const NOW = new Date("2026-10-05T12:00:00Z");
const DASHES = /[–—]/;   // en dash, em dash

// --- extraction: subject first, body as fallback ----------------------------------------
test("the caller number comes from the KPN subject line", () => {
  const email = { subject: "Voice Message Attached from 0612345678 - 0612345678", text: "Time: 1 okt. 2026 13:35:18\r\nClick attachment to listen to Voice Message" };
  assert.deepStrictEqual(C.extractCallerNumbers(email), ["0612345678"]);
});

test("a network-supplied name after the dash does not hide the number", () => {
  assert.deepStrictEqual(C.extractCallerNumbers({ subject: "Voice Message Attached from 0850000000 - KPN Zakelijk", text: "" }), ["0850000000"]);
});

test("international callers keep their plus and country code", () => {
  assert.deepStrictEqual(C.extractCallerNumbers({ subject: "Voice Message Attached from +905550000000 - +905550000000", text: "" }), ["+905550000000"]);
});

test("the old body-only behaviour is kept as a fallback", () => {
  assert.deepStrictEqual(C.extractCallerNumbers({ subject: "Voicemail", text: "Caller: +31 6 1234 5678" }), ["+31 6 1234 5678"]);
  assert.deepStrictEqual(C.extractCallerNumbers({ subject: "Voicemail", text: "Click attachment to listen" }), []);
});

// --- normalisation ------------------------------------------------------------------------
test("every Dutch spelling of a mobile number normalises to the same digits", () => {
  for (const s of ["0612345678", "06-12345678", "06 1234 5678", "+31612345678", "+31 6 12345678", "0031612345678", "(06) 12345678"]) {
    assert.strictEqual(C.normalisePhone(s), "31612345678", s);
  }
});

test("a Dutch landline normalises too, and foreign numbers keep their own country code", () => {
  assert.strictEqual(C.normalisePhone("0182-000000"), "31182000000");
  assert.strictEqual(C.normalisePhone("+32 499 00 00 00"), "32499000000");
  assert.strictEqual(C.normalisePhone("0049 170 1234567"), "491701234567");
});

// --- the match rule --------------------------------------------------------------------
test("a Dutch caller matches a stored number in any format, including one without a country code", () => {
  const caller = C.normalisePhone("0612345678");
  for (const stored of ["0612345678", "+31612345678", "0031 6 12345678", "612345678", "6-12345678"]) {
    assert.ok(C.samePhone(caller, stored), stored);
  }
});

test("an international caller only matches the exact number, never a Dutch number with the same tail", () => {
  const belgian = C.normalisePhone("+32499000000");
  assert.ok(C.samePhone(belgian, "0032499000000"));
  assert.ok(C.samePhone(belgian, "+32 499 00 00 00"));
  assert.ok(!C.samePhone(belgian, "0499000000"), "a Dutch 0499... number is not the Belgian caller");
  assert.ok(!C.samePhone(C.normalisePhone("0499000000"), "+32499000000"), "and the reverse");
});

test("empty or rubbish never matches", () => {
  assert.ok(!C.samePhone("", "0612345678"));
  assert.ok(!C.samePhone("31612345678", ""));
  assert.ok(!C.samePhone("31612345678", "n/a"));
});


// --- the lookup, against a fake SAP pool ------------------------------------------------
// The phone query (input p) returns OCRD/OCPR rows; the facts query (inputs c0, c1, ...) returns
// E_Mail and LastOrder per CardCode. facts: { CardCode: { E_Mail, LastOrder } }.
function fakePool(rows, facts = {}) {
  const queries = [];
  return {
    queries,
    request() {
      const inputs = {};
      return {
        input(name, _type, value) { inputs[name] = value; return this; },
        async query(sqlText) {
          queries.push({ sqlText, inputs });
          if (/ORDR/.test(sqlText)) {
            const codes = Object.keys(inputs).filter((k) => /^c\d+$/.test(k)).map((k) => inputs[k]);
            return { recordset: codes.filter((c) => facts[c]).map((c) => ({ CardCode: c, E_Mail: facts[c].E_Mail || null, LastOrder: facts[c].LastOrder || null })) };
          }
          return { recordset: rows(inputs.p) };
        },
      };
    },
  };
}
const card = (CardCode, CardName, Phone1, extra = {}) => ({ CardCode, CardName, CardType: "C", frozenFor: "N", Phone1, Phone2: null, Cellular: null, ContactName: null, ContactTel: null, ...extra });
const vm = (number) => ({ subject: `Voice Message Attached from ${number} - ${number}`, text: "Click attachment to listen to Voice Message" });
const lookup = (email, rows, facts) => { const pool = fakePool(() => rows, facts); return C.lookupCaller(email, { pool, now: NOW }).then((r) => ({ ...r, pool })); };

test("one customer, stored with a country code, is found from a national-format caller", async () => {
  const pool = fakePool((k) => (k === "612345678" ? [card("K100001", "Garage Jansen", "+31 6 12345678")] : []));
  const hits = await C.findCustomersByPhone(["0612345678"], { pool });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].CardCode, "K100001");
  assert.deepStrictEqual(hits[0].contacts, []);
  assert.strictEqual(pool.queries[0].inputs.p, "612345678", "SQL prefilter uses the last 9 digits");
  assert.match(pool.queries[0].sqlText, /T0\.Cellular/, "the mobile field is searched");
  assert.match(pool.queries[0].sqlText, /OCPR/, "contact persons are searched");
});

test("a shared number returns every customer, deduplicated, so nobody is picked silently", async () => {
  const pool = fakePool(() => [
    card("K100001", "Garage Jansen", "0612345678"),
    card("K100002", "J. Jansen", "06-12345678"),
    card("K100001", "Garage Jansen", "0612345678", { ContactName: "Piet Jansen", ContactTel: "0612345678" }),
  ]);
  const hits = await C.findCustomersByPhone(["+31612345678"], { pool });
  assert.deepStrictEqual(hits.map((h) => h.CardCode).sort(), ["K100001", "K100002"]);
  assert.deepStrictEqual(hits.find((h) => h.CardCode === "K100001").contacts, ["Piet Jansen"]);
  assert.strictEqual(await C.findCustomerByPhone(["+31612345678"], { pool }), null, "the single-hit helper refuses to guess");
});

test("a SQL prefilter hit that is not really the same number is dropped", async () => {
  // Belgian caller; SAP holds a Dutch customer whose last 9 digits coincide.
  const pool = fakePool(() => [card("K100009", "Someone Dutch", "0499000000")]);
  assert.deepStrictEqual(await C.findCustomersByPhone(["+32499000000"], { pool }), []);
});

test("no usable number means no SAP query at all", async () => {
  const pool = fakePool(() => { throw new Error("must not be called"); });
  assert.deepStrictEqual(await C.findCustomersByPhone([], { pool }), []);
  assert.deepStrictEqual(await C.findCustomersByPhone(["12345"], { pool }), []);
});

// --- section A2 and A3: every situation, the card chosen and the exact caller line ----------
test("number hidden: no SAP query, no card", async () => {
  const r = await lookup({ subject: "Voice Message Attached from  - Anonymous", text: "Click attachment to listen" }, []);
  assert.strictEqual(r.callerInfo, "Caller number not shown by KPN");
  assert.strictEqual(r.card, null);
  assert.strictEqual(r.pool.queries.length, 0);
});

test("no SAP match: no card", async () => {
  const r = await lookup(vm("06 12345678"), []);
  assert.strictEqual(r.callerInfo, "Caller number 06 12345678, no SAP match");
  assert.strictEqual(r.card, null);
});

test("supplier only: no customer card", async () => {
  const r = await lookup(vm("0850000000"), [card("V10234", "KPN B.V.", "0850000000", { CardType: "S" })]);
  assert.strictEqual(r.callerInfo, "Caller number 0850000000: KPN B.V. (V10234), a supplier, not a customer");
  assert.strictEqual(r.card, null);
});

test("one customer: that card, not a guess, and no extra facts query", async () => {
  const r = await lookup(vm("06 12345678"), [card("C12345", "Jan de Vries", "0612345678")]);
  assert.strictEqual(r.callerInfo, "Caller: Jan de Vries (C12345), 06 12345678");
  assert.strictEqual(r.card, "C12345");
  assert.strictEqual(r.guess, 0);
  assert.strictEqual(r.contact, null);
  assert.strictEqual(r.pool.queries.length, 1);
});

test("number on a contact person: named in the line and kept for the highlight", async () => {
  const r = await lookup(vm("06 12345678"), [card("C12345", "Dekker 4x4", "0201234567", { ContactName: "Piet Jansen", ContactTel: "06-12345678" })]);
  assert.strictEqual(r.callerInfo, "Caller: Piet Jansen at Dekker 4x4 (C12345), 06 12345678");
  assert.strictEqual(r.card, "C12345");
  assert.strictEqual(r.contact, "Piet Jansen");
});

test("a frozen single customer keeps the inactive suffix", async () => {
  const r = await lookup(vm("06 12345678"), [card("C12345", "Jan de Vries", "0612345678", { frozenFor: "Y" })]);
  assert.strictEqual(r.callerInfo, "Caller: Jan de Vries (C12345), inactive, 06 12345678");
  assert.strictEqual(r.card, "C12345");
});

test("same person by name (case and spacing ignored): the record with the latest order", async () => {
  const r = await lookup(vm("06 12345678"),
    [card("C23456", "JAN  DE VRIES ", "0612345678"), card("C12345", "Jan de Vries", "0612345678")],
    { C23456: { LastOrder: "2024-03-01" }, C12345: { LastOrder: "2026-08-14" } });
  assert.strictEqual(r.callerInfo, "Caller: Jan de Vries (C12345), 06 12345678. Same person also on C23456");
  assert.strictEqual(r.card, "C12345");
  assert.strictEqual(r.guess, 0);
});

test("same person by email (different names): the record with the latest order, all other codes listed", async () => {
  const r = await lookup(vm("06 12345678"),
    [card("C12345", "Jan de Vries", "0612345678"), card("C23456", "J. de Vries", "0612345678"), card("C34567", "Vries Auto", "0612345678")],
    { C12345: { E_Mail: "jan@vries.nl", LastOrder: "2026-08-14" }, C23456: { E_Mail: " JAN@vries.nl" }, C34567: { E_Mail: "jan@vries.nl", LastOrder: "2023-01-10" } });
  assert.strictEqual(r.callerInfo, "Caller: Jan de Vries (C12345), 06 12345678. Same person also on C34567, C23456");
  assert.strictEqual(r.card, "C12345");
});

test("blank emails never count as the same email", async () => {
  const r = await lookup(vm("06 12345678"),
    [card("C12345", "Jan de Vries", "0612345678"), card("C23456", "Piet Bos", "0612345678")],
    { C12345: { E_Mail: "" }, C23456: { E_Mail: "" } });
  assert.strictEqual(r.card, null);
});

test("one clear favourite: the only recent buyer, labelled as best guess", async () => {
  const r = await lookup(vm("06 12345678"),
    [card("C23456", "Garage Bos", "0612345678"), card("C12345", "Jan de Vries", "0612345678"), card("C34567", "Piet Smit", "0612345678")],
    { C23456: { LastOrder: "2023-05-02" }, C12345: { LastOrder: "2026-08-14" } });
  assert.strictEqual(r.callerInfo, "Caller number 06 12345678 is on 3 customer records. Best guess: Jan de Vries (C12345), the only one who ordered in the last 12 months. Also: C23456 Garage Bos, C34567 Piet Smit");
  assert.strictEqual(r.card, "C12345");
  assert.strictEqual(r.guess, 1);
});

test("a frozen record is ignored for the best guess", async () => {
  // Both ordered recently, but one is frozen: the other is the only non-frozen recent buyer.
  const r = await lookup(vm("06 12345678"),
    [card("C12345", "Jan de Vries", "0612345678", { frozenFor: "Y" }), card("C23456", "Garage Bos", "0612345678")],
    { C12345: { LastOrder: "2026-09-01" }, C23456: { LastOrder: "2026-07-01" } });
  assert.strictEqual(r.card, "C23456");
  assert.strictEqual(r.guess, 1);
  assert.match(r.callerInfo, /Also: C12345 Jan de Vries, inactive$/);
  // And a frozen record that is the ONLY recent buyer is not a favourite.
  const r2 = await lookup(vm("06 12345678"),
    [card("C12345", "Jan de Vries", "0612345678", { frozenFor: "Y" }), card("C23456", "Garage Bos", "0612345678")],
    { C12345: { LastOrder: "2026-09-01" }, C23456: { LastOrder: "2022-07-01" } });
  assert.strictEqual(r2.card, null);
});

test("no clear favourite: no card, every record listed with its last order", async () => {
  const r = await lookup(vm("06 12345678"),
    [card("C34567", "Piet Smit", "0612345678"), card("C12345", "Jan de Vries", "0612345678"), card("C23456", "Garage Bos", "0612345678"), card("C45678", "Auto Kok", "0612345678")],
    { C12345: { LastOrder: "2026-08-14" }, C23456: { LastOrder: "2023-05-02" }, C45678: { LastOrder: "2026-02-03" } });
  assert.strictEqual(r.callerInfo, "Caller number 06 12345678 is on 4 customer records, check which one: C12345 Jan de Vries (last order Aug 2026), C45678 Auto Kok (last order Feb 2026), C23456 Garage Bos (last order 2023), C34567 Piet Smit (no orders)");
  assert.strictEqual(r.card, null);
  assert.strictEqual(r.guess, 0);
});

test("5 or more records: never a guess, even with one name; 5 latest listed and the rest counted", async () => {
  const rows = ["C1", "C2", "C3", "C4", "C5", "C6", "C7"].map((c) => card(c, "Jan de Vries", "0612345678"));
  const facts = { C7: { LastOrder: "2026-09-30" }, C3: { LastOrder: "2026-01-15" }, C1: { LastOrder: "2020-06-01" } };
  const r = await lookup(vm("06 12345678"), rows, facts);
  assert.strictEqual(r.callerInfo, "Caller number 06 12345678 is on 7 customer records, check which one: C7 Jan de Vries (last order Sep 2026), C3 Jan de Vries (last order Jan 2026), C1 Jan de Vries (last order 2020), C2 Jan de Vries (no orders), C4 Jan de Vries (no orders), and 2 more");
  assert.strictEqual(r.card, null);
});

test("customers and a supplier on one number: the customer rules apply", async () => {
  const r = await lookup(vm("06 12345678"), [card("V10234", "Parts Supplier", "0612345678", { CardType: "S" }), card("C12345", "Jan de Vries", "0612345678")]);
  assert.strictEqual(r.callerInfo, "Caller: Jan de Vries (C12345), 06 12345678");
  assert.strictEqual(r.card, "C12345");
});

test("the 12-month window: an order exactly 12 months ago counts, a day earlier does not", () => {
  const h = (CardCode, LastOrder) => ({ CardCode, CardName: CardCode, CardType: "C", frozen: false, contacts: [], LastOrder, lastOrder: LastOrder });
  assert.strictEqual(C.decideCallerCard([h("C1", "2025-10-05"), h("C2", null)], { now: NOW }).rule, "favourite");
  assert.strictEqual(C.decideCallerCard([h("C1", "2025-10-04"), h("C2", null)], { now: NOW }).rule, "unclear");
});

test("no caller line or card wording contains an em or en dash", async () => {
  const lines = [
    (await lookup({ subject: "Voicemail", text: "" }, [])).callerInfo,
    (await lookup(vm("06 12345678"), [])).callerInfo,
    (await lookup(vm("0850000000"), [card("V1", "S", "0850000000", { CardType: "S" })])).callerInfo,
    (await lookup(vm("06 12345678"), [card("C1", "A", "0612345678", { frozenFor: "Y", ContactName: "P", ContactTel: "0612345678" })])).callerInfo,
    (await lookup(vm("06 12345678"), [card("C1", "A", "0612345678"), card("C2", "A", "0612345678")])).callerInfo,
    (await lookup(vm("06 12345678"), [card("C1", "A", "0612345678"), card("C2", "B", "0612345678")], { C1: { LastOrder: "2026-09-01" } })).callerInfo,
    (await lookup(vm("06 12345678"), [card("C1", "A", "0612345678"), card("C2", "B", "0612345678")])).callerInfo,
    (await lookup(vm("06 12345678"), ["C1", "C2", "C3", "C4", "C5", "C6"].map((c) => card(c, "A", "0612345678")))).callerInfo,
  ];
  for (const l of lines) assert.ok(!DASHES.test(l), l);
});

// --- A5: people we know at this customer ------------------------------------------------
test("people list: matched contact first and highlighted, then emailers newest first, then SAP contacts, deduplicated, at most 6", () => {
  const people = C.callerPeople({
    matched: "Piet Jansen",
    emailers: [{ name: "Anna Bakker", last: "2026-07-01T10:00:00Z" }, { name: "piet  jansen", last: "2026-09-20T10:00:00Z" }, { name: "Kees Vos", last: "2026-09-01T10:00:00Z" }],
    sap: [{ name: "Piet Jansen", position: "Inkoop" }, { name: "Marie Dijk", position: "" }, { name: "A1", position: "" }, { name: "A2", position: "" }, { name: "A3", position: "" }],
  });
  assert.deepStrictEqual(people.map((p) => p.name), ["Piet Jansen", "Kees Vos", "Anna Bakker", "Marie Dijk", "A1", "A2"]);
  assert.strictEqual(people[0].matched, true);
  assert.strictEqual(people[0].position, "Inkoop", "position from SAP joins the matched name");
  assert.strictEqual(people[0].last, "2026-09-20T10:00:00Z", "and so does their latest email");
  assert.ok(people.slice(1).every((p) => !p.matched));
});

test("people list: nothing known gives an empty list, blank names are skipped", () => {
  assert.deepStrictEqual(C.callerPeople({ matched: null, emailers: [], sap: [] }), []);
  assert.deepStrictEqual(C.callerPeople({ matched: " ; ", emailers: [{ name: "  ", last: null }], sap: [{ name: "", position: "x" }] }), []);
});

// --- ingest write: a new voicemail never leaves an earlier voicemail's card behind -----------
test("caller line, card, guess flag and contact are written together and cleared by a no-card match", () => {
  const id = db.prepare("INSERT INTO work_items (mailbox, conversation_key, sender_email, subject) VALUES ('info', ?, 'voicemail@hipservice.nl', 'Voice Message')")
    .run("vm-" + Date.now()).lastInsertRowid;
  const read = () => db.prepare("SELECT caller_info, caller_card, caller_card_guess, caller_contact FROM work_items WHERE id = ?").get(id);

  setCallerMatch(id, { callerInfo: "Caller number 06 12345678 is on 3 customer records. Best guess: ...", card: "C12345", guess: 1, contact: "Piet Jansen" });
  assert.deepStrictEqual({ ...read() }, { caller_info: "Caller number 06 12345678 is on 3 customer records. Best guess: ...", caller_card: "C12345", caller_card_guess: 1, caller_contact: "Piet Jansen" });

  setCallerMatch(id, { callerInfo: "Caller: Jan de Vries (C23456), 06 12345678", card: "C23456", guess: 0, contact: null });
  assert.deepStrictEqual({ ...read() }, { caller_info: "Caller: Jan de Vries (C23456), 06 12345678", caller_card: "C23456", caller_card_guess: 0, caller_contact: null });

  setCallerMatch(id, { callerInfo: "Caller number 06 99999999, no SAP match", card: null, guess: 0, contact: null });
  assert.deepStrictEqual({ ...read() }, { caller_info: "Caller number 06 99999999, no SAP match", caller_card: null, caller_card_guess: 0, caller_contact: null });

  // A guess flag or contact without a card is never stored.
  setCallerMatch(id, { callerInfo: "Caller number not shown by KPN", card: null, guess: 1, contact: "Piet Jansen" });
  assert.deepStrictEqual({ ...read() }, { caller_info: "Caller number not shown by KPN", caller_card: null, caller_card_guess: 0, caller_contact: null });
});

test("ingest uses the single combined write for voicemail items", () => {
  const src = fs.readFileSync(path.join(__dirname, "ingest.js"), "utf8");
  assert.match(src, /callerMatch = await C\.lookupCaller\(email\)/);
  assert.match(src, /if \(callerMatch\) setCallerMatch\(itemId, callerMatch\)/);
  assert.ok(!/SET caller_info = \?/.test(src), "no separate caller_info-only update left in ingest");
});
