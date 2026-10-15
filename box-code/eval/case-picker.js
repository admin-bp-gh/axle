"use strict";
// eval/case-picker.js - picks the replay cases for draft-eval.js from a COPY of the Axle database.
// Pure: no requires, no network. Takes any db handle with prepare(sql).all()/get() (better-sqlite3
// on the box). Reads only.
//
// A case is one human send on an inbound work item, anchored on the inbound message it answered:
// the latest stored message received before the send. The thread is cut at the send, so nothing
// that happened after it (the customer's next mail, our next reply, later feedback) reaches the
// drafter or the grader.
//
// Timestamps: messages.received is Graph ISO ("2026-10-14T20:02:14Z"); sends.sent_at, drafts,
// questions and draft_feedback use SQLite datetime('now') ("2026-10-14 15:03:12"). Both are UTC, so
// ts() folds them to "YYYY-MM-DD HH:MM:SS" and plain string comparison orders them.

const ts = (s) => String(s || "").replace("T", " ").replace(/Z$/, "").slice(0, 19);
const isoOf = (s) => (s ? ts(s).replace(" ", "T") + "Z" : "");
const OWN_RE = /@(?:budget-parts\.nl|roverparts\.eu)$/i;

const DEFAULTS = { total: 28, maxFollowups: 14, minFollowups: 8, minPerMailbox: 5 };

const ITEMS_SQL = `
  SELECT w.* FROM work_items w
  WHERE w.origin = 'inbound'
    AND lower(w.sender_email) <> 'voicemail@hipservice.nl'
    AND (w.caller_info IS NULL OR w.caller_info = '')
    AND EXISTS (SELECT 1 FROM sends s WHERE s.work_item_id = w.id AND s.status = 'sent'
                AND s.body IS NOT NULL AND length(trim(s.body)) > 0)
    AND EXISTS (SELECT 1 FROM messages m WHERE m.work_item_id = w.id)`;

// Quoted earlier mail inside a message: drop "> " lines, and everything from the first reply or
// forward header down. Deterministic on purpose (the eval must replay identically every run).
const QUOTE_HEAD = /^(On .* wrote:|Op .* schreef .*:|-----Original Message-----|Van: |From: )/;
function stripQuoted(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trimStart();
    if (QUOTE_HEAD.test(t)) break;
    if (t.startsWith(">")) continue;
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function userNames(db) {
  const map = {};
  try { for (const u of db.prepare("SELECT tailscale_login, display_name FROM users").all()) map[String(u.tailscale_login).toLowerCase()] = u.display_name; }
  catch (e) { /* no users table: logins are shown as they are */ }
  return (login) => map[String(login || "").toLowerCase()] || login || "?";
}

// The anchor for one item: the newest send that answers a NEW inbound message (one received after
// the previous send), or null with the reason.
function anchorFor(sends, msgs) {
  for (let i = sends.length - 1; i >= 0; i--) {
    const s = sends[i];
    const at = ts(s.sent_at);
    const before = msgs.filter((m) => ts(m.received) < at);
    if (!before.length) continue;
    const answered = before[before.length - 1];
    const prev = sends.slice(0, i).filter((p) => ts(p.sent_at) < at).pop() || null;
    if (prev && ts(answered.received) <= ts(prev.sent_at)) continue;   // a second reply to the same message
    return { send: s, answered, prev, inbound: before, priorSends: sends.slice(0, i).filter((p) => ts(p.sent_at) < at) };
  }
  return null;
}

// Build the full case record for one work item row, or { skip: reason }.
function buildCase(db, w, nameOf) {
  nameOf = nameOf || userNames(db);
  const sends = db.prepare(`SELECT id, to_addr, body, sent_by, sent_at, source_draft_id FROM sends
    WHERE work_item_id = ? AND status = 'sent' AND body IS NOT NULL AND length(trim(body)) > 0 ORDER BY sent_at, id`).all(w.id);
  const msgs = db.prepare("SELECT * FROM messages WHERE work_item_id = ? ORDER BY received, id").all(w.id);
  if (!sends.length) return { skip: "no human send with a body" };
  if (!msgs.length) return { skip: "no stored messages" };
  const a = anchorFor(sends, msgs);
  if (!a) return { skip: "no send answers a stored inbound message" };
  const at = ts(a.send.sent_at);
  const prevAt = a.prev ? ts(a.prev.sent_at) : "";
  const sendsBeforeAnswered = a.priorSends.filter((p) => ts(p.sent_at) < ts(a.answered.received)).length;
  const followup = sendsBeforeAnswered > 0 || a.inbound.length >= 2;
  const files = db.prepare("SELECT COUNT(*) AS n FROM message_attachments WHERE message_id = ?").get(a.answered.id).n;
  const parse = (s) => { try { return JSON.parse(s || "[]") || []; } catch (e) { return []; } };

  // The thread as it stood when the reply was sent: every stored inbound message up to the one
  // answered, and every earlier send, oldest first.
  const thread = a.inbound.map((m) => ({
    kind: "in", at: ts(m.received), received: m.received, from: { name: m.from_name || "", address: m.from_addr || "" },
    own: OWN_RE.test(m.from_addr || ""), body: m.body || "", answered: m.id === a.answered.id,
  })).concat(a.priorSends.map((s) => ({
    kind: "out", at: ts(s.sent_at), received: isoOf(s.sent_at), by: nameOf(s.sent_by), to: s.to_addr, body: s.body || "",
  }))).sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));

  const aiDraft = db.prepare(`SELECT id, version, is_interim, body, created_at FROM drafts
    WHERE work_item_id = ? AND source = 'ai' AND created_at <= ? ORDER BY created_at DESC, is_interim ASC, id DESC LIMIT 1`).get(w.id, at) || null;
  const answeredQs = db.prepare(`SELECT kind, question, answer, answered_by, answered_at FROM questions
    WHERE work_item_id = ? AND answer IS NOT NULL AND answered_at IS NOT NULL AND answered_at <= ? ORDER BY id`).all(w.id, at);
  let feedback = [];
  try {
    feedback = db.prepare(`SELECT author, text, created_at FROM draft_feedback
      WHERE work_item_id = ? AND created_at <= ? AND created_at > ? ORDER BY id`).all(w.id, at, prevAt);
  } catch (e) { /* older database without draft_feedback */ }
  let handover = null;
  try {
    const h = w.handover_json ? JSON.parse(w.handover_json) : null;
    if (h && h.to_owner && (!h.at || ts(h.at) <= at)) handover = h;
  } catch (e) { /* unreadable handover: none */ }

  return {
    id: w.id, mailbox: w.mailbox, subject: w.subject || "", language: w.language || "", intent: w.intent || "",
    rule_id: w.rule_id || "", followup,
    followup_reason: followup ? [sendsBeforeAnswered ? `customer wrote after ${sendsBeforeAnswered} earlier send(s)` : "", a.inbound.length >= 2 ? `${a.inbound.length} inbound messages` : ""].filter(Boolean).join("; ") : "",
    flags: {
      contact_form: w.rule_id === "shopify_form" || String(w.sender_email || "").toLowerCase() === "mailer@shopify.com" || !!w.contact_form_json,
      return_notification: w.rule_id === "shopify_return_request",
    },
    item: { sender_email: w.sender_email, sender_name: w.sender_name, origin: w.origin, rule_id: w.rule_id,
      return_json: w.return_json ? 1 : null, contact_form_json: w.contact_form_json ? 1 : null },
    newest: {
      message_id: a.answered.id, graph_id: a.answered.graph_id, internet_id: a.answered.internet_id || null,
      from: { name: a.answered.from_name || "", address: a.answered.from_addr || "" },
      to: parse(a.answered.to_json), cc: parse(a.answered.cc_json),
      received: a.answered.received, body: a.answered.body || "", files,
      sends_before: sendsBeforeAnswered,
    },
    sent: { id: a.send.id, sent_at: at, sent_by: nameOf(a.send.sent_by), to: a.send.to_addr, body: a.send.body, source_draft_id: a.send.source_draft_id || null },
    ai_draft: aiDraft,
    answered_questions: answeredQs,
    feedback,
    feedback_latest_unbounded: w.feedback || null,   // reference only: no timestamp, may postdate the send
    handover,
    thread,
  };
}

// Pick the case set, newest first. opts.ids: build exactly those items. Returns
// { cases, notes, stats }.
function pickCases(db, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const nameOf = userNames(db);
  const notes = [];
  if (o.ids && o.ids.length) {
    const cases = [];
    for (const id of o.ids) {
      const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(Number(id));
      if (!w) { notes.push(`item ${id}: not in this database`); continue; }
      const c = buildCase(db, w, nameOf);
      if (c.skip) notes.push(`item ${id}: ${c.skip}`); else cases.push(c);
    }
    return { cases, notes, stats: { requested: o.ids.length, built: cases.length } };
  }
  const all = [], skipped = {};
  for (const w of db.prepare(ITEMS_SQL).all()) {
    const c = buildCase(db, w, nameOf);
    if (c.skip) skipped[c.skip] = (skipped[c.skip] || 0) + 1; else all.push(c);
  }
  const newestFirst = (x, y) => (x.sent.sent_at < y.sent.sent_at ? 1 : x.sent.sent_at > y.sent.sent_at ? -1 : 0);
  all.sort(newestFirst);
  const fu = all.filter((c) => c.followup), nf = all.filter((c) => !c.followup);
  const sel = fu.slice(0, o.maxFollowups);
  for (const c of nf) { if (sel.length >= o.total) break; sel.push(c); }
  // Both mailboxes: swap the oldest non-follow-ups of the bigger mailbox for the smaller one's newest.
  for (const box of ["drachten", "info"]) {
    const want = Math.min(o.minPerMailbox, all.filter((c) => c.mailbox === box).length);
    let have = sel.filter((c) => c.mailbox === box).length;
    const spare = all.filter((c) => c.mailbox === box && !sel.includes(c));
    while (have < want && spare.length) {
      const out = [...sel].reverse().find((c) => c.mailbox !== box && !c.followup);
      if (!out) break;
      sel.splice(sel.indexOf(out), 1, spare.shift());
      have++;
    }
  }
  sel.sort(newestFirst);
  const nFu = sel.filter((c) => c.followup).length;
  if (fu.length < o.minFollowups) notes.push(`only ${fu.length} follow-up case(s) exist in this database (wanted at least ${o.minFollowups}); not padded`);
  if (all.length < o.total) notes.push(`only ${all.length} eligible case(s) exist in this database (wanted ${o.total})`);
  const stats = {
    eligible: all.length, eligible_followups: fu.length,
    eligible_by_mailbox: { info: all.filter((c) => c.mailbox === "info").length, drachten: all.filter((c) => c.mailbox === "drachten").length },
    selected: sel.length, selected_followups: nFu,
    selected_by_mailbox: { info: sel.filter((c) => c.mailbox === "info").length, drachten: sel.filter((c) => c.mailbox === "drachten").length },
    skipped,
  };
  return { cases: sel, notes, stats };
}

module.exports = { pickCases, buildCase, anchorFor, stripQuoted, ts, isoOf, DEFAULTS, OWN_RE };
