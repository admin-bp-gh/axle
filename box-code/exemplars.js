// exemplars.js - style exemplars for the drafting prompt (P2.5/P2.6, 2026-10-04).
//
// Every send keeps the AI draft and the text a salesperson actually sent (sends.body,
// sends.source_draft_id). Until now nothing read that back. This module picks the closest
// real sent replies for a new item (same intent, same language, same mailbox first) so the
// engine can show the model how our team actually writes. Edited sends rank first: the
// salesperson's rewrite is where the house style lives. Only inbound replies of a sensible
// length qualify, which drops acknowledgements, carrier claims and runaway edge cases.
//
// Exemplars shape TONE only. The engine's instruction forbids reusing their facts; every fact
// in a new draft still traces to a tool result. Off switch: AXLE_EXEMPLARS=0.

const ENABLED = process.env.AXLE_EXEMPLARS !== "0";
const DEFAULT_N = Number(process.env.AXLE_EXEMPLARS_N) || 3;
const MIN_LEN = 200;
const MAX_LEN = 2500;
const POOL = 40;              // candidates per query before ranking in JS

const SQL = `
  SELECT s.id, s.body, s.sent_at, w.mailbox,
         CASE WHEN d.body IS NOT NULL AND d.body <> s.body THEN 1 ELSE 0 END AS edited
  FROM sends s
  JOIN work_items w ON w.id = s.work_item_id
  LEFT JOIN drafts d ON d.id = s.source_draft_id
  WHERE s.status = 'sent' AND s.body IS NOT NULL
    AND w.origin = 'inbound' AND w.intent = ? AND w.language = ?
    AND w.id <> ?
    AND length(s.body) BETWEEN ? AND ?
  ORDER BY s.sent_at DESC
  LIMIT ?`;

function pickExemplars({ intent, language, mailbox, excludeItemId = 0, n = DEFAULT_N }, db) {
  if (!ENABLED || !intent || !language || n <= 0) return [];
  db = db || require("./db").db;
  const rows = db.prepare(SQL).all(intent, language, excludeItemId, MIN_LEN, MAX_LEN, POOL);
  // Same mailbox first, edited before verbatim, newest first within each group.
  rows.sort((a, b) =>
    (b.mailbox === mailbox) - (a.mailbox === mailbox) ||
    b.edited - a.edited ||
    (a.sent_at < b.sent_at ? 1 : a.sent_at > b.sent_at ? -1 : 0));
  return rows.slice(0, n).map((r) => ({ sendId: r.id, edited: Boolean(r.edited), body: r.body }));
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

module.exports = { pickExemplars, exemplarBlock, MIN_LEN, MAX_LEN };
