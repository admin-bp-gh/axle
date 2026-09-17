// thread-read.js - which OTHER messages in an item's Outlook conversation may be marked read
// when the item is closed.
//
// WHY (item #1308, 2026-08-15). Closing an item marked exactly one message read: the item's
// newest, via routes/shared.js markReadSafe -> latest_message_id. A thread the customer wrote
// into twice therefore left the earlier mail sitting unread in Outlook. Two consequences, both
// bad: the mailbox says "unhandled" while Axle says done, and the outlook-close reopen mirror -
// whose rule is AN ITEM IS LIVE IF ANY MESSAGE IN ITS THREAD IS UNREAD - can pull the item Brad
// just finished straight back onto the list.
//
// THE RULE IS DELIBERATELY NARROW. Axle keys a work item by sender + normalised subject; Outlook
// keys a conversation by conversationId. Those are not the same set. A supplier, a colleague or a
// second customer writing into the same Outlook thread is a SEPARATE Axle item, and marking their
// mail read would hide live work - and, with AXLE_ACTION_OUTLOOK_CLOSE on, then close it. So each
// sibling is resolved back to the Axle item its conversation key maps to:
//
//   no item, or THIS item      -> mark read. It is this item's own mail.
//   a different CLOSED item    -> mark read. Nobody is waiting on it.
//   a different OPEN item      -> LEAVE IT. Someone else's live work.
//
// Pure: no Graph, no DB, no I/O. The caller supplies each sibling's conversation key (computed
// with engine.threadGroup, the same grouping ingest and outlook-close use, so the key looked up
// is the key ingest stored) and a lookup function. That keeps the whole decision table testable.

// Per-close cap. A thread with more unread mail than this is not a normal customer conversation;
// stopping is better than fanning out an unbounded number of PATCHes on a single button press.
const MAX_SIBLINGS = 25;

const isOpen = (w) => w && w.status !== "done" && w.status !== "archived";

// w        - the work item being closed (needs id, latest_message_id)
// siblings - [{ id, key }] every unread message in the item's Outlook conversation
// lookup   - (conversationKey) => work item row {id, status} or null/undefined
// Returns { mark: [id], skip: [{ id, why }] }. Order is preserved; the item's own newest
// message is never included (the caller has already marked it).
function planThreadRead(w, siblings, lookup, max = MAX_SIBLINGS) {
  const out = { mark: [], skip: [] };
  if (!w || !Array.isArray(siblings)) return out;
  const seen = new Set([String(w.latest_message_id || "")]);
  for (const m of siblings) {
    if (!m || !m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    if (out.mark.length >= max) { out.skip.push({ id: m.id, why: "cap" }); continue; }
    const other = m.key ? lookup(m.key) : null;
    if (other && other.id !== w.id && isOpen(other)) {
      out.skip.push({ id: m.id, why: "open item #" + other.id });
      continue;
    }
    out.mark.push(m.id);
  }
  return out;
}

module.exports = { planThreadRead, MAX_SIBLINGS };
