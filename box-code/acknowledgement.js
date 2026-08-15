// acknowledgement.js - should a "no reply needed" item still offer a courtesy line, and is the
// line Axle wrote actually a courtesy line?
//
// WHY THIS EXISTS (2026-08-15, item 1308). The engine returns status='no_reply' when the newest
// message merely closes the conversation - a thank-you, "I have placed the order", "the package was
// in my mailbox now". Until now that meant NO draft at all, so a customer who had been chasing a
// missing parcel for three weeks and finally wrote "found it, have a nice weekend" got silence.
// Closing a thread that was live is worse service than two lines back, and it costs nothing.
//
// It does NOT follow that every no_reply deserves a reply. Most are one-touch noise: a supplier
// notification, an auto-reply, a first-contact "no thanks". Drafting a courtesy line for those puts
// sendable text in front of a salesperson for a thread we were never part of - noise, and an
// invitation to send something nobody needed. So the trigger is evidence of an actual exchange.
//
// TWO INDEPENDENT CHECKS, both must pass:
//   1. shouldAcknowledge - were we in this conversation at all? (policy, decided in code)
//   2. isCourtesyOnly    - is the text Axle wrote actually just a courtesy? (content, not self-report)
// Failing either simply restores the old behaviour: no draft, "No reply needed?", human closes it.
// There is no path here that makes an item MORE sendable than it was before.

// 1. POLICY. "We were in an active exchange" has two reliable traces. A recorded send means Axle
// itself mailed this customer on this item. A REOPEN means the conversation was already a work item
// before this message arrived, so someone had it in hand - which also covers the threads answered
// directly in Outlook, where no send row is ever written (roughly four in five suggest_close items
// in the 15 Aug 2026 data have no Axle send). A brand-new item with no send is first contact, and
// first contact that needs no reply needs no courtesy line either.
function shouldAcknowledge({ isReopen = false, priorSends = 0 } = {}) {
  return Boolean(isReopen) || Number(priorSends) > 0;
}

// 2. CONTENT. An acknowledgement is two sentences of good manners. Anything that commits us to an
// action, quotes money, or hands over a fact is by definition not an acknowledgement - and it has
// arrived through the one path that skips the ordinary "is this true?" scrutiny, because the model
// has just declared the thread closed and stopped investigating. So the text is checked rather than
// trusted, exactly as the accuracy gates check drafts instead of reading fitment_confirmed.
//
// Deliberately blunt: a false positive costs a courtesy line nobody was owed, a false negative puts
// an unchecked promise in the send box.
const MAX_CHARS = 500;

const COMMITMENT = [
  // money and paperwork - never part of a courtesy line
  /\brefund(s|ed|ing)?\b/i, /\bterugbetal/i, /\bterug\s*gestort\b/i,
  /\bcredit\s*note\b/i, /\bcreditnota\b/i, /\bcrediter/i,
  /\binvoice\b/i, /\bfactuur\b/i, /\bvoucher\b/i, /\bdiscount\b/i, /\bkorting\b/i, /\btegoed\b/i,
  /(?:€|eur)\s*\d/i, /\d\s*(?:€|eur)\b/i,
  // shipping facts - if the parcel is the subject, the draft must go through the normal path
  /\btracking\b/i, /\btrack\s*&?\s*trace\b/i, /\bbarcode\b/i,
  // promises of future action. The contraction needs an apostrophe OR a space before the verb —
  // a bare /we\s*ll/ also matches the "well" in "all is well", which is not a promise.
  /\bwe(?:(?:'|’)ll|\s+(?:will|shall))\b/i,
  /\bwe(?:'|’)?\s*(?:are|re) going to\b/i, /\bwe have (?:arranged|sent|shipped|ordered)\b/i,
  /\bwij? (?:zullen|gaan)\b/i, /\bwe sturen\b/i, /\bwe versturen\b/i, /\bwe hebben .{0,20}(?:verstuurd|verzonden|besteld)\b/i,
  // lead times / deadlines
  /\bwithin \d+\b/i, /\bbinnen \d+\b/i, /\b\d+\s*(?:working days|business days|werkdagen|weken|weeks)\b/i,
];

function isCourtesyOnly(text) {
  const s = String(text == null ? "" : text).trim();
  if (!s) return false;
  if (s.length > MAX_CHARS) return false;
  return !COMMITMENT.some((re) => re.test(s));
}

// The one call sites use: keep this acknowledgement, or drop it and behave as before?
function keepAcknowledgement(text, ctx) {
  return shouldAcknowledge(ctx) && isCourtesyOnly(text);
}

module.exports = { shouldAcknowledge, isCourtesyOnly, keepAcknowledgement, MAX_CHARS };
