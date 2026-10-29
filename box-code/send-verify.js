// send-verify.js: did the email the Email app sent actually leave? (15 Oct 2026)
//
// Exchange can accept a send and then never send it: the message stays in the mailbox's Drafts
// and Graph reports nothing (the reply to Pere Garriga, item 2709, 15 Oct 2026). The Email app used to treat
// "accepted" as "sent", so nobody knew until the customer chased. send.js now sends a draft whose
// immutable id it keeps (sends.graph_message_id); this pass, run at the end of every sync, looks
// each recent send up by that id:
//
//   sent (left Drafts as a sent message)    -> verified
//   still in Drafts RETRY_AFTER_MIN after Send -> sent again once (retried)
//   still in Drafts STUCK_AFTER_MIN after that -> stuck: the item goes back on the Open list as
//                                                Ready to send with the Not sent banner and a
//                                                Try again button; its normal Send is off, so a
//                                                second, different reply cannot go out while the
//                                                first may still leave
//   deleted or moved out of Drafts unsent     -> gone: the send row is dropped and the item reopens
//                                                with the reply text back in the box, so it can be
//                                                sent again normally
//
// A stuck send keeps being checked: if it leaves later (Exchange catches up, or someone sends it
// from Outlook) it is verified and the item closes again as replied. Sends older than WINDOW_HOURS
// and sends from before this existed (verify_state NULL) are never looked at.
//
// Allow-listed: acts only with AXLE_ACTION_SEND_VERIFY=on in the box .env (read at call time).
"use strict";
require("dotenv").config({ path: require("path").join(__dirname, "..", "secrets", ".env"), quiet: true });
const rulesets = require("./rules.js");
const SEND = require("./send.js");
const { db, audit } = require("./db.js");

const RETRY_AFTER_MIN = 3;
const STUCK_AFTER_MIN = 3;
const WINDOW_HOURS = 24;

const enabled = () => process.env.AXLE_ACTION_SEND_VERIFY === "on";
const mailboxOf = (box) => process.env[(rulesets[box] || {}).mailboxEnv || ""] || null;
const minutesSince = (sqlTime, nowMs) => (nowMs - Date.parse(String(sqlTime).replace(" ", "T") + "Z")) / 60000;

// What to do with one send, from where its message is now. Pure, for the tests.
function decide(state, verifyState, minutes) {
  if (state.sent) return "verified";
  if (state.gone) return "gone";
  if (verifyState === "pending" && minutes >= RETRY_AFTER_MIN) return "retry";
  if (verifyState === "retried" && minutes >= STUCK_AFTER_MIN) return "stuck";
  return null;
}

const SEND_COLS = `s.id, s.work_item_id, s.graph_message_id, s.verify_state, s.verify_at, s.sent_at, s.to_addr, s.body,
                   w.mailbox, w.status, w.send_stuck_id`;

function markVerified(s) {
  db.prepare("UPDATE sends SET verify_state = 'verified', verify_at = datetime('now') WHERE id = ?").run(s.id);
  if (s.verify_state === "pending") return;
  if (s.send_stuck_id === s.id) {
    db.prepare(`UPDATE work_items SET send_stuck_id = NULL, status = 'done', resolution = 'replied', updated_at = datetime('now')
                 WHERE id = ? AND send_stuck_id = ?`).run(s.work_item_id, s.id);
  }
  audit("system", "send_verified", s.work_item_id, `send ${s.id} to=${s.to_addr} left Drafts after it was ${s.verify_state}`);
}

// The unsent message is gone from Drafts: drop the send row (so the de-dup lets the same text go
// again) and reopen the item with the reply back in the box. Not when the item was flagged Not sent
// and someone has since closed it: then they dealt with it, and it stays closed.
function restore(s) {
  db.prepare("DELETE FROM sends WHERE id = ?").run(s.id);
  const closedByHand = s.send_stuck_id === s.id && ["done", "archived"].includes(s.status);
  if (closedByHand) {
    db.prepare("UPDATE work_items SET send_stuck_id = NULL WHERE id = ?").run(s.work_item_id);
  } else {
    db.prepare(`UPDATE work_items SET send_stuck_id = NULL, status = 'ready', resolution = NULL,
                       draft_edit = COALESCE(draft_edit, ?), updated_at = datetime('now') WHERE id = ?`).run(s.body, s.work_item_id);
  }
  audit("system", "send_gone", s.work_item_id, `send ${s.id} to=${s.to_addr} was deleted or moved out of Drafts unsent; ` +
    (closedByHand ? "item already closed by hand, left closed" : "reopened with the reply restored"));
}

function flagStuck(s) {
  db.prepare("UPDATE sends SET verify_state = 'stuck', verify_at = datetime('now') WHERE id = ?").run(s.id);
  db.prepare(`UPDATE work_items SET send_stuck_id = ?, status = 'ready', resolution = NULL, updated_at = datetime('now') WHERE id = ?`)
    .run(s.id, s.work_item_id);
  audit("system", "send_stuck", s.work_item_id, `send ${s.id} to=${s.to_addr} still in Drafts after a retry; reopened as Not sent`);
}

// One pass over the recent sends of the given mailboxes. Never throws; returns a report.
// opts.graph: { messageState, sendDraft } override (the test seam); opts.now: ms clock.
async function verifyBoxes(boxes, opts = {}) {
  const report = { checked: 0, verified: 0, retried: 0, stuck: 0, gone: 0, errors: 0, skipped: null };
  if (!enabled()) { report.skipped = "AXLE_ACTION_SEND_VERIFY is not on"; return report; }
  const graph = opts.graph || SEND;
  const now = opts.now || Date.now();
  const rows = db.prepare(
    `SELECT ${SEND_COLS} FROM sends s JOIN work_items w ON w.id = s.work_item_id
      WHERE s.status = 'sent' AND s.verify_state IN ('pending', 'retried', 'stuck')
        AND w.mailbox IN (${boxes.map(() => "?").join(",")})
        AND s.sent_at >= datetime('now', ?)
      ORDER BY s.id`
  ).all(...boxes, `-${WINDOW_HOURS} hours`);
  for (const s of rows) {
    const mins = minutesSince(s.verify_at || s.sent_at, now);
    if (mins < 2) continue;   // give Exchange its normal few seconds, and then some
    report.checked++;
    try {
      const mailbox = mailboxOf(s.mailbox);
      const act = decide(await graph.messageState(mailbox, s.graph_message_id), s.verify_state, mins);
      if (act === "verified") { markVerified(s); report.verified++; }
      else if (act === "gone") { restore(s); report.gone++; }
      else if (act === "retry") {
        await graph.sendDraft(mailbox, s.graph_message_id);
        db.prepare("UPDATE sends SET verify_state = 'retried', verify_at = datetime('now') WHERE id = ?").run(s.id);
        audit("system", "send_retry", s.work_item_id, `send ${s.id} to=${s.to_addr} still in Drafts after ${Math.round(mins)} min; sent again`);
        report.retried++;
      } else if (act === "stuck") { flagStuck(s); report.stuck++; }
    } catch (e) {
      report.errors++;
      console.log(`Send-verify: send ${s.id} - ${String(e.message || e).slice(0, 150)}`);
    }
  }
  return report;
}

// The Try again button on a Not sent item. Returns "sent" | "already_sent" | "restored" | "none".
async function retryStuck(itemId, login, graph = SEND) {
  const s = db.prepare(`SELECT ${SEND_COLS} FROM work_items w JOIN sends s ON s.id = w.send_stuck_id WHERE w.id = ?`).get(itemId);
  if (!s) return "none";
  const mailbox = mailboxOf(s.mailbox);
  const state = await graph.messageState(mailbox, s.graph_message_id);
  if (state.sent) { markVerified(s); return "already_sent"; }
  if (state.gone) { restore(s); return "restored"; }
  await graph.sendDraft(mailbox, s.graph_message_id);
  db.prepare("UPDATE sends SET verify_state = 'retried', verify_at = datetime('now') WHERE id = ?").run(s.id);
  db.prepare(`UPDATE work_items SET send_stuck_id = NULL, status = 'done', resolution = 'replied', updated_at = datetime('now') WHERE id = ?`).run(itemId);
  audit(login, "send_retry", itemId, `send ${s.id} to=${s.to_addr} sent again by hand from the Not sent banner`);
  return "sent";
}

module.exports = { verifyBoxes, retryStuck, decide, RETRY_AFTER_MIN, STUCK_AFTER_MIN };
