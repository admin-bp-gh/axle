// search.test.js - the one server-side search (round 2, request 12): the trigram index finds words
// anywhere (bodies, part-number fragments, recipients, attachment names, our sent replies, the
// customer), words are ANDed, short words use the short fields, #id and bare ids match the id, the
// typed text cannot break the FTS syntax, snippets carry match positions and no HTML, and with the
// index unavailable the LIKE fallback still answers.
// SAFETY: AXLE_DB is a throwaway file.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "axle-search-"));
process.env.AXLE_DB = path.join(tmp, "test.db");
const { db } = require("./db.js");
const S = require("./search.js");

const item = (o) => Number(db.prepare(
  `INSERT INTO work_items (mailbox, conversation_key, sender_email, sender_name, subject, summary, status, owner, email_text, updated_at, compose_customer, origin)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
).run(o.mailbox || "info", "k" + Math.random(), o.from, o.name || null, o.subject || "", o.summary || "", o.status || "new", o.owner || "Sales(Gouda)",
  o.text || "", o.updated || "2026-10-01 10:00:00", o.customer ? JSON.stringify(o.customer) : null, o.customer ? "compose" : "inbound").lastInsertRowid);

const A = item({ from: "anna@klant.test", name: "Anna Klant", subject: "Brake discs", summary: "Asks for front discs", text: "Old body", updated: "2026-10-05 10:00:00" });
db.prepare("INSERT INTO messages (work_item_id, mailbox, graph_id, from_name, from_addr, to_json, cc_json, received, body) VALUES (?, 'info', 'g1', 'Anna Klant', 'anna@klant.test', ?, ?, '2026-10-05T09:00:00Z', ?)")
  .run(A, JSON.stringify([{ name: "Info", address: "info@budget-parts.test" }]), JSON.stringify([{ name: "Piet", address: "piet.werkplaats@garage.test" }]),
    "Hallo, ik zoek remschijven voor mijn Defender, onderdeelnummer STC1234ZZ. Mvg Anna");
const mid = db.prepare("SELECT id FROM messages WHERE work_item_id = ?").get(A).id;
db.prepare("INSERT INTO message_attachments (message_id, work_item_id, graph_att_id, name, size) VALUES (?, ?, 'x', 'kenteken-foto.jpg', 1)").run(mid, A);
db.prepare("INSERT INTO sends (work_item_id, draft_id, to_addr, body_sha256, status, sent_by, body, attachments_json) VALUES (?, 1, 'anna@klant.test', 'h', 'sent', 'u', ?, ?)")
  .run(A, "Wij hebben de schijven op voorraad, levering morgen.", JSON.stringify([{ name: "offerte-226108.pdf" }]));
const B = item({ from: "bert@other.test", name: "Bert", subject: "Where is my order", summary: "Tracking", status: "done", updated: "2026-10-06 10:00:00", text: "Parcel not arrived, order ab 12" });
const Cc = item({ from: "info@budget-parts.test", name: "Müller GmbH", subject: "Quote", customer: { name: "Müller GmbH", cardCode: "K130312" }, status: "done", owner: "Drachten", mailbox: "drachten", updated: "2026-10-04 10:00:00" });
const D = item({ from: 'quote"r@x.test', subject: 'Odd (subject): "AND" OR * - NEAR', text: "nothing", updated: "2026-10-03 10:00:00" });

const ids = (r) => r.rows.map((w) => w.id);
const find = (q, o = {}) => S.searchItems({ q, show: o.show || "open", scope: o.scope || "all", owner: "Sales(Gouda)", mailbox: o.mailbox || "all", counts: o.counts });
const both = (q) => [...ids(find(q)), ...ids(find(q, { show: "history" }))].sort((x, y) => x - y);

test("the index fills at start-up and the trigram table exists here", () => {
  assert.strictEqual(S.state.ftsOk, true);
  const r = S.fillIndex();
  assert.strictEqual(r.indexed, 4);
  assert.strictEqual(S.fillIndex().indexed, 0);   // nothing behind
});

test("a word that only occurs in a stored message body", () => assert.deepStrictEqual(both("remschijven"), [A]));
test("part of a part number", () => assert.deepStrictEqual(both("c1234z"), [A]));
test("a cc recipient address, in part", () => assert.deepStrictEqual(both("werkplaats@garage"), [A]));
test("an attachment name, theirs and ours", () => {
  assert.deepStrictEqual(both("kenteken"), [A]);
  assert.deepStrictEqual(both("offerte-2261"), [A]);
});
test("our sent reply", () => assert.deepStrictEqual(both("voorraad"), [A]));
test("the SAP customer, accents folded", () => {
  assert.deepStrictEqual(both("muller"), [Cc]);
  assert.deepStrictEqual(both("K130312"), [Cc]);
});
test("words are ANDed", () => {
  assert.deepStrictEqual(both("remschijven voorraad"), [A]);
  assert.deepStrictEqual(both("remschijven parcel"), []);
});
test("#id and a bare id match the id", () => {
  assert.deepStrictEqual(both("#" + B), [B]);
  assert.deepStrictEqual(both(String(B)), [B]);
});
test("words under three characters use the short fields only", () => {
  assert.deepStrictEqual(both("ab"), []);                        // only in B's body
  assert.deepStrictEqual(both("Be"), [B]);                       // sender name
});
test("the typed text cannot break the query", () => {
  for (const q of ['"', '"AND"', "*", "-", ":", "(", ")", 'subject): "AND', "NEAR(a b)", "a:b", "OR", "^x", "'", "\\", "%_"]) {
    assert.doesNotThrow(() => both(q), q);
  }
  assert.deepStrictEqual(both('"AND"'), [D]);
  assert.deepStrictEqual(both("(subject):"), [D]);
  assert.strictEqual(S.ftsQuote('a"b'), '"a""b"');
});
test("control characters in the typed text are white space, in FTS and in LIKE", () => {
  for (const q of ["a\u0000b", "remschijven\u0000", "\u0000", "rem\u0007schijven\u001f", "\u007f#" + A]) {
    assert.doesNotThrow(() => both(q), JSON.stringify(q));
    assert.ok(!S.termConds(q).params.some((p) => /[\u0000-\u001f\u007f]/.test(String(p))), JSON.stringify(q));
    assert.ok(!S.termConds(q, false).params.some((p) => /[\u0000-\u001f\u007f]/.test(String(p))), JSON.stringify(q));
  }
  assert.deepStrictEqual(both("remschijven\u0000"), [A]);
  assert.deepStrictEqual(S.words("a\u0000bcd\tx"), ["a", "bcd", "x"]);
});
test("a snippet never cuts an emoji in half, and its ranges still point at the word", () => {
  const E = "\u{1F600}";
  // The window would start at 60 - 50 = 10, the second half of the first emoji, and end at
  // 9 + 160 = 169, the second half of the last one.
  const body = "a".repeat(9) + E + "b".repeat(49) + "zoekwoord" + "c".repeat(99) + E + "d".repeat(20);
  const m = S.snippet({ body }, "zoekwoord", 1);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(m.text), "no lone surrogate");
  assert.ok(m.text.startsWith("…" + E) && m.text.endsWith(E + "…"), m.text);
  assert.deepStrictEqual(m.ranges.map(([s, e]) => m.text.slice(s, e)), ["zoekwoord"]);
});
test("a snippet cuts on grapheme boundaries: emoji families, flags, skin tones stay whole", () => {
  const seg = new Intl.Segmenter("en", { granularity: "grapheme" });
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const e of ["\u{1F600}", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}", "\u{1F1F3}\u{1F1F1}", "\u{1F44D}\u{1F3FD}", "\u2764\uFE0F", "1\uFE0F\u20E3"]) {
    for (let pad = 30; pad < 75; pad++) {
      const body = "x".repeat(pad) + e.repeat(40) + " ZOEKWOORD tail " + e.repeat(120);
      const m = S.snippet({ body }, "zoekwoord", 1);
      const inner = m.text.replace(/^…|…$/g, "");
      const g = [...seg.segment(inner)].map((x) => x.segment);
      assert.ok(!lone.test(m.text), "no lone surrogate");
      assert.ok([g[0], g[g.length - 1]].every((x) => x === e || x === "x" || x === " " || /^[a-z]$/i.test(x)), `whole clusters at both edges (${JSON.stringify(e)}, pad ${pad})`);
      assert.deepStrictEqual(m.ranges.map(([a, z]) => m.text.slice(a, z)), ["ZOEKWOORD"]);
    }
  }
});
test("without Intl.Segmenter the cut is still surrogate-safe", () => {
  const seg = Intl.Segmenter, path = require.resolve("./search.js");
  delete require.cache[path];
  Intl.Segmenter = undefined;
  try {
    const S2 = require("./search.js"), E = "\u{1F600}";
    const m = S2.snippet({ body: "a".repeat(9) + E + "b".repeat(49) + "zoekwoord" + "c".repeat(99) + E + "d".repeat(20) }, "zoekwoord", 1);
    assert.ok(m.text.startsWith("…" + E) && m.text.endsWith(E + "…"), m.text);
    assert.deepStrictEqual(m.ranges.map(([a, z]) => m.text.slice(a, z)), ["zoekwoord"]);
  } finally { Intl.Segmenter = seg; delete require.cache[path]; }
});
test("filters: open or history, mine or all, mailbox", () => {
  assert.deepStrictEqual(ids(find("muller", { show: "history" })), [Cc]);
  assert.deepStrictEqual(ids(find("muller", { show: "history", scope: "mine" })), []);
  assert.deepStrictEqual(ids(find("muller", { show: "history", mailbox: "info" })), []);
  const c = find("muller", { scope: "mine", counts: true }).counts;
  assert.deepStrictEqual(c, { open: 0, history: 0, allOpen: 0, allHistory: 1 });
});
test("newest updated first, paged", () => {
  const all = S.searchItems({ q: "test", show: "history", scope: "all", mailbox: "all", pageSize: 1, page: 1 });
  assert.strictEqual(all.total, 2);
  assert.deepStrictEqual(ids(all), [B]);
  assert.strictEqual(all.hasMore, true);
  assert.deepStrictEqual(ids(S.searchItems({ q: "test", show: "history", scope: "all", mailbox: "all", pageSize: 1, page: 2 })), [Cc]);
});
test("the snippet says where it matched, with positions, as plain text", () => {
  const m = find("STC1234 anna").rows[0].match;
  assert.strictEqual(m.field, "body");
  for (const [s, e] of m.ranges) assert.match(m.text.slice(s, e).toLowerCase(), /^(stc1234|anna)$/);
  assert.strictEqual(m.ranges.length, 2);
  const id = find("#" + B, { show: "history" }).rows[0].match;
  assert.deepStrictEqual(id, { field: "id", text: "#" + B, ranges: [[0, String(B).length + 1]] });
});
test("reindexItem follows a change", () => {
  db.prepare("UPDATE work_items SET summary = 'zwenkwiel' WHERE id = ?").run(B);
  assert.deepStrictEqual(both("zwenkwiel"), []);
  S.reindexItem(B);
  assert.deepStrictEqual(both("zwenkwiel"), [B]);
});
test("the customer seen on view is remembered and searchable", () => {
  S.rememberCustomer(A, "K127177", "BV Newcraft");
  assert.deepStrictEqual(both("newcraft"), [A]);
});

test("fallback: the index cannot be created, LIKE answers", () => {
  const orig = console.error;
  const lines = [];
  console.error = (l) => lines.push(l);
  try { assert.strictEqual(S.init("forced failure"), false); } finally { console.error = orig; }
  assert.strictEqual(lines.length, 1);
  assert.match(lines[0], /forced failure/);
  const r = find("Old body");
  assert.strictEqual(r.mode, "like");
  assert.deepStrictEqual(both("old"), [A]);                         // email_text
  assert.deepStrictEqual(both("Asks front"), [A]);                  // summary
  assert.deepStrictEqual(both("remschijven"), []);                  // stored bodies are index-only
  assert.deepStrictEqual(both(String(B)), [B]);
  assert.doesNotThrow(() => both('"AND" % _ \\'));
  const t = S.termConds("ab xyz #5", false);
  assert.strictEqual(t.conds.length, 3);
  assert.ok(t.conds.every((c) => !/MATCH/.test(c)));
  S.reindexItem(A);                                                 // a no-op, not an error
  assert.strictEqual(S.init(), true);
});
