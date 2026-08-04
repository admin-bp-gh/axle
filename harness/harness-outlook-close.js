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
    resolution: null,
    ...over,
  };
  const r = db.prepare(
    `INSERT INTO work_items (mailbox, conversation_key, status, resolution, origin, injection_flag,
                             latest_message_id, subject, sender_email, sender_name, priority, updated_at)
     VALUES (@mailbox, @conversation_key, @status, @resolution, @origin, @injection_flag,
             @latest_message_id, @subject, @sender_email, @sender_name, @priority, datetime('now'))`
  ).run(w);
  return { id: r.lastInsertRowid, ...w };
}
const row = (id) => db.prepare("SELECT status, resolution FROM work_items WHERE id = ?").get(id);
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
    monitored: MONITORED,
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

  await OC.reconcileBox("info", { monitored: MONITORED, states: stub(allRead) });
  ok(row(flagged.id).status === "new", "flagged + read + in inbox: still open after a real run");
  ok(row(drafting.id).status === "investigating", "drafting item still open after a run");
  ok(row(composed.id).status === "new", "compose item still open after a run");
  ok(row(alreadyDone.id).resolution === "replied", "closed item's resolution not overwritten");
  ok(row(otherBox.id).status === "new", "drachten item untouched by an info run");

  // ...but a flagged item that was DELETED does close — the deliberate-act half of the rule.
  const flaggedGone = item({ injection_flag: 1 });
  await OC.reconcileBox("info", {
    monitored: MONITORED, states: stub({ [flaggedGone.latest_message_id]: { gone: true } }),
  });
  ok(row(flaggedGone.id).status === "done", "flagged item deleted in Outlook DOES close");
  ok(row(flaggedGone.id).resolution === "outlook", "flagged close still records resolution 'outlook'");

  // --- 3. dry run writes nothing --------------------------------------------------------
  const dryItem = item({ status: "ready" });
  const dryStub = stub({ [dryItem.latest_message_id]: { isRead: true, folderId: INBOX } });
  r = await OC.reconcileBox("info", { dryRun: true, monitored: MONITORED, states: dryStub });
  ok(r.closed === 1, "dry run REPORTS the close");
  ok(row(dryItem.id).status === "ready", "dry run does not write");
  ok(audits(dryItem.id, "closed_in_outlook") === 0, "dry run writes no audit row");

  // --- 4. the allow-list gate -----------------------------------------------------------
  process.env.AXLE_ACTION_OUTLOOK_CLOSE = "";
  ok(OC.enabled() === false, "gate reads as off when the env var is unset");
  r = await OC.reconcileBox("info", { monitored: MONITORED, states: dryStub });
  ok(r.skipped === "action not enabled", "run skips entirely when the action is off");
  ok(row(dryItem.id).status === "ready", "nothing closed while the action is off");
  process.env.AXLE_ACTION_OUTLOOK_CLOSE = "on";

  // --- 5. a run over both mailboxes never throws on a bad box ---------------------------
  const reports = await OC.reconcileBoxes(["info", "drachten"], { monitored: MONITORED, states: stub({}) });
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
