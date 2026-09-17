// unread-sweep.js — which UNREAD messages the ingest sweep may add to a run.
//
// WHY THE SWEEP EXISTS (2026-08-15). Ingest is a watermark poll: each run asks Graph for mail
// received since the last run, across the watched folders. Mail that ARRIVES elsewhere and is
// MOVED IN later is therefore invisible forever — the move mints a new Graph id but keeps the
// original receivedDateTime, which the watermark has long passed. Found live: an admin@ mail that
// landed in Tom's folder on 14 Aug and was moved to the Inbox on 15 Aug never became a work item,
// and nothing surfaced that. Same shape whenever anyone files something back to sales, or drags
// mail out of Archive. So each run now also fetches "unread in the watched folders" and adds what
// the watermark missed.
//
// THE GUARD, which is the whole reason this is a module and not a one-line concat. Ingest treats
// the newest message of a thread as THE message: it rewrites the item's latest_message_id and
// re-drafts from it. But the unread message in a thread is usually NOT the newest — it is the
// customer's original mail several replies back, deliberately marked unread as a to-do (this is
// the #992 shape). Feeding that straight into ingest would reopen settled items and point them at
// stale mail. Marking OLD mail unread is the reopen mirror's job (outlook-close.js), which handles
// it without disturbing the item's newest message. So the sweep adds only what Axle has never
// seen:
//
//   no work item for this thread          -> ADD. This is the moved-mail case the sweep is for.
//   thread exists, message is NEWER than
//     what the item already holds         -> ADD. Genuinely new mail the watermark missed.
//   thread exists, message is not newer   -> SKIP. Old mail; the reopen mirror owns it.
//
// Pure: no Graph, no DB. The caller supplies the conversation key (engine.threadGroup, the same
// grouping ingest stores) and a lookup, so the whole table is testable.

// Per-run cap on ADDED messages. The sweep should be picking up strays; a sudden flood means
// something else is wrong (a folder misconfigured, a mailbox seeded badly), and quietly ingesting
// hundreds of old threads is the worst way to find that out.
const MAX_ADDED = 50;

const ms = (t) => Date.parse(String(t || "")) || 0;

// unread   - mapped messages from the unread fetch, newest-first
// seenIds  - Set of ids the watermark fetch already returned (never add twice)
// keyOf    - (message) => conversation key
// known    - (key) => work item {id, email_received} or null
function sweepAdditions(unread, seenIds, keyOf, known, max = MAX_ADDED) {
  const out = { add: [], skip: [] };
  if (!Array.isArray(unread)) return out;
  for (const m of unread) {
    if (!m || !m.id) continue;
    if (seenIds && seenIds.has(m.id)) continue;              // already in this run's batch
    if (out.add.length >= max) { out.skip.push({ id: m.id, why: "cap" }); continue; }
    const item = known(keyOf(m));
    if (!item) { out.add.push(m); continue; }                // never seen: the moved-mail case
    if (ms(m.received) > ms(item.email_received)) { out.add.push(m); continue; }
    out.skip.push({ id: m.id, why: `older mail on open item #${item.id} — reopen mirror's job` });
  }
  return out;
}

module.exports = { sweepAdditions, MAX_ADDED };
