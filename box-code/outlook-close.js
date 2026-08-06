// outlook-close.js — Outlook → Axle reconciliation: close a work item when its email has been
// dealt with in Outlook. Three signals, all meaning "this is no longer live work for Axle":
//
//   read    — the email is still in a monitored folder but has been marked read. Reading it in
//             the shared mailbox is the team's existing "I've dealt with this" gesture.
//   moved   — the email is no longer in one of the mailbox's monitored folders (rules.js
//             `folders`: the Inbox, plus info@'s "Shopify Contact Form"). Filing it away is a
//             deliberate act; Tom, who works entirely in Outlook, files his mail out of the
//             Inbox and it should leave Axle's queue when he does.
//   gone    — the id 404s: the email was deleted. (An Exchange move MINTS A NEW ID, so a move to
//             another folder or to Deleted Items usually 404s the old id too — 'moved' and
//             'gone' are the same conclusion, and only the audit detail distinguishes them.)
//
// Why this exists: the team can always handle an email the old way, straight in Outlook. Before
// this pass, that email stayed on Axle's Open list until someone remembered to press Done —
// so the queue slowly filled with work that was already finished.
//
// Note this is the ONLY thing that keeps Axle's queue scoped to the monitored folders after
// ingest. Ingest reads only those folders, so nothing wrong ever comes IN; but without this,
// nothing notices an email LEAVING them.
//
// Why it is a SEPARATE pass and not part of ingest: ingest is a watermark poll that skips any
// conversation whose newest message id it has already seen (ingest.js, processThread), so it
// never revisits an older email and could not notice a change of read state. This pass works
// the other way round — it starts from Axle's OPEN items and asks Graph about exactly those
// message ids.
//
// THE MIRROR RULE — reopen on unread (added 2026-08-06). If reading an email in Outlook is the
// team's "I've dealt with this" gesture, then marking it UNREAD again is the equally common
// "actually, this still needs doing" gesture — and until this existed, Axle had no way to hear
// it. An item closed here stayed closed for good, so a customer email someone deliberately
// re-flagged as unread had silently dropped off the queue. (Found on the live box: #992, a
// propshaft complaint, and #1091 — both unread in Outlook, both closed in Axle.)
//
// It is deliberately the NARROWEST possible mirror:
//   * only items THIS pass closed (resolution = 'outlook'). A human's Done, Archive or a sent
//     reply is a decision Axle must never undo — those carry 'done'/'no_action'/'replied' and
//     are not candidates. This is the rule that keeps the two directions from fighting.
//   * only within REOPEN_DAYS of the close.
//   * the item returns to the status it was closed from (pre_close_status), so a draft that was
//     'ready to send' comes back ready, not as unhandled 'new'.
//
// It runs FROM THE MAILBOX, not from the DB: one folder-scoped "give me the unread mail" read
// per mailbox, then each unread message is matched back to its work item. That direction matters
// for two reasons the first cut of this got wrong (dry run, 2026-08-06 — it reopened nothing):
//   1. THREADS. Axle keeps one item per conversation and stores only the NEWEST message's id, but
//      the message a human marks unread is usually the one they were working — often the
//      customer's ORIGINAL mail, several replies back. Checking `latest_message_id` alone missed
//      exactly that: on the live box, #992's newest message was read while the original complaint
//      underneath it was unread, so the item stayed closed. Matching mirrors ingest instead —
//      by stored message id first, then by the conversation key threadGroup derives — so an
//      unread message ANYWHERE in the thread brings the item back.
//   2. COST AND COMPLETENESS. Starting from the DB meant $batch-ing every recently-closed item
//      (200 on info@, which hit the cap exactly — so older closes were invisible). Starting from
//      the mailbox is one list call for a handful of unread messages, and nothing is capped out.
// Because the fetch is folder-scoped, "still in a monitored folder" is inherent: mail filed away
// or deleted simply is not in the result, and stays closed.
//
// THE LIVE-THREAD RULE (2026-08-06, after the mirror flapped in production). The two passes must
// agree about what "handled" means, or they fight. They did not: the close pass judged the
// item's newest message alone (read => close), while the reopen pass judged the whole thread
// (any message unread => reopen). On a thread whose newest message was read but whose original
// was unread — #992, exactly the case this feature was built for — every sync reopened it and
// then closed it again two minutes later, so it never actually appeared on anyone's list.
//
// The fix is a single definition, applied by both: AN ITEM IS LIVE IF ANY MESSAGE IN ITS THREAD
// IS UNREAD IN A MONITORED FOLDER. The reopen pass already reads exactly that set, so it hands
// back the item ids it saw (`live`) and the close pass skips them — no close reason, not even
// 'moved' or 'gone', overrides a human having deliberately marked something unread. That kills
// the flap at its root rather than by ordering the two passes carefully: the invariant now holds
// however they are sequenced, and across runs, not just within one.
//
// It also removes a subtler over-close that predates the mirror: an item whose newest message was
// read but whose earlier mail was never opened used to be closed, which is precisely the "Axle
// says done, Outlook says unread" drift that started this whole investigation.
//
// Direction of travel (important): Axle → Outlook already exists (routes/shared.js markReadSafe
// PATCHes isRead when an item is sent / marked done / archived). That path only ever touches
// items that are ALREADY closed, and closed items are excluded from the worklist here, so the
// two never fight.
//
// Safety:
//   * READ-ONLY against Microsoft 365 — C.getReadStates issues GETs only. The only write is to
//     Axle's own SQLite.
//   * Allow-listed and OFF by default: set AXLE_ACTION_OUTLOOK_CLOSE=on in the box .env.
//   * An injection-flagged item closes ONLY on 'moved' or 'gone'. Filing or deleting a suspicious
//     email is a deliberate act and Axle accepts it; merely previewing one in the reading pane is
//     not, so 'read' never closes a flagged item. (Brad's call, 2026-07-27: the earlier blanket
//     exclusion meant flagged items could never clear on their own and just piled up.)
//   * Never touches an item mid-draft ('investigating') or a composed (outbound-origin) item,
//     which has no inbound message to read.
//   * Fully reversible: the close is an ordinary status change, undone with the existing
//     Reopen control, and every close writes an audit row.
//
// Usage (CLI, for verification): node outlook-close.js [info|drachten|all] [--dry-run]
require("dotenv").config({ path: require("path").join(__dirname, "..", "secrets", ".env"), quiet: true });
const rulesets = require("./rules.js");
const C = require("./connectors.js");
const { db, audit } = require("./db.js");

// Per-run cap on the number of open items checked per mailbox. 400 items = 20 Graph $batch
// calls; the live open queue is an order of magnitude smaller, so this only ever bites if the
// queue is left unattended for a very long time. Newest-first, so the freshest work is covered.
const MAX_ITEMS = 400;

// The REOPEN pass (the mirror of the close, added 2026-08-06) works from OUTLOOK's unread list,
// not from Axle's closed list — see the header. REOPEN_DAYS bounds how far back a close may be
// undone: an item closed longer ago than this is settled history, and resurrecting it months
// later would be a surprise rather than a help. REOPEN_PAGES caps the unread fetch (50/page).
const REOPEN_DAYS = 30;
const REOPEN_PAGES = 10;

// Resolved lazily (not at require time): the mailbox addresses come from the .env the caller
// loads, and this module is required by the long-running server as well as the CLI.
const mailboxOf = (box) => process.env[(rulesets[box] || {}).mailboxEnv || ""] || null;

// Allow-list action — "close a work item when its email is read in Outlook". OFF by default;
// Brad enables it deliberately by setting AXLE_ACTION_OUTLOOK_CLOSE=on in the box .env and
// restarting. Read at call time so a restart is all that is needed to flip it.
const enabled = () => process.env.AXLE_ACTION_OUTLOOK_CLOSE === "on";

// The open items this pass is allowed to consider, for one mailbox. Every exclusion here is a
// safety rule, not an optimisation — see the header.
function candidates(box) {
  return db.prepare(
    `SELECT id, mailbox, latest_message_id, status, subject, sender_email, owner,
            injection_flag, email_received, updated_at
       FROM work_items
      WHERE mailbox = ?
        AND origin = 'inbound'
        AND status NOT IN ('done', 'archived', 'investigating')
        AND latest_message_id IS NOT NULL
        AND TRIM(latest_message_id) <> ''
      ORDER BY updated_at DESC
      LIMIT ?`
  ).all(box, MAX_ITEMS);
}

// Find the work item an unread MESSAGE belongs to, exactly the way ingest would: by the stored
// Graph message id first, then by the conversation key. The second lookup is the one that matters
// — see the header — because the unread message is usually not the newest in its thread.
function itemForMessage(box, msgId, convKey) {
  return db.prepare("SELECT * FROM work_items WHERE mailbox = ? AND latest_message_id = ?").get(box, msgId)
      || (convKey ? db.prepare("SELECT * FROM work_items WHERE mailbox = ? AND conversation_key = ?").get(box, convKey) : null);
}

// May this item be reopened? Pure, so the whole rule is unit-testable without a mailbox. Returns
// "unread" to reopen, or null with every uncertainty resolved in favour of leaving it alone.
// Note there is no folder or read-state check here: the caller only ever passes items whose mail
// came back from a folder-scoped UNREAD fetch, so both are already true by construction.
// Injection-flagged items are not excluded — a flagged item can only have been closed by a
// deliberate move or delete, so its mail being unread in a watched folder is deliberate too.
function canReopen(w, nowMs = Date.now()) {
  if (!w) return null;                                  // never ingested / another mailbox
  if (w.origin !== "inbound") return null;              // composed item: no inbound mail to unread
  if (w.status !== "done") return null;                 // already open, or archived (a human act)
  if (w.resolution !== "outlook") return null;          // THE guard: only undo our own closes
  const closedMs = Date.parse(String(w.updated_at || "").replace(" ", "T") + "Z");
  if (!Number.isFinite(closedMs)) return null;          // unparseable timestamp: leave it alone
  if (nowMs - closedMs > REOPEN_DAYS * 86400000) return null;
  return "unread";
}

// Put one item back on the queue, at the status it was closed from. The WHERE repeats the
// closed-by-this-pass condition so a human who pressed Reopen (or a new inbound that re-opened
// the item) in the same instant always wins — the UPDATE reports 0 changes and we skip it.
// 'investigating' is never restored: a mid-draft status from before the close is meaningless now,
// and restoring it would make the item permanently invisible to the close pass.
function reopenItem(w) {
  const back = w.pre_close_status && w.pre_close_status !== "investigating" ? w.pre_close_status : "new";
  const changed = db.prepare(
    `UPDATE work_items SET status = ?, resolution = NULL, pre_close_status = NULL,
            updated_at = datetime('now')
      WHERE id = ? AND status = 'done' AND resolution = 'outlook'`
  ).run(back, w.id).changes;
  if (!changed) return false;
  audit("system", "reopened_in_outlook", w.id,
    `marked unread again in Outlook (${w.mailbox}@) — reopened to ${back} ` +
    `(${String(w.subject || "").slice(0, 60)})`);
  return true;
}

// The reopen pass for ONE mailbox. Reads the unread mail in the monitored folders, maps each
// message back to its work item, and reopens the ones this pass had closed. Never throws: a
// failure here is logged and reported, and must not stop the close pass or the sync.
// opts.unread — override the mailbox read: an array of mapped messages, or a function returning
//               one (the harness seam; a throwing function exercises the failure path).
async function reopenPass(box, mailbox, opts = {}) {
  const E = require("./engine.js");   // lazy: only this pass and the CLI diagnostics need it
  // `live` is the other half of this pass's job and the more important one: the ids of every
  // work item that has ANY unread message in a monitored folder. The close pass must leave those
  // alone — see the LIVE-THREAD RULE in the header.
  const out = { scanned: 0, reopened: 0, live: new Set(), items: [], error: null };
  const folders = (rulesets[box] || {}).folders || ["inbox"];
  let emails;
  try {
    emails = typeof opts.unread === "function" ? await opts.unread()
           : opts.unread ? opts.unread
           : await C.getMessages(mailbox, { unreadOnly: true, folders, maxPages: REOPEN_PAGES });
  } catch (e) {
    out.error = String(e.message || e).slice(0, 150);
    audit("system", "outlook_close_error", null, `${box}: unread fetch failed — ${out.error}`);
    return out;
  }
  out.scanned = emails.length;

  // Same grouping ingest uses, so the key we look up is the key it stored.
  const keyOf = new Map();
  for (const [key, msgs] of E.threadGroup(emails)) for (const m of msgs) keyOf.set(m.id, key);

  const done = new Set();   // several unread messages can share one thread — reopen it once
  for (const m of emails) {
    const w = itemForMessage(box, m.id, keyOf.get(m.id));
    if (!w) continue;
    out.live.add(w.id);     // unread mail in this thread: the close pass must not touch it
    if (done.has(w.id)) continue;
    if (!canReopen(w)) continue;
    done.add(w.id);
    if (!opts.dryRun && !reopenItem(w)) continue;       // lost a race with a human: skip
    out.reopened++;
    out.items.push({ ...w, reason: "unread" });
  }
  return out;
}

// Decide what to do with one item, given what Graph said about its message. Pure, so the whole
// decision table is unit-testable. Returns a reason string to close on, or null to leave it open.
//   state undefined -> unknown (403/429/5xx): leave alone, never guess.
//   flagged          -> injection-flagged item: 'moved' and 'gone' still close it (both are
//                       deliberate human acts), but 'read' does NOT — a reading-pane preview is
//                       not a decision, and a flagged email must not vanish before a real look.
function decide(state, monitoredIds, flagged = false) {
  if (!state) return null;
  if (state.gone) return "gone";
  if (state.folderId && monitoredIds.size && !monitoredIds.has(state.folderId)) return "moved";
  if (!state.isRead) return null;
  return flagged ? null : "read";
}

// Close one item. The status condition is repeated in the WHERE so a human who pressed Send or
// Done in the same instant always wins — the UPDATE simply reports 0 changes and we skip it.
// resolution 'outlook' keeps these distinguishable from a human 'done' everywhere the resolution
// is rendered or reported on; the specific reason lives in the audit row, not in a second
// resolution key (the team only needs to know "handled in Outlook", Brad can read the log).
const REASON_TEXT = {
  read: "marked read in Outlook",
  moved: "moved out of the monitored folders in Outlook",
  gone: "deleted in Outlook",
};
// pre_close_status remembers what the item looked like before the close, so the reopen mirror
// can restore it exactly (a 'ready' draft comes back ready, not as unhandled 'new').
function closeItem(w, reason) {
  const changed = db.prepare(
    `UPDATE work_items SET status = 'done', resolution = 'outlook', pre_close_status = status,
            updated_at = datetime('now')
      WHERE id = ? AND status NOT IN ('done', 'archived')`
  ).run(w.id).changes;
  if (!changed) return false;
  audit("system", "closed_in_outlook", w.id,
    `${REASON_TEXT[reason] || reason} (${w.mailbox}@) — auto-closed from ${w.status} ` +
    `(${String(w.subject || "").slice(0, 60)})`);
  return true;
}

// Reconcile ONE mailbox. Returns a small report; never throws for a per-item problem.
// opts.dryRun    — report what would close, change nothing (used by the CLI to verify safely).
// opts.force     — run even when the allow-list action is off (dry runs only, and the harness).
// opts.states    — override the Graph read (id -> state Map); the seam the harness injects a stub
//                  through, so the decision rules are testable without M365.
// opts.monitored — override the monitored folder-id set (harness).
async function reconcileBox(box, opts = {}) {
  const report = {
    box, enabled: enabled(), folders: 0, checked: 0, closed: 0,
    read: 0, moved: 0, gone: 0, open: 0, unknown: 0,
    unread_seen: 0, reopened: 0, held_open: 0, skipped: null,
  };
  const listed = opts.list ? [] : null;   // populated with the items that closed / would close
  if (!report.enabled && !opts.force) { report.skipped = "action not enabled"; return report; }

  const mailbox = mailboxOf(box);
  if (!mailbox) { report.skipped = "no mailbox configured"; return report; }

  // The reopen pass runs FIRST, because the close pass needs the `live` set it produces. Order is
  // no longer load-bearing for correctness, though: an item it reopens is in `live` by
  // construction, so the close pass below cannot undo it on this run or any later one.
  const back = await reopenPass(box, mailbox, opts);
  report.unread_seen = back.scanned;
  report.reopened = back.reopened;
  if (back.error) report.reopen_error = back.error;
  if (listed) listed.push(...back.items);

  const items = candidates(box);
  report.checked = items.length;
  if (!items.length) { if (listed) report.items = listed; return report; }

  // The folders this mailbox is allowed to have live work in — the same list ingest reads from,
  // so the two ends of the pipeline can never drift apart. An EMPTY set (folder lookup failed)
  // disables the 'moved' rule rather than closing everything: decide() treats size 0 as "don't
  // know where the monitored folders are", which fails safe.
  //
  // report.folders makes that fail-safe VISIBLE. A silent fail-safe is indistinguishable from
  // "nothing was moved", so the count goes in every report and every log line: expect 2 for info@
  // (Inbox + Shopify Contact Form) and 1 for drachten@. A 0 means the lookup failed and 'moved'
  // was skipped this run — read and deleted still worked.
  let monitored = opts.monitored;
  if (!monitored) {
    try {
      monitored = await C.folderIds(mailbox, (rulesets[box] || {}).folders || ["inbox"]);
    } catch (e) {
      monitored = new Set();
      audit("system", "outlook_close_error", null, `${box}: folder lookup failed — ${String(e.message || e).slice(0, 150)}`);
    }
  }
  report.folders = monitored.size;

  // One id per item (the newest inbound message on the thread — the one a human would open).
  // Several items can never share an id, but de-duplication is free inside getMessageStates.
  const readStates = opts.states || C.getMessageStates;
  const states = await readStates(mailbox, items.map((w) => w.latest_message_id));
  for (const w of items) {
    // LIVE-THREAD RULE: something in this thread is unread in a monitored folder, so a human
    // still wants it. No close reason overrides that.
    if (back.live.has(w.id)) { report.held_open++; report.open++; continue; }
    const state = states.get(w.latest_message_id);
    if (!state) { report.unknown++; continue; }        // 403 / 429 / 5xx — never guess
    let reason = decide(state, monitored, !!w.injection_flag);
    // If the unread read failed we do not KNOW whether the thread has unread mail, so the one
    // reason that depends on it is withheld this run. 'moved' and 'gone' are facts about the
    // message itself and still stand. Same "never guess" instinct as the empty-folder fail-safe.
    if (reason === "read" && back.error) reason = null;
    if (!reason) { report.open++; continue; }          // still in a monitored folder, still unread
    report[reason]++;
    const done = opts.dryRun ? true : closeItem(w, reason);
    if (!done) continue;
    report.closed++;
    if (listed) listed.push({ ...w, reason });
  }
  if (listed) report.items = listed;
  return report;
}

// Reconcile several mailboxes, one after the other. A failure on one mailbox is logged and does
// not stop the other — this pass is housekeeping and must never break a sync run.
async function reconcileBoxes(boxes, opts = {}) {
  const out = [];
  for (const box of boxes) {
    try {
      out.push(await reconcileBox(box, opts));
    } catch (e) {
      audit("system", "outlook_close_error", null, `${box}: ${String(e.message || e).slice(0, 200)}`);
      out.push({ box, error: String(e.message || e).slice(0, 200) });
    }
  }
  return out;
}

// Which messages in ONE item's thread are unread in the monitored folders — the live-thread rule,
// answered for a single item. Diagnostic only (explain()); the passes use reopenPass's `live` set,
// which is the same question asked once for the whole mailbox.
async function unreadInThread(w, mailbox, folderNames) {
  const E = require("./engine.js");
  const unread = await C.getMessages(mailbox, { unreadOnly: true, folders: folderNames, maxPages: REOPEN_PAGES });
  const hit = [];
  for (const [key, msgs] of E.threadGroup(unread)) {
    for (const m of msgs) {
      const owner = itemForMessage(w.mailbox, m.id, key);
      if (owner && owner.id === w.id) hit.push({ received: m.received, subject: m.subject, id: m.id });
    }
  }
  return hit;
}

// Explain, for ONE work item, exactly why this pass does or does not close it. Every exclusion in
// candidates() is re-evaluated here in the same order, then the live Graph state is fetched and run
// through decide(). Purely diagnostic: reads the DB and Graph, changes nothing.
async function explain(itemId) {
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(itemId);
  if (!w) return { error: `no work item #${itemId}` };

  const out = { id: w.id, mailbox: w.mailbox, status: w.status, resolution: w.resolution,
                origin: w.origin, injection_flag: w.injection_flag, subject: w.subject,
                latest_message_id: w.latest_message_id, excluded_because: null };

  // A closed-by-this-pass item is not excluded — it is on the REOPEN worklist instead, and the
  // interesting question becomes "why has it not come back?". Answered further down, after the
  // live Graph read, by decideReopen.
  const reopenCandidate = w.status === "done" && w.resolution === "outlook" &&
                          w.origin === "inbound" && !!String(w.latest_message_id || "").trim();
  out.pass = reopenCandidate ? "reopen" : "close";
  if (reopenCandidate) out.pre_close_status = w.pre_close_status;

  // Same exclusions as candidates(), in the same order, so this can never disagree with it.
  if (reopenCandidate) { /* fall through to the Graph read */ }
  else if (["done", "archived"].includes(w.status)) out.excluded_because = "already closed";
  else if (w.status === "investigating") out.excluded_because = "status 'investigating' (mid-draft)";
  else if (w.origin !== "inbound") out.excluded_because = `origin '${w.origin}' (no inbound email)`;
  else if (!w.latest_message_id || !String(w.latest_message_id).trim()) out.excluded_because = "no Graph message id stored";
  if (out.excluded_because) { out.verdict = "never a candidate — left open by design"; return out; }

  const mailbox = mailboxOf(w.mailbox);
  if (!mailbox) { out.verdict = "no mailbox configured for " + w.mailbox; return out; }
  out.mailbox_address = mailbox;

  const names = (rulesets[w.mailbox] || {}).folders || ["inbox"];
  let monitored = new Set();
  try { monitored = await C.folderIds(mailbox, names); }
  catch (e) { out.folder_lookup_error = String(e.message || e).slice(0, 150); }
  out.monitored_folders = names;
  out.monitored_ids = [...monitored];

  const state = (await C.getMessageStates(mailbox, [w.latest_message_id])).get(w.latest_message_id);
  out.graph = state || "absent (403 / 429 / 5xx — treated as unknown)";
  if (state && state.folderId) {
    out.message_folder_id = state.folderId;
    out.message_folder_name = await C.folderName(mailbox, state.folderId);
    out.in_monitored_folder = monitored.has(state.folderId);
  }
  if (reopenCandidate) {
    // The reopen pass is driven from the mailbox, so answer its two halves separately: is this
    // item eligible at all, and is any message in its thread actually unread right now?
    const to = w.pre_close_status && w.pre_close_status !== "investigating" ? w.pre_close_status : "new";
    out.eligible_to_reopen = !!canReopen(w);
    if (!out.eligible_to_reopen) {
      out.verdict = `stays closed — closed more than ${REOPEN_DAYS} days ago, outside the reopen window`;
      return out;
    }
    const hit = await unreadInThread(w, mailbox, names);
    out.unread_messages_in_this_thread = hit;
    out.verdict = hit.length
      ? `WOULD REOPEN (${hit.length} unread message(s) in this thread) -> ${to}`
      : "stays closed — nothing in this thread is unread in a monitored folder. Marking ANY " +
        "message of the thread unread (including the customer's original) brings it back.";
    return out;
  }

  // The live-thread rule outranks every close reason, so it is answered before decide().
  const unreadHere = await unreadInThread(w, mailbox, names);
  out.unread_messages_in_this_thread = unreadHere;
  if (unreadHere.length) {
    out.verdict = `stays open — ${unreadHere.length} message(s) in this thread are unread in a ` +
                  "monitored folder, and unread mail always outranks a close reason";
    return out;
  }

  const reason = decide(state, monitored, !!w.injection_flag);
  out.verdict = reason ? `WOULD CLOSE (${reason})` : "stays open";
  // Name the flagged rule explicitly — otherwise "stays open" on a read, in-folder flagged item
  // looks like a bug rather than the deliberate rule it is.
  if (!reason && w.injection_flag && state && !state.gone && state.isRead) {
    out.verdict = "stays open — injection-flagged, and 'read' alone never closes a flagged item " +
                  "(file or delete it in Outlook, or press Done in Axle)";
  }
  return out;
}

// The OTHER direction of drift: mail that is unread in Outlook's monitored folders but is NOT on
// Axle's open list. Fetches every unread message in the mailbox's monitored folders and says, for
// each, where it ended up in Axle — open, closed (and how), archived, suppressed as a blocked
// sender, or never ingested at all. Read-only; the counterpart to --explain, which goes the other
// way (Axle item -> Outlook state).
//
// Matching mirrors ingest exactly: an item is found by its stored Graph message id first, then by
// the conversation key (sender + normalised subject) that engine.threadGroup derives — because
// ingest stores ONE item per thread and only the newest message's id, so an older unread message
// in the same thread is still "in Axle".
async function auditBox(box) {
  const E = require("./engine.js");   // lazy: only the CLI diagnostic needs it
  const { isBlockedSender } = require("./db.js");
  const mailbox = mailboxOf(box);
  if (!mailbox) return { box, error: "no mailbox configured" };
  const folders = (rulesets[box] || {}).folders || ["inbox"];

  const emails = await C.getMessages(mailbox, { unreadOnly: true, folders, maxPages: 10 });
  const keyOf = new Map();
  for (const [key, msgs] of E.threadGroup(emails)) for (const m of msgs) keyOf.set(m.id, key);

  const byMsgId = db.prepare("SELECT * FROM work_items WHERE mailbox = ? AND latest_message_id = ?");
  const byKey = db.prepare("SELECT * FROM work_items WHERE mailbox = ? AND conversation_key = ?");
  const rows = emails.map((m) => {
    const w = byMsgId.get(box, m.id) || byKey.get(box, keyOf.get(m.id) || "");
    let where;
    if (!w) where = isBlockedSender(m.from.address) ? "not ingested — BLOCKED SENDER" : "NOT IN AXLE";
    else if (w.status === "archived") where = `#${w.id} archived (${w.resolution || "—"})`;
    else if (w.status === "done") where = `#${w.id} closed (${w.resolution || "—"})`;
    else where = `#${w.id} OPEN (${w.status})${w.injection_flag ? " [flagged]" : ""}`;
    return {
      received: String(m.received || "").slice(0, 16).replace("T", " "),
      from: String(m.from.address || "").slice(0, 30),
      subject: String(m.subject || "").slice(0, 40),
      matched_by: w ? (byMsgId.get(box, m.id) ? "message id" : "thread key") : "—",
      axle: where,
    };
  });
  return { box, unread_in_outlook: emails.length, folders, rows };
}

// Everything that ARRIVED in the monitored folders over the last N days but has NO work item in
// Axle — read or unread. The blunt "did we lose anything?" check.
//
// This exists because of the 2026-07-27 incident: a mis-clicked '@gmail.com' domain block meant
// ingest silently skipped every consumer customer for 13 days, and nothing surfaced it. Ingest's
// watermark means such mail is never picked up retroactively, so the only way to find it is to
// compare the mailbox against the DB. Read-only.
async function missingBox(box, days = 30) {
  const E = require("./engine.js");
  const { isBlockedSender } = require("./db.js");
  const mailbox = mailboxOf(box);
  if (!mailbox) return { box, error: "no mailbox configured" };
  const folders = (rulesets[box] || {}).folders || ["inbox"];
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString().replace(/\.\d{3}Z$/, "Z");

  const emails = await C.getMessages(mailbox, { sinceIso, folders, maxPages: 20 });
  const keyOf = new Map();
  for (const [key, msgs] of E.threadGroup(emails)) for (const m of msgs) keyOf.set(m.id, key);
  const byMsgId = db.prepare("SELECT id FROM work_items WHERE mailbox = ? AND latest_message_id = ?");
  const byKey = db.prepare("SELECT id FROM work_items WHERE mailbox = ? AND conversation_key = ?");

  const missing = emails
    .filter((m) => !byMsgId.get(box, m.id) && !byKey.get(box, keyOf.get(m.id) || ""))
    .map((m) => ({
      received: String(m.received || "").slice(0, 16).replace("T", " "),
      from: String(m.from.address || "").slice(0, 34),
      subject: String(m.subject || "").slice(0, 44),
      still_blocked: isBlockedSender(m.from.address) ? "YES" : "no",
    }));
  return { box, days, scanned: emails.length, missing };
}

module.exports = {
  reconcileBox, reconcileBoxes, candidates, decide, explain, auditBox, missingBox, enabled,
  reopenPass, canReopen, itemForMessage, MAX_ITEMS, REOPEN_DAYS,
};

// CLI: node outlook-close.js [info|drachten|all] [--dry-run] [--list]
// --dry-run also bypasses the allow-list gate, so the pass can be inspected before it is enabled.
// --list additionally prints every item that closed / would close: how old it is and how long it
//   has been sitting untouched, which is what tells a genuine backlog clear-out apart from a
//   queue of live work that merely got previewed in Outlook.
if (require.main === module) {
  (async () => {
    // --explain <itemId>: why is this one item open (or not)? Diagnostic, writes nothing.
    const ex = process.argv.indexOf("--explain");
    if (ex !== -1) {
      const r = await explain(parseInt(process.argv[ex + 1], 10));
      console.log(JSON.stringify(r, null, 2));
      await C.closePool();
      return;
    }
    const arg = process.argv[2];
    const boxes = arg === "all" ? ["info", "drachten"] : arg === "drachten" ? ["drachten"] : ["info"];

    // --audit: everything unread in Outlook, and where it landed in Axle. Diagnostic, writes nothing.
    if (process.argv.includes("--audit")) {
      for (const box of boxes) {
        const a = await auditBox(box);
        console.log(`\n=== ${box} — ${a.unread_in_outlook} unread in Outlook [${(a.folders || []).join(", ")}] ===`);
        if (a.error) console.log("  " + a.error);
        else {
          console.table(a.rows);
          const missing = a.rows.filter((r) => r.axle === "NOT IN AXLE").length;
          const open = a.rows.filter((r) => r.axle.includes("OPEN")).length;
          console.log(`open in Axle: ${open} | closed/archived/blocked: ${a.rows.length - open - missing} | not in Axle: ${missing}`);
        }
      }
      await C.closePool();
      return;
    }

    // --missing [days]: mail that arrived but never became a work item. Diagnostic, writes nothing.
    const mi = process.argv.indexOf("--missing");
    if (mi !== -1) {
      const days = parseInt(process.argv[mi + 1], 10) || 30;
      for (const box of boxes) {
        const a = await missingBox(box, days);
        console.log(`\n=== ${box} — last ${days} days ===`);
        if (a.error) { console.log("  " + a.error); continue; }
        console.log(`scanned ${a.scanned} message(s); ${a.missing.length} never became a work item`);
        if (a.missing.length) console.table(a.missing);
      }
      await C.closePool();
      return;
    }

    const dryRun = process.argv.includes("--dry-run");
    const list = process.argv.includes("--list");
    const reports = await reconcileBoxes(boxes, { dryRun, force: dryRun, list });
    console.table(reports.map(({ items, ...r }) => r));

    if (list) {
      // Two timestamp shapes live in these rows: SQLite's "YYYY-MM-DD HH:MM:SS" (updated_at,
      // written by datetime('now'), UTC but unmarked) and Graph's ISO string (email_received,
      // already carrying T and Z). Normalise the first, leave the second alone.
      const days = (ts) => {
        if (!ts) return null;
        const s = String(ts);
        const ms = Date.parse(/[TZ]/.test(s) ? s : s.replace(" ", "T") + "Z");
        return Number.isNaN(ms) ? null : Math.floor((Date.now() - ms) / 86400000);
      };
      const all = reports.flatMap((r) => r.items || []);
      // Age profile: anything idle for weeks is stale backlog; anything touched in the last day or
      // two is the case worth a second look before enabling.
      const buckets = { "today": 0, "1-2 days": 0, "3-7 days": 0, "8-30 days": 0, "30+ days": 0 };
      const bucket = (d) => (d <= 0 ? "today" : d <= 2 ? "1-2 days" : d <= 7 ? "3-7 days" : d <= 30 ? "8-30 days" : "30+ days");
      const byStatus = {}, byReason = {};
      for (const w of all) {
        buckets[bucket(days(w.updated_at) ?? 999)]++;   // null (unparseable) sorts to the oldest bucket
        byStatus[w.status] = (byStatus[w.status] || 0) + 1;
        byReason[w.reason] = (byReason[w.reason] || 0) + 1;
      }
      console.log("\nBy reason:", byReason);
      console.log("By status:", byStatus);
      console.log("Idle for: ", buckets);
      console.log("\nItems (newest activity first):");
      console.table(
        all
          .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
          .map((w) => ({
            id: w.id, box: w.mailbox, why: w.reason, status: w.status, owner: w.owner,
            idle_days: days(w.updated_at), age_days: days(w.email_received),
            from: String(w.sender_email || "").slice(0, 30),
            subject: String(w.subject || "").slice(0, 42),
          }))
      );
    }
    if (dryRun) console.log("DRY RUN — nothing was changed.");
    await C.closePool();
  })();
}
