"use strict";
// handover.js - an owner change with a note (2026-10-09). The item itself moves to the new
// owner's queue: same id, thread, messages, attachments and drafts; it stays open. What this
// module holds is the RECORD of the handover (work_items.handover_json), the note's sanitiser and
// the two things built from the record: the seed block the drafter reads and the text that rides
// on top of a cross-mailbox forward. Pure: no network, no DB.
const MAX_NOTE = 1000;

// The note is staff input, trusted by the drafter, but it still travels into a plain-text Graph
// comment and into HTML, so it is kept to printable text: no control characters, capped.
function cleanNote(s) {
  return String(s == null ? "" : s)
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, MAX_NOTE);
}

// Build the record stored on the item.
function record({ note, byName, byLogin, fromOwner, toOwner, forwardedTo = null, forwardedBox = null }) {
  return {
    note: cleanNote(note),
    by: String(byName || byLogin || "").trim().slice(0, 80),
    by_login: String(byLogin || "").trim().slice(0, 120),
    from_owner: fromOwner || null,
    to_owner: String(toOwner || ""),
    forwarded_to: forwardedTo,
    forwarded_box: forwardedBox,
    at: new Date().toISOString(),
  };
}

function read(w) {
  if (!w || !w.handover_json) return null;
  try { const h = JSON.parse(w.handover_json); return h && h.to_owner ? h : null; } catch (e) { return null; }
}

// What the drafter gets (seed.handover): the note, who, and our own replies so far (sends), so the
// receiver's draft continues the exchange instead of restarting it.
function seedBlock(h, ourReplies = []) {
  if (!h) return null;
  return {
    note: "TRUSTED input from our own staff: a colleague handed this email over with this note. Follow it; it overrides what the email implies. Never mention the handover to the customer.",
    handed_over_by: h.by, from_owner: h.from_owner, to_owner: h.to_owner, at: h.at,
    colleague_note: h.note || "(no note)",
    our_replies: ourReplies.map((r) => ({ sent_at: r.sent_at, by: r.by, to: r.to, text: String(r.text || "").slice(0, 1500) })),
  };
}

// The forward's plain-text comment: forward-guard's own note (who, from, original sender, link)
// with the colleague's note under it, so the receiver sees it in Outlook too.
function forwardComment(baseNote, note) {
  const n = cleanNote(note);
  return n ? `${baseNote}Note from the colleague:\n${n}\n\n` : baseNote;
}

// Did this inbound email come from our own handover forward? The receiving mailbox re-ingests a
// forward between info@ and drachten@ as a fresh item (rule internal_forward); the handed-over item
// already carries the whole thread, so that copy is skipped. Match: forwarded to this box, in the
// last two days, same subject once the FW: prefix is gone.
const stripFw = (s) => String(s || "").replace(/^((re|fw|fwd|antw|doorst|door)\s*:\s*)+/i, "").trim().toLowerCase();
function isOwnForward(email, boxName, recent) {
  const subj = stripFw(email && email.subject);
  if (!subj) return null;
  const hit = (recent || []).find((r) => {
    const h = read(r);
    return h && h.forwarded_box === boxName && stripFw(r.subject) === subj;
  });
  return hit ? hit.id : null;
}

module.exports = { MAX_NOTE, cleanNote, record, read, seedBlock, forwardComment, isOwnForward, stripFw };
