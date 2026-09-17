// harness-outlook-close.js — Outlook → Axle reconciliation (outlook-close.js).
//
// Runs against a THROWAWAY SQLite DB (AXLE_DB is pointed at a temp file BEFORE db.js is
// required, so the live C:\Axle\data\axle.db is never touched) and a STUBBED Graph read, so
// the selection rules and the closing rules are provable without going near M365 or the live
// queue. What it proves:
//   * the decision table: read / moved out of the monitored folders / deleted all close the item;
//     unread-and-still-in-a-monitored-folder does not; an unknown id (403/429/5xx) does not
//   * an empty monitored-folder set (lookup failed) DISABLES the 'moved' rule instead of closing
//     everything — the fail-safe that matters most here
//   * a close writes resolution 'outlook' plus an audit row naming the reason
//   * the safety exclusions hold: injection-flagged, 'investigating', compose-origin,
//     already-closed, other-mailbox and no-message-id items are never touched
//   * --dry-run reports without writing
//   * the allow-list gate: off => nothing runs at all
//
// It also covers the REOPEN mirror (2026-08-06), whose mailbox read is stubbed through
// `opts.unread` the same way the Graph read is stubbed through `opts.states`:
//   * eligibility: only an item THIS pass closed (resolution 'outlook'), still inside the
//     REOPEN_DAYS window, inbound-origin, currently 'done' — a human's Done / Archive / sent
//     reply is never undone
//   * matching mirrors ingest: by stored message id, then by conversation key — so an unread
//     message ANYWHERE in the thread reopens the item, which is the live #992 regression
//   * one reopen per thread, even in a dry run where the guarded UPDATE cannot dedupe
//   * the item returns to its pre-close status; missing => 'new'; 'investigating' never restored
//   * a failing mailbox read is contained and never stops the close pass
//
// ...and the LIVE-THREAD RULE that stopped the two passes fighting (the production flap):
//   * an item with ANY unread message in a monitored folder is never closed, whatever the close
//     reason says — the shape that flapped live (newest message read, original unread) is
//     replayed over two consecutive runs to prove the loop is dead, not merely delayed
//   * unread mail belonging to a DIFFERENT thread does not hold an item open
//   * when the unread read fails, 'read' is withheld but 'moved' and 'gone' still close
//
// Usage (on the box, from the app folder): node ..\harness\harness-outlook-close.js
const fs = require("fs");
const os = require("os");
const path = require("path");

// Point the DB at a temp file and set the mailbox env vars BEFORE anything is required.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "axle-oc-"));
process.env.AXLE_DB = path.join(TMP, "test.db");
process.env.MAILBOX_INFO = "info@budget-parts.nl";
process.env.MAILBOX_DRACHTEN = "drachten@budget-parts.nl";
process.env.AXLE_ACTION_OUTLOOK_CLOSE = "on";

const { db } = require("../box-code/db.js");
const OC = require("../box-code/outlook-close.js");

let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; } else { fail++; console.log("  FAIL:", name); } };

// Insert one work item; returns its id. Only the columns this pass cares about are set.
let seq = 0;
function item(over = {}) {
  seq++;
  const w = {
    mailbox: "info", status: "new", origin: "inbound", injection_flag: 0,
    latest_message_id: "MSG" + seq, subject: "Test " + seq, conversation_key: "key-" + seq,
    sender_email: "customer@example.com", sender_name: "Customer", priority: 2,
    resolution: null, pre_close_status: null, closed_ago: "0 days",
    ...over,
  };
  const r = db.prepare(
    `INSERT INTO work_items (mailbox, conversation_key, status, resolution, pre_close_status, origin,
                             injection_flag, latest_message_id, subject, sender_email, sender_name,
                             priority, updated_at)
     VALUES (@mailbox, @conversation_key, @status, @resolution, @pre_close_status, @origin,
             @injection_flag, @latest_message_id, @subject, @sender_email, @sender_name,
             @priority, datetime('now', @closed_ago))`
  ).run(w);
  return { id: r.lastInsertRowid, ...w };
}
const row = (id) =>
  db.prepare("SELECT status, resolution, pre_close_status FROM work_items WHERE id = ?").get(id);
const audits = (id, action) =>
  db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE work_item_id = ? AND action = ?").get(id, action).n;
const auditDetail = (id) =>
  (db.prepare("SELECT detail FROM audit_log WHERE work_item_id = ? AND action = 'closed_in_outlook'").get(id) || {}).detail || "";
// The stub Graph reader: answers from a fixed id -> state map, omitting anything not in it
// (exactly how getMessageStates behaves for a 403/429/5xx).
const stub = (map) => async (_mailbox, ids) => new Map(ids.filter((i) => i in map).map((i) => [i, map[i]]));
const INBOX = "folder-inbox", FORM = "folder-shopify-form", TOMS = "folder-toms-filing";
const MONITORED = new Set([INBOX, FORM]);

(async () => {
  console.log("Outlook-close harness\n");

  // --- 0. the decision table, in isolation ---------------------------------------------
  ok(OC.decide({ isRead: true, folderId: INBOX }, MONITORED) === "read", "read + in inbox -> close (read)");
  ok(OC.decide({ isRead: false, folderId: INBOX }, MONITORED) === null, "unread + in inbox -> leave open");
  ok(OC.decide({ isRead: false, folderId: FORM }, MONITORED) === null, "unread + in contact-form folder -> leave open");
  ok(OC.decide({ isRead: false, folderId: TOMS }, MONITORED) === "moved", "unread but filed away -> close (moved)");
  ok(OC.decide({ isRead: true, folderId: TOMS }, MONITORED) === "moved", "moved beats read in the reason");
  ok(OC.decide({ gone: true }, MONITORED) === "gone", "404 -> close (gone)");
  ok(OC.decide(undefined, MONITORED) === null, "unknown -> leave open");
  ok(OC.decide({ isRead: false, folderId: TOMS }, new Set()) === null,
    "FAIL-SAFE: an empty monitored set disables the moved rule");
  ok(OC.decide({ isRead: true, folderId: TOMS }, new Set()) === "read",
    "with no folder set, a read message still closes on read alone");

  // Injection-flagged: a deliberate act (file / delete) closes it; a mere preview does not.
  ok(OC.decide({ isRead: true, folderId: INBOX }, MONITORED, true) === null,
    "FLAGGED: read alone never closes a flagged item");
  ok(OC.decide({ isRead: true, folderId: TOMS }, MONITORED, true) === "moved",
    "FLAGGED: filing it away does close it");
  ok(OC.decide({ gone: true }, MONITORED, true) === "gone",
    "FLAGGED: deleting it does close it");
  ok(OC.decide({ isRead: false, folderId: INBOX }, MONITORED, true) === null,
    "FLAGGED: unread and in the inbox stays open");

  // --- 1. the happy path + the two "leave it alone" cases ------------------------------
  const readItem = item({ status: "ready" });
  const unreadItem = item({ status: "awaiting_input" });
  const unknownItem = item({ status: "new" });   // deliberately absent from the stub map
  const movedItem = item({ status: "new" });
  const deletedItem = item({ status: "awaiting_input" });

  let r = await OC.reconcileBox("info", {
    monitored: MONITORED, unread: [],
    states: stub({
      [readItem.latest_message_id]: { isRead: true, folderId: INBOX },
      [unreadItem.latest_message_id]: { isRead: false, folderId: INBOX },
      [movedItem.latest_message_id]: { isRead: false, folderId: TOMS },
      [deletedItem.latest_message_id]: { gone: true },
    }),
  });

  ok(r.folders === MONITORED.size, "the report exposes how many folders are being watched");
  ok(r.checked === 5, "all five open items are checked");
  ok(r.closed === 3, "read + moved + deleted all close (" + r.closed + ")");
  ok(r.read === 1 && r.moved === 1 && r.gone === 1, "the report counts each reason separately");
  ok(r.open === 1, "the unread in-folder item is counted as still open");
  ok(r.unknown === 1, "the absent id counts as unknown");
  ok(row(readItem.id).status === "done", "read item -> done");
  ok(row(readItem.id).resolution === "outlook", "read item -> resolution 'outlook'");
  ok(row(movedItem.id).resolution === "outlook", "moved item -> resolution 'outlook'");
  ok(row(deletedItem.id).resolution === "outlook", "deleted item -> resolution 'outlook'");
  ok(audits(readItem.id, "closed_in_outlook") === 1, "read item writes one audit row");
  ok(/marked read/.test(auditDetail(readItem.id)), "audit names the reason: read");
  ok(/moved out/.test(auditDetail(movedItem.id)), "audit names the reason: moved");
  ok(/deleted/.test(auditDetail(deletedItem.id)), "audit names the reason: deleted");
  ok(row(unreadItem.id).status === "awaiting_input", "unread in-folder item untouched");
  ok(row(unknownItem.id).status === "new", "unknown-state item untouched");

  // --- 2. the safety exclusions ---------------------------------------------------------
  const flagged = item({ injection_flag: 1 });
  const drafting = item({ status: "investigating" });
  const composed = item({ origin: "compose" });
  const alreadyDone = item({ status: "done", resolution: "replied" });
  const otherBox = item({ mailbox: "drachten" });
  const noMsgId = item({ latest_message_id: null });

  const allRead = {};
  for (const w of [drafting, composed, alreadyDone, otherBox, noMsgId]) {
    // every one of them is read AND filed away — i.e. every close reason fires at once
    if (w.latest_message_id) allRead[w.latest_message_id] = { isRead: true, folderId: TOMS };
  }
  // The flagged one is READ but still sitting in the Inbox — the case that must NOT close.
  allRead[flagged.latest_message_id] = { isRead: true, folderId: INBOX };
  const ids = OC.candidates("info").map((w) => w.id);
  ok(ids.includes(flagged.id), "injection-flagged item IS a candidate (the reason rule gates it)");
  ok(!ids.includes(drafting.id), "'investigating' item is never a candidate");
  ok(!ids.includes(composed.id), "compose-origin item is never a candidate");
  ok(!ids.includes(alreadyDone.id), "already-closed item is never a candidate");
  ok(!ids.includes(otherBox.id), "another mailbox's item is never a candidate");
  ok(!ids.includes(noMsgId.id), "item without a message id is never a candidate");

  await OC.reconcileBox("info", { monitored: MONITORED, states: stub(allRead), unread: [] });
  ok(row(flagged.id).status === "new", "flagged + read + in inbox: still open after a real run");
  ok(row(drafting.id).status === "investigating", "drafting item still open after a run");
  ok(row(composed.id).status === "new", "compose item still open after a run");
  ok(row(alreadyDone.id).resolution === "replied", "closed item's resolution not overwritten");
  ok(row(otherBox.id).status === "new", "drachten item untouched by an info run");

  // ...but a flagged item that was DELETED does close — the deliberate-act half of the rule.
  const flaggedGone = item({ injection_flag: 1 });
  await OC.reconcileBox("info", {
    monitored: MONITORED, unread: [], states: stub({ [flaggedGone.latest_message_id]: { gone: true } }),
  });
  ok(row(flaggedGone.id).status === "done", "flagged item deleted in Outlook DOES close");
  ok(row(flaggedGone.id).resolution === "outlook", "flagged close still records resolution 'outlook'");

  // --- 2b. the MIRROR: reopen on unread -------------------------------------------------
  // Closing an item must record what it was closed FROM, so the reopen can restore it.
  ok(row(readItem.id).pre_close_status === "ready", "close records the status it closed from");
  ok(row(deletedItem.id).pre_close_status === "awaiting_input", "...for every close reason");

  // The eligibility rule, in isolation. Only an item THIS pass closed, still within the window.
  const NOW = Date.now();
  const wi = (over) => ({ origin: "inbound", status: "done", resolution: "outlook",
                          updated_at: "2026-08-06 09:00:00", ...over });
  const at = Date.parse("2026-08-06T09:00:00Z");
  ok(OC.canReopen(wi(), at) === "unread", "an item this pass closed is eligible");
  ok(OC.canReopen(null, at) === null, "a message with no work item reopens nothing");
  ok(OC.canReopen(wi({ resolution: null }), at) === null, "a legacy close with no resolution stays closed");
  ok(OC.canReopen(wi({ status: "archived", resolution: "no_action" }), at) === null, "archived stays archived");
  ok(OC.canReopen(wi({ status: "new", resolution: null }), at) === null, "an already-open item is not reopened");
  ok(OC.canReopen(wi({ origin: "compose" }), at) === null, "a compose-origin item is never reopened");
  ok(OC.canReopen(wi({ updated_at: "not a date" }), at) === null, "an unparseable close time leaves it alone");
  ok(OC.canReopen(wi(), at + (OC.REOPEN_DAYS + 1) * 86400000) === null,
    `a close older than ${OC.REOPEN_DAYS} days is outside the window`);
  ok(OC.canReopen(wi(), at + (OC.REOPEN_DAYS - 1) * 86400000) === "unread", "...but just inside it still reopens");
  ok(typeof OC.canReopen(wi(), NOW) === "string", "the default clock argument works");

  // --- 2c. HUMAN closes, marked unread again (2026-08-15) --------------------------------
  // The rule that changed: a human's Done / phone / sent reply IS undone, but only when the unread
  // message is one AXLE marked read at close time (the read_marks ledger). The obvious test —
  // "was the message modified after the close?" — is impossible: Exchange does not move
  // lastModifiedDateTime on a read-state change (proved live on #500). The ledger is also what
  // stops the first run resurrecting every item closed before it existed: they have no rows.
  const OURS = true, NOT_OURS = false;
  for (const res of ["done", "phone", "replied"]) {
    ok(OC.canReopen(wi({ resolution: res }), at, OURS) === "unread-after-close",
      `a human close ('${res}') whose mail AXLE marked read is reopened when it goes unread`);
    ok(OC.canReopen(wi({ resolution: res }), at, NOT_OURS) === null,
      `...but '${res}' mail Axle never marked read stays closed (never read, not un-read)`);
    ok(OC.canReopen(wi({ resolution: res }), at) === null,
      `...and '${res}' defaults to not-ours when the caller says nothing`);
  }
  ok(OC.canReopen(wi({ resolution: "forwarded" }), at, OURS) === null,
    "a handover forward is never undone — the other mailbox now owns a second item for it");
  ok(OC.canReopen(wi({ status: "archived", resolution: "no_action" }), at, OURS) === null,
    "archive is a stronger act than Done: still never undone, however the mail is flagged");
  ok(OC.canReopen(wi({ resolution: null }), at, OURS) === null,
    "a legacy close with no resolution is still left alone");
  ok(OC.canReopen(wi({ resolution: "done" }), at + (OC.REOPEN_DAYS + 1) * 86400000, OURS) === null,
    "the 30-day window bounds human closes too");
  ok(OC.canReopen(wi(), at, NOT_OURS) === "unread",
    "our OWN close is unconditional — the ledger test does not apply to it");

  // The ledger lookup itself: keyed by (mailbox, message), and tied to the item that closed.
  // (work_item_id is a real foreign key, so these use real rows.)
  const led = item({ status: "done", resolution: "done" });
  const notLed = item({ status: "done", resolution: "done" });
  db.prepare("INSERT INTO read_marks (mailbox, message_id, work_item_id) VALUES ('info', 'LEDGER-1', ?)").run(led.id);
  ok(OC.markedReadByAxle("info", "LEDGER-1", led.id) === true, "a message Axle marked read is on the ledger");
  ok(OC.markedReadByAxle("info", "LEDGER-1", notLed.id) === false, "...but only as evidence about the item that closed");
  ok(OC.markedReadByAxle("drachten", "LEDGER-1", led.id) === false, "...and only in its own mailbox");
  ok(OC.markedReadByAxle("info", "NOT-THERE", led.id) === false, "an unknown message is not on the ledger");
  ok(OC.markedReadByAxle("info", null, led.id) === false, "a missing message id is inert");

  // A real pass, driven from a stubbed mailbox read. `msg` builds one unread message the way
  // connectors.getMessages maps them; the subject is what threadGroup keys on.
  const msg = (id, subject, from = "customer@example.com", received = "2026-08-06T09:00:00Z") =>
    ({ id, subject, from: { address: from, name: "C" }, received, text: "", hasAttachments: false });
  // Stand in for markReadSafe: record that Axle marked this message read when it closed the item.
  const ledger = (mailbox, messageId, itemId) =>
    db.prepare("INSERT OR REPLACE INTO read_marks (mailbox, message_id, work_item_id) VALUES (?, ?, ?)")
      .run(mailbox, messageId, itemId);
  const oc = (over) => item({ status: "done", resolution: "outlook", pre_close_status: "ready", ...over });

  const mine = oc({ conversation_key: "customer@example.com|klacht" });
  const humanDone = item({ status: "done", resolution: "done", pre_close_status: "ready" });
  const replied = item({ status: "done", resolution: "replied" });
  const archivedByHand = item({ status: "archived", resolution: "no_action" });
  const composedClose = oc({ origin: "compose" });
  const stale = oc({ closed_ago: `-${OC.REOPEN_DAYS + 5} days` });
  const otherBoxClosed = oc({ mailbox: "drachten" });

  const everyone = [mine, humanDone, replied, archivedByHand, composedClose, stale, otherBoxClosed]
    .map((w) => msg(w.latest_message_id, "Sub " + w.id));
  r = await OC.reconcileBox("info", { monitored: MONITORED, states: stub({}), unread: everyone });
  ok(r.reopened === 1, "exactly one item reopened (" + r.reopened + ")");
  ok(r.unread_seen === everyone.length, "the report exposes how much unread mail was seen");
  ok(row(mine.id).status === "ready", "reopened to the status it was closed from, not 'new'");
  ok(row(mine.id).resolution === null, "reopen clears the 'handled in Outlook' resolution");
  ok(row(mine.id).pre_close_status === null, "reopen clears pre_close_status");
  ok(audits(mine.id, "reopened_in_outlook") === 1, "reopen writes one audit row");
  ok(row(humanDone.id).status === "done" && row(humanDone.id).resolution === "done",
    "a human-closed item whose mail is NOT on the read-marks ledger is untouched by the run");
  ok(row(stale.id).status === "done", "the out-of-window item is untouched");
  ok(row(otherBoxClosed.id).status === "done", "drachten's closed item untouched by an info run");

  // THE REGRESSION THIS PASS EXISTS FOR (live #992, 2026-08-06): the unread message is NOT the
  // one whose id the item stores — it is the customer's ORIGINAL mail, several replies back.
  // Matching by conversation key (sender + subject minus RE:/FW:) must still find the item.
  const thread = oc({
    conversation_key: "benjamin@cartek.be|klacht propshaft lr037027g",
    latest_message_id: "NEWEST-REPLY-ID",          // read; never appears in the unread set
  });
  r = await OC.reconcileBox("info", {
    monitored: MONITORED, states: stub({}),
    unread: [msg("ORIGINAL-ID", "Klacht propshaft LR037027G", "benjamin@cartek.be")],
  });
  ok(r.reopened === 1, "an unread OLDER message in the thread reopens the item");
  ok(row(thread.id).status === "ready", "...restored to its pre-close status");
  ok(/unread again/.test(
    (db.prepare("SELECT detail FROM audit_log WHERE work_item_id = ? AND action = 'reopened_in_outlook'")
      .get(thread.id) || {}).detail || ""), "the audit row names the reason");

  // Two unread messages in ONE thread reopen it once, not twice.
  const twice = oc({ conversation_key: "dup@example.com|dubbel" });
  r = await OC.reconcileBox("info", {
    monitored: MONITORED, states: stub({}),
    unread: [msg("D1", "Dubbel", "dup@example.com"), msg("D2", "RE: Dubbel", "dup@example.com")],
  });
  ok(r.reopened === 1, "two unread messages in one thread reopen it once");
  ok(audits(twice.id, "reopened_in_outlook") === 1, "...and write one audit row");

  // Unread mail that never became a work item at all is simply ignored.
  r = await OC.reconcileBox("info", {
    monitored: MONITORED, states: stub({}), unread: [msg("UNKNOWN-ID", "Never ingested", "nobody@example.com")],
  });
  ok(r.reopened === 0, "unread mail with no work item reopens nothing");

  // Missing pre_close_status (an item closed before this column existed) falls back to 'new';
  // a stored 'investigating' is never restored.
  const legacy = oc({ pre_close_status: null, conversation_key: "a@example.com|legacy" });
  const midDraft = oc({ pre_close_status: "investigating", conversation_key: "b@example.com|middraft" });
  await OC.reconcileBox("info", {
    monitored: MONITORED, states: stub({}),
    unread: [msg("L1", "Legacy", "a@example.com"), msg("M1", "Middraft", "b@example.com")],
  });
  ok(row(legacy.id).status === "new", "a legacy close with no remembered status reopens as 'new'");
  ok(row(midDraft.id).status === "new", "'investigating' is never restored");

  // A HUMAN close, marked unread again — the live case from item 500 (2026-08-15). Driven through
  // the whole pass, not just canReopen, because the ledger lookup has to survive the mailbox read,
  // the thread grouping and the guarded UPDATE (whose WHERE used to hardcode resolution 'outlook').
  const byHand = item({ status: "done", resolution: "done", closed_ago: "-2 hours",
                        conversation_key: "garage@example.com|return request" });
  ledger("info", "H1", byHand.id);                    // Axle marked it read when the item closed
  r = await OC.reconcileBox("info", {
    monitored: MONITORED, states: stub({}),
    unread: [msg("H1", "RE: Return request", "garage@example.com")],
  });
  ok(r.reopened === 1, "a human-closed item marked unread again IS reopened (" + r.reopened + ")");
  ok(row(byHand.id).status === "new", "...back on the queue");
  ok(row(byHand.id).resolution === null, "...with the 'done' resolution cleared");
  ok(/after a human close \(done\)/.test(
    (db.prepare("SELECT detail FROM audit_log WHERE work_item_id = ? AND action = 'reopened_in_outlook'")
      .get(byHand.id) || {}).detail || ""), "...and an audit row that says which kind of close it undid");

  // Same shape, but Axle never marked that message read (an item closed before the ledger existed,
  // or mail that was simply never opened): nothing to undo, and no mass resurrection on first run.
  const stillDone = item({ status: "done", resolution: "done", closed_ago: "-2 hours",
                           conversation_key: "never@example.com|never read" });
  r = await OC.reconcileBox("info", {
    monitored: MONITORED, states: stub({}), unread: [msg("H2", "Never read", "never@example.com")],
  });
  ok(r.reopened === 0, "a human close with no ledger row stays closed — no mass resurrection");
  ok(row(stillDone.id).status === "done", "...the item is untouched");

  // Evidence is per item: a ledger row filed under a DIFFERENT item does not reopen this one.
  const otherItem = item({ status: "done", resolution: "done", closed_ago: "-2 hours",
                           conversation_key: "mixed@example.com|mixed" });
  ledger("info", "H4", stillDone.id);   // a real row, but filed under a DIFFERENT item
  r = await OC.reconcileBox("info", {
    monitored: MONITORED, states: stub({}), unread: [msg("H4", "Mixed", "mixed@example.com")],
  });
  ok(r.reopened === 0, "a ledger row belonging to another item is not evidence about this one");

  // A human-closed item with a draft waiting comes back 'ready', matching the manual Reopen
  // control — the human Done route never recorded a pre_close_status to restore.
  const withDraft = item({ status: "done", resolution: "replied", closed_ago: "-2 hours",
                           conversation_key: "drafted@example.com|drafted" });
  db.prepare("INSERT INTO drafts (work_item_id, version, body) VALUES (?, 1, 'x')").run(withDraft.id);
  ledger("info", "H3", withDraft.id);
  await OC.reconcileBox("info", {
    monitored: MONITORED, states: stub({}), unread: [msg("H3", "Drafted", "drafted@example.com")],
  });
  ok(row(withDraft.id).status === "ready", "a human-closed item with a draft reopens as 'ready', not 'new'");

  // The two passes must not fight: closing an item does not also reopen it in the same run.
  const churn = item({ status: "ready", conversation_key: "churn@example.com|churn" });
  r = await OC.reconcileBox("info", {
    monitored: MONITORED,
    states: stub({ [churn.latest_message_id]: { isRead: true, folderId: INBOX } }),
    unread: [],
  });
  ok(row(churn.id).status === "done", "an item closed this run stays closed this run");
  ok(audits(churn.id, "reopened_in_outlook") === 0, "...and is not reopened by the mirror pass");

  // --- 2c. THE LIVE-THREAD RULE (the production flap, 2026-08-06) -----------------------
  // #992's shape: newest message READ (so the close pass wants to close it), an older message in
  // the same thread UNREAD (so the reopen pass wants it open). Before the rule the two fought and
  // the item toggled every sync, never appearing on anyone's list.
  const flap = oc({
    conversation_key: "flap@example.com|klacht",
    latest_message_id: "FLAP-NEWEST",
  });
  const flapUnread = [msg("FLAP-ORIGINAL", "Klacht", "flap@example.com")];
  const flapRead = stub({ "FLAP-NEWEST": { isRead: true, folderId: INBOX } });

  r = await OC.reconcileBox("info", { monitored: MONITORED, states: flapRead, unread: flapUnread });
  ok(r.reopened === 1, "flap round 1: the item reopens");
  ok(r.closed === 0, "flap round 1: and is NOT closed again in the same run");
  ok(row(flap.id).status !== "done", "flap round 1: it is genuinely open afterwards");

  r = await OC.reconcileBox("info", { monitored: MONITORED, states: flapRead, unread: flapUnread });
  ok(r.closed === 0, "flap round 2: a later run does not close it either");
  ok(r.held_open === 1, "flap round 2: it is reported as held open by unread mail");
  ok(row(flap.id).status !== "done", "flap round 2: still open — the loop is dead");
  ok(audits(flap.id, "closed_in_outlook") === 0, "the item was never closed at all");

  // The rule outranks EVERY close reason, not just 'read' — a human marking something unread
  // beats even a move or a delete of the newest message.
  const filedButUnread = item({ status: "ready", conversation_key: "filed@example.com|filed" });
  r = await OC.reconcileBox("info", {
    monitored: MONITORED,
    states: stub({ [filedButUnread.latest_message_id]: { isRead: true, folderId: TOMS } }),
    unread: [msg("FILED-OTHER", "Filed", "filed@example.com")],
  });
  ok(row(filedButUnread.id).status === "ready", "unread mail in the thread outranks 'moved' too");

  // An item with NO unread mail in its thread still closes normally — the rule must not
  // accidentally hold the whole queue open.
  const normal = item({ status: "ready", conversation_key: "normal@example.com|normal" });
  r = await OC.reconcileBox("info", {
    monitored: MONITORED,
    states: stub({ [normal.latest_message_id]: { isRead: true, folderId: INBOX } }),
    unread: [msg("SOMEONE-ELSE", "Ander", "ander@example.com")],
  });
  ok(row(normal.id).status === "done", "an unrelated unread message does not hold other items open");

  // A failing mailbox read must not break the close pass — but it must withhold the one reason
  // that depends on knowing the unread set.
  const boom = item({ status: "ready" });
  const boomMoved = item({ status: "ready" });
  const boomGone = item({ status: "ready" });
  const throws = () => { throw new Error("Graph unavailable"); };
  r = await OC.reconcileBox("info", {
    monitored: MONITORED,
    states: stub({
      [boom.latest_message_id]: { isRead: true, folderId: INBOX },
      [boomMoved.latest_message_id]: { isRead: true, folderId: TOMS },
      [boomGone.latest_message_id]: { gone: true },
    }),
    unread: throws,
  });
  ok(r.reopen_error === "Graph unavailable", "the failed unread read is reported, not swallowed");
  ok(row(boom.id).status === "ready", "FAIL-SAFE: 'read' is withheld when the unread set is unknown");
  ok(row(boomMoved.id).status === "done", "...but 'moved' still closes — it does not depend on it");
  ok(row(boomGone.id).status === "done", "...and so does 'gone'");

  // --- 3. dry run writes nothing --------------------------------------------------------
  const dryItem = item({ status: "ready" });
  const dryStub = stub({ [dryItem.latest_message_id]: { isRead: true, folderId: INBOX } });
  r = await OC.reconcileBox("info", { dryRun: true, monitored: MONITORED, states: dryStub, unread: [] });
  ok(r.closed === 1, "dry run REPORTS the close");
  ok(row(dryItem.id).status === "ready", "dry run does not write");
  ok(audits(dryItem.id, "closed_in_outlook") === 0, "dry run writes no audit row");

  const dryReopen = oc({ conversation_key: "dry@example.com|dry" });
  r = await OC.reconcileBox("info", {
    dryRun: true, monitored: MONITORED, states: stub({}),
    unread: [msg("DRY1", "Dry", "dry@example.com")],
  });
  ok(r.reopened === 1, "dry run REPORTS the reopen");
  ok(row(dryReopen.id).status === "done", "dry run does not reopen");
  ok(audits(dryReopen.id, "reopened_in_outlook") === 0, "dry run writes no reopen audit row");

  // Dedup is the pass's own job, not the guarded UPDATE's: in a dry run nothing is written, so a
  // thread with two unread messages must still be counted once.
  oc({ conversation_key: "dry2@example.com|twee" });
  r = await OC.reconcileBox("info", {
    dryRun: true, monitored: MONITORED, states: stub({}),
    unread: [msg("DRY2a", "Twee", "dry2@example.com"), msg("DRY2b", "RE: Twee", "dry2@example.com")],
  });
  ok(r.reopened === 1, "dry run counts a two-message thread once (" + r.reopened + ")");

  // --- 4. the allow-list gate -----------------------------------------------------------
  process.env.AXLE_ACTION_OUTLOOK_CLOSE = "";
  ok(OC.enabled() === false, "gate reads as off when the env var is unset");
  r = await OC.reconcileBox("info", { monitored: MONITORED, states: dryStub, unread: [] });
  ok(r.skipped === "action not enabled", "run skips entirely when the action is off");
  ok(row(dryItem.id).status === "ready", "nothing closed while the action is off");
  process.env.AXLE_ACTION_OUTLOOK_CLOSE = "on";

  // --- 5. a run over both mailboxes never throws on a bad box ---------------------------
  const reports = await OC.reconcileBoxes(["info", "drachten"], { monitored: MONITORED, states: stub({}), unread: [] });
  ok(reports.length === 2, "reconcileBoxes reports on every mailbox");
  ok(reports.every((x) => !x.error), "no mailbox errored");

  // --- 6. connectors.getMessageStates: batching, de-dup, and per-message failures ------
  // global.fetch is stubbed to answer the token call and the $batch call, so the chunking, the
  // 404 -> {gone} mapping and the "omit anything else that isn't a clean 200" rule are provable
  // without touching Graph.
  const C = require("../box-code/connectors.js");
  process.env.M365_TENANT_ID = "t"; process.env.M365_CLIENT_ID = "c"; process.env.M365_CLIENT_SECRET = "s";
  const batches = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes("login.microsoftonline.com")) {
      return { json: async () => ({ access_token: "tok", expires_in: 3600 }) };
    }
    const body = JSON.parse(init.body);
    batches.push(body.requests.length);
    ok(/\$select=id,isRead,parentFolderId/.test(body.requests[0].url), "the batch asks for parentFolderId");
    return { json: async () => ({
      responses: body.requests.map((q) => {
        const n = Number(q.id);
        if (n === 0) return { id: q.id, status: 404, body: { error: { code: "ErrorItemNotFound" } } };
        if (n === 1) return { id: q.id, status: 429, body: {} };
        return { id: q.id, status: 200, body: { id: "x", isRead: n % 2 === 0, parentFolderId: INBOX } };
      }),
    }) };
  };

  const many = Array.from({ length: 45 }, (_, i) => "ID" + i);
  const states = await C.getMessageStates("info@budget-parts.nl", [...many, many[0]]);   // one duplicate
  ok(batches.join(",") === "20,20,5", "ids are chunked into batches of 20 (" + batches.join(",") + ")");
  // The stub fails sub-request 0 (404) and 1 (429) of EVERY batch, i.e. 3 of each across 45 ids.
  const gone = ["ID0", "ID20", "ID40"], throttled = ["ID1", "ID21", "ID41"];
  ok(states.size === 42, "the 429s are omitted and the duplicate collapses; 404s stay (" + states.size + ")");
  ok(gone.every((i) => states.get(i) && states.get(i).gone === true), "a 404 maps to { gone: true }");
  ok(throttled.every((i) => !states.has(i)), "a 429 contributes nothing — never guessed at");
  ok(states.get("ID2").isRead === true && states.get("ID3").isRead === false, "isRead is mapped per id");
  ok(states.get("ID2").folderId === INBOX, "parentFolderId is carried through");
  ok((await C.getMessageStates("info@budget-parts.nl", [])).size === 0, "empty input makes no call");
  global.fetch = realFetch;

  console.log(`\n${pass} passed, ${fail} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* temp dir */ }
  process.exit(fail ? 1 : 0);
})();
