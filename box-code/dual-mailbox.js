// dual-mailbox.js - the same email in both mailboxes (A3, 26 Oct 2026).
// One message (same sender, and the same Message-ID or the same subject) that lands in info@ and
// drachten@ is kept open in ONE mailbox; the other copy is closed with a logged note naming the
// kept mailbox and the reason. Brad's rules, in gate order:
//   1. Reference (deterministic): an order, invoice or credit reference (SAP number or #S number)
//      that resolves to an SAP document decides by the warehouse on that document's lines:
//      10-GOU keeps it in info@ (Gouda), 20-DRA in drachten@ (Drachten).
//   2. Topic (AI): without a reference, the classifier's branch_topic decides: quotes and parts
//      advice go to Drachten, general enquiries to Gouda.
// Anything uncertain (mixed warehouses, no topic, an unsure or failed classifier) keeps BOTH
// copies open and flags them; nothing is ever dropped silently.
"use strict";
const DR = require("./doc-references.js");

const BRANCH_OF_WHS = { "10-GOU": "info", "20-DRA": "drachten" };
const BOX_TEXT = { info: "info@ (Gouda)", drachten: "drachten@ (Drachten)" };
const OTHER = { info: "drachten", drachten: "info" };
const TWIN_HOURS = 48;

function normSubject(s) {
  return String(s || "").toLowerCase().replace(/^\s*((re|fw|fwd|aw|wg|antw|tr)\s*:\s*)+/g, "").replace(/\s+/g, " ").trim();
}

// The open item in the OTHER mailbox that carries this same message, or null.
// Same Message-ID wins; else same sender and same subject within TWIN_HOURS.
function findTwin(db, boxName, email) {
  const other = OTHER[boxName];
  if (!other) return null;
  const from = String((email.from && email.from.address) || "").trim().toLowerCase();
  if (!from) return null;
  const open = "w.status NOT IN ('done', 'archived')";
  if (email.internetMessageId) {
    const hit = db.prepare(`SELECT w.* FROM messages m JOIN work_items w ON w.id = m.work_item_id
      WHERE m.mailbox = ? AND m.internet_id = ? AND ${open} ORDER BY w.id DESC LIMIT 1`).get(other, email.internetMessageId);
    if (hit) return hit;
  }
  const subj = normSubject(email.subject);
  if (!subj) return null;
  const rows = db.prepare(`SELECT w.* FROM work_items w WHERE w.mailbox = ? AND LOWER(w.sender_email) = ? AND ${open}
    AND w.updated_at >= datetime('now', ?) ORDER BY w.id DESC`).all(other, from, `-${TWIN_HOURS} hours`);
  return rows.find((w) => normSubject(w.subject) === subj) || null;
}

// Gate 1: the branch named by the warehouses of the documents the email references.
// deps.resolveReference(ref) -> { docs: [{ objectId, docEntry, docNum }] }; deps.docWarehouses(objectId, docEntry) -> ["10-GOU", ...]
// Returns { box, reason } | { uncertain, reason } | null (no reference that resolves).
async function referenceBranch(text, deps) {
  const refs = DR.extractReferences(text);
  const boxes = new Set(), seen = [];
  for (const ref of refs) {
    let docs = [];
    try { ({ docs } = await deps.resolveReference(ref)); } catch { continue; }
    for (const d of (docs || []).slice(0, 3)) {
      let whs = [];
      try { whs = await deps.docWarehouses(d.objectId, d.docEntry); } catch { continue; }
      for (const w of whs || []) if (BRANCH_OF_WHS[w]) { boxes.add(BRANCH_OF_WHS[w]); seen.push(`${d.docNum} ${w}`); }
    }
  }
  if (!boxes.size) return null;
  const list = [...new Set(seen)].join(", ");
  if (boxes.size > 1) return { uncertain: true, reason: `references point to both branches (${list})` };
  return { box: [...boxes][0], reason: `reference ${list}` };
}

// Gate 2: the AI topic from the existing classify() call (cls.branch_topic).
function topicBranch(cls) {
  const t = cls && cls.branch_topic;
  if (!cls || cls.summary === "UNPARSEABLE CLASSIFIER OUTPUT") return { uncertain: true, reason: "classifier failed" };
  if (t === "parts_quote") return { box: "drachten", reason: "no reference; topic quote or parts advice (AI)" };
  if (t === "general") return { box: "info", reason: "no reference; general enquiry (AI)" };
  return { uncertain: true, reason: "no reference and the AI was unsure of the topic" };
}

async function decide(email, cls, deps) {
  const text = [email.subject, email.text].filter(Boolean).join("\n");
  return (await referenceBranch(text, deps)) || topicBranch(cls);
}

const flagText = (box, reason) => `This email is also in ${BOX_TEXT[OTHER[box]]}. The Email app could not decide which mailbox handles it (${reason}); close one copy by hand.`;

// Ingest step for one message in boxName that may have a twin. Runs before drafting.
// deps: { db, audit, closeItem(w, note), resolveReference, docWarehouses }.
// Returns { action: 'none' } | { action: 'closed_this' | 'closed_other' | 'flagged', twinId, keep, reason }.
async function handle(itemId, boxName, email, cls, deps) {
  const twin = findTwin(deps.db, boxName, email);
  if (!twin) return { action: "none" };
  let d;
  try { d = await decide(email, cls, deps); } catch (e) { d = { uncertain: true, reason: "decision failed: " + String(e.message || e).slice(0, 80) }; }
  if (d.uncertain) {
    deps.audit("system", "dual_mailbox_flagged", itemId, `twin ${twin.id} in ${twin.mailbox}@; both kept open: ${d.reason}`.slice(0, 300));
    return { action: "flagged", twinId: twin.id, reason: d.reason, flag: flagText(boxName, d.reason), twinFlag: flagText(twin.mailbox, d.reason) };
  }
  const closeId = d.box === boxName ? twin.id : itemId;
  const closed = deps.db.prepare("SELECT * FROM work_items WHERE id = ?").get(closeId);
  const note = `kept in ${BOX_TEXT[d.box]}: ${d.reason}`;
  await deps.closeItem(closed, note);
  deps.audit("system", "dual_mailbox_closed", closeId, `same email as item ${closeId === itemId ? twin.id : itemId}; ${note}`.slice(0, 300));
  return { action: closeId === itemId ? "closed_this" : "closed_other", twinId: twin.id, keep: d.box, reason: d.reason };
}

module.exports = { handle, decide, findTwin, referenceBranch, topicBranch, normSubject, BRANCH_OF_WHS };
