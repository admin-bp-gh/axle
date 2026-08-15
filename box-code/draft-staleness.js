// draft-staleness.js - is a stored draft still the draft for the email the item is
// currently showing?
//
// WHY THIS EXISTS (2026-08-15, item 1308). A work item is keyed on the conversation, so when a
// customer replies on an existing thread the SAME item reopens on the new message. Ingest then
// re-briefs it, but it only INSERTS a draft row when the run produces one: a no_reply outcome
// (which sets suggest_close) and a run that errors both write none. The item view picks the newest
// AI draft by version, so in that case it fell back to the PREVIOUS round's draft and presented it
// as the reply to the current email.
//
// On 1308 the customer wrote "the package was in my mailbox now" and the send box still held the
// earlier "your parcel is stuck in Norway, check your local pickup point" text. Axle had actually
// read the follow-up correctly - summary "customer confirms receipt of previously delayed package;
// issue resolved", suggest_close set - but the stale draft beside it said otherwise, and that is
// what a salesperson reads. 85 of the 691 drafted items in the 15 Aug 2026 backup were in this
// state, so this is a standing 12% misread, not a one-off.
//
// THE TEST. A draft is always written after the email that prompted it (ingest classifies, then
// drafts, then inserts), so created_at earlier than email_received means the draft belongs to an
// earlier message in the thread. Both are UTC: drafts.created_at is SQLite datetime('now')
// ("YYYY-MM-DD HH:MM:SS", no zone marker), work_items.email_received is the Graph ISO instant.
//
// Deliberately conservative - anything it cannot parse is NOT called stale, so a bad timestamp
// keeps today's behaviour instead of blanking someone's draft. Compose items have no inbound email
// and are exempt by the same rule (email_received is NULL on all of them).

// SQLite local-datetime string -> ms. Accepts the ISO form too, so it does not matter which
// column is passed in. Returns NaN for anything unparseable.
function parseUtc(v) {
  if (v == null) return NaN;
  const s = String(v).trim();
  if (!s) return NaN;
  // "YYYY-MM-DD HH:MM:SS" (SQLite, UTC, no zone marker) -> pin it to UTC explicitly.
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) {
    return Date.parse(s.replace(" ", "T") + "Z");
  }
  return Date.parse(s); // already carries a zone (Graph ISO)
}

// item: a work_items row (needs origin + email_received). row: a drafts row (needs created_at).
function isSupersededDraft(item, row) {
  if (!item || !row) return false;
  if (item.origin && item.origin !== "inbound") return false; // compose: no inbound email to be stale against
  const recv = parseUtc(item.email_received);
  const made = parseUtc(row.created_at);
  if (!Number.isFinite(recv) || !Number.isFinite(made)) return false;
  return made < recv;
}

module.exports = { isSupersededDraft, parseUtc };
