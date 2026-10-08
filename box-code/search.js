// search.js - one server-side search over work items (round 2, request 12).
//
// An FTS5 table with the trigram tokenizer, one row per work item (rowid = work item id), so every
// word of three characters or more matches as a substring anywhere: partial words, part numbers
// ("c1234" finds "STC1234"), addresses. Columns: sender, recipients, subject, summary, customer,
// body (every stored customer message; for older items the stored newest body), sent (our sent
// replies) and files (attachment names, theirs and ours).
//
// Kept current by explicit reindexItem(id) calls at every write that changes indexed text (ingest,
// send, recipient, compose, redraft subject, customer seen on view, attachment listing). Not SQL
// triggers: a row is built from four tables and three JSON columns, which a trigger cannot do
// completely, and a trigger set would have to be kept in step with every table it reads.
//
// If this SQLite build cannot create the table, one line is logged, ftsOk stays false and the
// search runs as a LIKE over the short fields plus email_text: the server always starts.
"use strict";
const { db, getMeta, setMeta } = require("./db.js");
const FMT = require("./reply-format.js");   // our sent replies are indexed without their formatting markers

// Bump when what goes into a row changes: start-up then rebuilds the whole index.
const INDEX_VERSION = "1";
const FIELDS = ["sender", "recipients", "subject", "summary", "customer", "body", "sent", "files"];
const MAX_FIELD = 60000;
const MAX_TERMS = 8;
const PAGE_SIZE = 50;

const state = { ftsOk: false, error: null };

// Create the index (idempotent). `fail` lets the test force the fallback.
function init(fail) {
  try {
    if (fail) throw new Error(fail);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS item_search USING fts5(${FIELDS.join(", ")}, tokenize = 'trigram remove_diacritics 1')`);
    state.ftsOk = true;
    state.error = null;
  } catch (e) {
    state.ftsOk = false;
    state.error = String(e.message || e);
    console.error(`Search: full-text index unavailable (${state.error}); searching with LIKE instead`);
  }
  return state.ftsOk;
}

const parseJson = (s, dflt) => { try { return JSON.parse(s || "null") || dflt; } catch (e) { return dflt; } };
const addrs = (list) => (list || []).map((r) => (typeof r === "string" ? r : [r.name, r.address].filter(Boolean).join(" ")));
const join = (parts) => parts.filter(Boolean).map(String).join("\n").slice(0, MAX_FIELD);

// The indexed text of one work item, as { field: text }. Null when the item does not exist.
function itemDoc(id) {
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(id);
  if (!w) return null;
  const msgs = db.prepare("SELECT from_name, from_addr, to_json, cc_json, body FROM messages WHERE work_item_id = ? ORDER BY received, id").all(id);
  const sends = db.prepare("SELECT to_addr, cc_json, body, attachments_json FROM sends WHERE work_item_id = ? AND status = 'sent' ORDER BY id").all(id);
  const files = db.prepare("SELECT name FROM message_attachments WHERE work_item_id = ? ORDER BY id").all(id).map((r) => r.name);
  const cust = [w.cust_name, w.cust_card, w.caller_card, w.caller_info];
  for (const j of [parseJson(w.compose_customer, {}), (parseJson(w.contact_form_json, {}).resolved || {}), (parseJson(w.return_json, {}).resolved || {})]) {
    cust.push(j.name, j.cardName, j.cardCode);
  }
  const bodies = msgs.map((m) => m.body).filter(Boolean);
  return {
    sender: join([w.sender_name, w.sender_email, ...msgs.flatMap((m) => [m.from_name, m.from_addr])]),
    recipients: join([w.recipient, ...parseJson(w.cc_json, []).map((e) => e.addr), ...msgs.flatMap((m) => addrs(parseJson(m.to_json, [])).concat(addrs(parseJson(m.cc_json, [])))),
      ...sends.flatMap((s) => [s.to_addr, ...addrs(parseJson(s.cc_json, []))])]),
    subject: join([w.subject]),
    summary: join([w.summary]),
    customer: join([...new Set(cust.filter(Boolean))]),
    body: join(bodies.length ? bodies : [w.email_text]),
    sent: join(sends.map((s) => FMT.toPlain(s.body))),
    files: join([...files, ...parseJson(w.attachments_json, []).map((a) => a.name), ...sends.flatMap((s) => parseJson(s.attachments_json, []).map((a) => a.name))]),
  };
}

const del = () => db.prepare("DELETE FROM item_search WHERE rowid = ?");
const ins = () => db.prepare(`INSERT INTO item_search (rowid, ${FIELDS.join(", ")}) VALUES (?, ${FIELDS.map(() => "?").join(", ")})`);

// Rebuild one item's row. Call after any write that changes indexed text. Never throws.
function reindexItem(id) {
  if (!state.ftsOk) return;
  try {
    const doc = itemDoc(id);
    del().run(id);
    if (doc) ins().run(id, ...FIELDS.map((f) => doc[f]));
  } catch (e) {
    console.error(`Search: reindex #${id} failed: ${e.message}`);
  }
}

// Start-up: rebuild everything when the index version changed, else add the items it lacks.
// One transaction. Returns { indexed, ms }.
function fillIndex() {
  if (!state.ftsOk) return { indexed: 0, ms: 0 };
  const t0 = Date.now();
  const rebuild = getMeta("search_index_version") !== INDEX_VERSION;
  const ids = db.prepare(rebuild ? "SELECT id FROM work_items"
    : "SELECT id FROM work_items WHERE id NOT IN (SELECT rowid FROM item_search)").all().map((r) => r.id);
  if (rebuild || ids.length) {
    db.exec("BEGIN");
    try {
      if (rebuild) db.exec("DELETE FROM item_search");
      const d = del(), i = ins();
      for (const id of ids) {
        const doc = itemDoc(id);
        d.run(id);
        if (doc) i.run(id, ...FIELDS.map((f) => doc[f]));
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    if (rebuild) setMeta("search_index_version", INDEX_VERSION);
  }
  return { indexed: ids.length, ms: Date.now() - t0 };
}

// --- The query --------------------------------------------------------------------------------------

const likeArg = (s) => "%" + String(s).replace(/[\\%_]/g, (c) => "\\" + c) + "%";
const SHORT = ["w.sender_name", "w.sender_email", "w.subject", "w.summary", "('#' || w.id)"];
const likeAny = (cols) => "(" + cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(" OR ") + ")";

// A typed word as an FTS5 string: double quotes doubled, the whole wrapped in quotes, so quotes,
// asterisks, hyphens, colons, parentheses and the words AND, OR, NOT, NEAR are all plain text.
const ftsQuote = (word) => `"${String(word).replace(/"/g, '""')}"`;

// The typed text as words: control characters (a NUL ends an FTS5 string early) count as white
// space; whitespace-separated, at most MAX_TERMS, empty ones dropped.
const words = (q) => String(q || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, MAX_TERMS);

// SQL conditions (ANDed) and parameters for the typed text, over work_items aliased `w`.
//  #123        -> the id
//  123 (bare)  -> the id, or the number as text
//  under 3     -> LIKE on sender name and address, subject, summary and #id
//  otherwise   -> the FTS index (substring anywhere), or with ftsOk false a LIKE over the short
//                 fields plus email_text
function termConds(q, ftsOk = state.ftsOk) {
  const conds = [], params = [];
  const text = (word) => {
    if (ftsOk) { params.push(ftsQuote(word)); return "w.id IN (SELECT rowid FROM item_search WHERE item_search MATCH ?)"; }
    const cols = [...SHORT, "w.email_text"];
    params.push(...cols.map(() => likeArg(word)));
    return likeAny(cols);
  };
  const short = (word) => { params.push(...SHORT.map(() => likeArg(word))); return likeAny(SHORT); };
  for (const word of words(q)) {
    const hash = /^#(\d+)$/.exec(word);
    if (hash) { conds.push("w.id = ?"); params.push(Number(hash[1])); continue; }
    if (/^\d+$/.test(word)) {
      params.push(Number(word));
      conds.push(`(w.id = ? OR ${[...word].length < 3 ? short(word) : text(word)})`);
      continue;
    }
    conds.push([...word].length < 3 ? short(word) : text(word));
  }
  return { conds, params };
}

// The list part of the filter (the same filters the queue has today).
function baseConds({ show, scope, owner, mailbox }) {
  const conds = [show === "history" ? "w.status IN ('done','archived')" : "w.status NOT IN ('done','archived')"];
  const params = [];
  if (mailbox && mailbox !== "all") { conds.push("w.mailbox = ?"); params.push(mailbox); }
  if (scope === "mine") { conds.push("w.owner = ?"); params.push(owner || ""); }
  return { conds, params };
}

// Lower-case and without accents, one character for one, so positions found in the folded text
// are positions in the original.
const fold = (s) => String(s).split("").map((c) => (c.normalize("NFD")[0] || c).toLowerCase()[0] || c).join("");

// Where the words matched in one item, for the row's snippet: the field with the most matched
// words (ties in FIELD order of usefulness), a window of about 160 characters around the first hit,
// and every hit inside that window as [start, end) positions in `text`. Plain text, never HTML.
const GRAPHEMES = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;
const SNIPPET_ORDER = ["body", "sent", "files", "recipients", "customer", "summary", "subject", "sender"];
function snippet(doc, q, id) {
  const ws = matchWords(q);
  let best = null;
  for (const field of SNIPPET_ORDER) {
    const text = String(doc[field] || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const f = fold(text);
    const hits = ws.filter((x) => f.includes(x));
    if (hits.length && (!best || hits.length > best.hits.length)) best = { field, text, f, hits };
  }
  if (!best) {
    return words(q).some((x) => x.replace(/^#/, "") === String(id)) ? { field: "id", text: `#${id}`, ranges: [[0, String(id).length + 1]] } : null;
  }
  const first = Math.min(...best.hits.map((x) => best.f.indexOf(x)));
  let from = Math.max(0, first - 50);
  let to = Math.min(best.text.length, from + 160);
  // The cut never splits a character as the reader sees it: on grapheme boundaries where the
  // engine has Intl.Segmenter (an emoji family, a flag, a skin tone stays whole), else at least
  // never inside a surrogate pair. from steps back to the start of its character, to forward to
  // the end of its.
  if (GRAPHEMES) {
    const segs = GRAPHEMES.segment(best.text);
    if (from > 0) from = segs.containing(from).index;
    if (to < best.text.length) { const g = segs.containing(to); if (g.index < to) to = g.index + g.segment.length; }
  } else {
    const low = (i) => /[\uDC00-\uDFFF]/.test(best.text[i] || "");
    if (from > 0 && low(from)) from--;
    if (to < best.text.length && low(to)) to++;
  }
  const text = (from > 0 ? "…" : "") + best.text.slice(from, to) + (to < best.text.length ? "…" : "");
  return { field: best.field, text, ranges: hitRanges(text, best.hits) };
}

// The typed words a snippet or a highlight looks for: folded, "#id" left out, and the short ones
// only when no word has three characters or more (as the query matches them).
function matchWords(q) {
  const typed = words(q).filter((x) => !/^#\d+$/.test(x)).map(fold);
  const long = typed.filter((x) => x.length >= 3);
  return long.length ? long : typed;
}

// Every place one of the (folded) words occurs in text, as sorted, merged [start, end) positions.
function hitRanges(text, ws) {
  const f = fold(text), ranges = [];
  for (const x of ws) for (let i = f.indexOf(x); i !== -1; i = f.indexOf(x, i + x.length)) ranges.push([i, i + x.length]);
  ranges.sort((a, b) => a[0] - b[0]);
  return ranges.reduce((out, r) => {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push(r);
    return out;
  }, []);
}

// The search the screens call. opts:
//   q        typed text
//   show     'open' | 'history'
//   scope    'mine' | 'all';  owner: the user's owner label (for mine)
//   mailbox  'all' | 'info' | 'drachten'
//   page     1-based; pageSize (default 50)
//   counts   true to also count the same search in the other lists
// Returns { rows, total, page, hasMore, counts, mode }:
//   rows     work_items rows (SELECT w.*), newest updated first, each with `match`:
//            { field, text, ranges: [[start, end], ...] } or null (see snippet)
//   counts   when asked: { open, history, allOpen, allHistory } for the same text and mailbox
//            (open/history under the given scope, allOpen/allHistory under scope all)
//   mode     'fts' | 'like'
function searchItems(opts) {
  const pageSize = opts.pageSize || PAGE_SIZE;
  const page = Math.max(1, parseInt(opts.page, 10) || 1);
  const t = termConds(opts.q);
  const where = (o) => {
    const b = baseConds(o);
    return { sql: [...b.conds, ...t.conds].join(" AND "), params: [...b.params, ...t.params] };
  };
  const cur = where(opts);
  const rows = db.prepare(`SELECT w.* FROM work_items w WHERE ${cur.sql} ORDER BY w.updated_at DESC, w.id DESC LIMIT ? OFFSET ?`)
    .all(...cur.params, pageSize, (page - 1) * pageSize);
  const count = (o) => { const x = where(o); return db.prepare(`SELECT COUNT(*) AS n FROM work_items w WHERE ${x.sql}`).get(...x.params).n; };
  const total = count(opts);
  for (const w of rows) w.match = words(opts.q).length ? snippet(docFor(w), opts.q, w.id) : null;
  const out = { rows, total, page, hasMore: (page - 1) * pageSize + rows.length < total, mode: state.ftsOk ? "fts" : "like" };
  if (opts.counts) {
    out.counts = {
      open: count({ ...opts, show: "open" }), history: count({ ...opts, show: "history" }),
      allOpen: count({ ...opts, show: "open", scope: "all" }), allHistory: count({ ...opts, show: "history", scope: "all" }),
    };
  }
  return out;
}

// The text a row's snippet is cut from: the index row, or in LIKE mode the item's own fields.
function docFor(w) {
  if (state.ftsOk) {
    const r = db.prepare(`SELECT ${FIELDS.join(", ")} FROM item_search WHERE rowid = ?`).get(w.id);
    if (r) return r;
  }
  return { sender: [w.sender_name, w.sender_email].filter(Boolean).join(" "), subject: w.subject, summary: w.summary, body: w.email_text };
}

// The SAP customer the item view resolved (live, at view time), kept on the item so search finds
// it without a SAP call. Reindexes only when it changed.
function rememberCustomer(id, cardCode, cardName) {
  const r = db.prepare("UPDATE work_items SET cust_card = ?, cust_name = ? WHERE id = ? AND (cust_card IS NOT ? OR cust_name IS NOT ?)")
    .run(cardCode || null, cardName || null, id, cardCode || null, cardName || null);
  if (r.changes) reindexItem(id);
}

init();

module.exports = { state, init, itemDoc, reindexItem, fillIndex, termConds, ftsQuote, words, matchWords, hitRanges, snippet, searchItems, rememberCustomer, FIELDS };
