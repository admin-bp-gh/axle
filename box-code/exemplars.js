// exemplars.js - style exemplars for the drafting prompt (P2.5/P2.6, 2026-10-04).
//
// Every send keeps the AI draft and the text a salesperson actually sent (sends.body,
// sends.source_draft_id). This module picks the closest real sent replies for a new item (same
// intent, same language, same mailbox first) so the engine can show the model how our team
// actually writes. Only inbound replies of a sensible length qualify, which drops acknowledgements,
// carrier claims and runaway edge cases.
//
// Filtered 2026-10-10 (learning loop, draft review section 7). Ranking edited sends first pulled in
// rushed edits with typos, and a send carrying the Gouda drop-box lock code was eligible as an
// example for other customers. Now:
//   * a send containing an access code, an IBAN other than ours, or a phone number other than our
//     two branches never qualifies (sensitive());
//   * a send qualifies only when its reply went out from Axle's FIRST draft for that turn, with no
//     redraft and under 20 % edited (turnFacts(): the same turn the adoption dashboard's
//     first-draft acceptance uses; the edit size here is counted in words, cheap enough to run on
//     every draft, where the dashboard counts characters);
//   * ranking: same mailbox, then the owners' sends (Brad and Vera, users.role 'admin'; Brad's
//     Gate 1 answer), then unchanged before lightly edited, then newest.
//
// Exemplars shape TONE only. The engine's instruction forbids reusing their facts; every fact
// in a new draft still traces to a tool result. Off switch: AXLE_EXEMPLARS=0.

const FMT = require("./reply-format.js");

const ENABLED = process.env.AXLE_EXEMPLARS !== "0";
const DEFAULT_N = Number(process.env.AXLE_EXEMPLARS_N) || 3;
const MIN_LEN = 200;
const MAX_LEN = 2500;
const POOL = 120;             // candidates per query before filtering and ranking in JS
const MIN_SIM = 0.80;         // under 20 % edited
const UNCHANGED = 0.97;       // the dashboard's "unchanged" bucket

// ---- what may never be shown as an example ------------------------------------------------
// Ours: business-knowledge.md. Phone numbers in national form (country code and leading 0 off).
const OUR_IBAN = "NL06RABO0325938571";
const OUR_PHONES = ["182698939", "512539460"];   // Gouda, Drachten
// An access code: a lock, gate, door or drop-box code followed by its digits. Narrow on purpose:
// "part code 123456" and "pin for a 200 TDI" are ordinary replies.
const ACCESS_CODE = new RegExp(
  "(?:\\b(?:slotcode|cijferslot|pincode|toegangscode|deurcode|poortcode|kluiscode|boxcode)\\b" +
  "|\\b(?:gate|door|lock|box|access|entry)\\s?code\\b" +
  "|\\bcode\\s+(?:of|for|to|van|voor|op)\\s+(?:the|het|de|onze|our)?\\s*(?:lock|slot|kluis|afhaalbak|drop\\s?box|lock\\s?box|gate|poort|deur|door|box)\\b" +
  "|\\b(?:kluis|afhaalbak|drop\\s?box|lock\\s?box)\\b[^\\n]{0,80}?\\bcode\\b)[^\\d\\n]{0,25}\\d{3,8}\\b", "i");
const IBAN = /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,3})?\b/g;
const PHONE = /(?<![\w/#.-])(?:\+|00|0)\d[\d \-()./]{6,16}\d(?![\w/])/g;

// The reason a text may not be an example ('access_code' | 'iban' | 'phone'), or null.
function sensitive(text) {
  const t = String(text || "");
  if (ACCESS_CODE.test(t)) return "access_code";
  // 15 characters at least (the shortest IBAN), which also drops PostNL barcodes (LA123456789NL).
  const ibans = (t.match(IBAN) || []).map((x) => x.replace(/\s/g, "")).filter((x) => x.length >= 15);
  if (ibans.some((x) => x !== OUR_IBAN)) return "iban";
  for (const m of t.replace(IBAN, " ").match(PHONE) || []) {
    const d = m.replace(/\D/g, "");
    if (d.length < 9 || d.length > 13) continue;
    if (!OUR_PHONES.includes(d.replace(/^(00)?31/, "").replace(/^0/, ""))) return "phone";
  }
  return null;
}

// ---- the turn a send closes ---------------------------------------------------------------
// From the item's previous send (exclusive) to this send (inclusive). firstDraft is the earliest
// AI draft written in it (the full reply before its interim when one version has both), or null;
// redrafted is true when a salesperson pressed Redraft in it. Timestamps are SQLite
// datetime('now') text and compare as strings. Shared with adoption-report.js.
function turnFacts(sentAt, itemSendTimes, aiDrafts, redraftTimes) {
  const prev = itemSendTimes.filter((t) => t < sentAt).sort().pop() || "";
  const inTurn = (t) => t > prev && t <= sentAt;
  const firstDraft = aiDrafts.filter((d) => inTurn(d.created_at))
    .sort((a, b) => a.version - b.version || a.is_interim - b.is_interim)[0] || null;
  return { firstDraft, redrafted: redraftTimes.some(inTurn) };
}

// Word-level similarity, 1 = identical (normalised Levenshtein over words).
function wordSim(a, b) {
  const wa = String(a || "").toLowerCase().split(/\s+/).filter(Boolean);
  const wb = String(b || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!wa.length || !wb.length) return wa.length === wb.length ? 1 : 0;
  let prev = Array.from({ length: wb.length + 1 }, (_, j) => j);
  for (let i = 1; i <= wa.length; i++) {
    const cur = [i];
    for (let j = 1; j <= wb.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (wa[i - 1] === wb[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[wb.length] / Math.max(wa.length, wb.length);
}

const SQL = `
  SELECT s.id, s.work_item_id, s.body, s.sent_at, w.mailbox, d.body AS source_body,
         CASE WHEN u.role = 'admin' THEN 1 ELSE 0 END AS owner
  FROM sends s
  JOIN work_items w ON w.id = s.work_item_id
  JOIN drafts d ON d.id = s.source_draft_id
  LEFT JOIN users u ON u.tailscale_login = s.sent_by
  WHERE s.status = 'sent' AND s.body IS NOT NULL
    AND w.origin = 'inbound' AND w.intent = ? AND w.language = ?
    AND w.id <> ?
    AND length(s.body) BETWEEN ? AND ?
  ORDER BY s.sent_at DESC
  LIMIT ?`;

// Rows grouped by work_item_id, for the candidates' items only (one query per table).
function byItem(db, sql, ids) {
  const out = {};
  if (!ids.length) return out;
  for (const r of db.prepare(sql.replace("(?)", `(${ids.map(() => "?").join(",")})`)).all(...ids)) (out[r.work_item_id] = out[r.work_item_id] || []).push(r);
  return out;
}

function pickExemplars({ intent, language, mailbox, excludeItemId = 0, n = DEFAULT_N }, db) {
  if (!ENABLED || !intent || !language || n <= 0) return [];
  db = db || require("./db").db;
  const rows = db.prepare(SQL).all(intent, language, excludeItemId, MIN_LEN, MAX_LEN, POOL).filter((r) => !sensitive(r.body));
  const ids = [...new Set(rows.map((r) => r.work_item_id))];
  const sends = byItem(db, "SELECT work_item_id, sent_at FROM sends WHERE status = 'sent' AND work_item_id IN (?)", ids);
  const drafts = byItem(db, "SELECT work_item_id, body, version, is_interim, created_at FROM drafts WHERE source = 'ai' AND work_item_id IN (?)", ids);
  const redrafts = byItem(db, "SELECT work_item_id, ts FROM audit_log WHERE action = 'redraft_started' AND user <> 'system' AND work_item_id IN (?)", ids);
  const ok = [];
  for (const r of rows) {
    const tf = turnFacts(r.sent_at, (sends[r.work_item_id] || []).map((x) => x.sent_at), drafts[r.work_item_id] || [],
      (redrafts[r.work_item_id] || []).map((x) => x.ts));
    if (tf.redrafted) continue;
    const plain = FMT.toPlain(r.body);
    const sim = wordSim(FMT.toPlain(tf.firstDraft ? tf.firstDraft.body : r.source_body), plain);
    if (sim >= MIN_SIM) ok.push({ ...r, plain, unchanged: sim >= UNCHANGED ? 1 : 0 });
  }
  // Same mailbox, then owners, then unchanged before lightly edited, then newest.
  ok.sort((a, b) =>
    (b.mailbox === mailbox) - (a.mailbox === mailbox) ||
    b.owner - a.owner ||
    b.unchanged - a.unchanged ||
    (a.sent_at < b.sent_at ? 1 : a.sent_at > b.sent_at ? -1 : 0));
  // Sent text may carry formatting markers (**bold**, lists); the drafter writes plain text, so it
  // is shown the text without them.
  return ok.slice(0, n).map((r) => ({ sendId: r.id, edited: !r.unchanged, body: r.plain }));
}

// The prompt block. Bodies are our own staff's sent text, sanitised by the caller.
function exemplarBlock(list, sanitise = (s) => s) {
  if (!list.length) return "";
  const items = list.map((e, i) => `<example n="${i + 1}">\n${sanitise(e.body)}\n</example>`).join("\n");
  return (
    "<style_exemplars>\n" +
    "These are real replies our team sent for similar enquiries. Match their tone, length, structure and phrasing. " +
    "They are STYLE examples only: never reuse their facts, names, prices, part numbers, links, order or tracking details, " +
    "and never assume this customer's situation matches theirs. Every fact in your reply must still come from your tool results or the seed context.\n" +
    items +
    "\n</style_exemplars>\n\n"
  );
}

module.exports = { pickExemplars, exemplarBlock, sensitive, turnFacts, wordSim, MIN_LEN, MAX_LEN, MIN_SIM };
