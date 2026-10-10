"use strict";
// quick-reply.js - quick-reply mode (2026-10-10, draft review section 8). Pure: no network, no DB.
//
// Most info@ replies written in Outlook instead of Axle were short conversational turns ("Voor welk
// type Land Rover?", "Het is onderweg met UPS."), while Axle answered the same turns with a full
// investigation or a held draft: on items since 10 Sep, 115 newest messages were a short reply in a
// thread we were in, and Axle held 44 % of them or wrote nothing, with a median draft of 47 words.
//
// A QUICK TURN is decided here, in code: the customer's new text (above the quote) is 30 words or
// fewer, carries no files, and the thread is one we are in (we sent on the item, or the quoted part
// is one of our own mails). For a quick turn the drafter gets QUICK_BLOCK (a reply of the
// customer's length, never a held draft) and at most two lookups (engine.agenticDraft
// opts.maxLookups). Brad's Gate 1 answers: two lookups, both mailboxes, and one "Ask the customer"
// button that turns Axle's open questions into a short reply to the customer (ASK_CUSTOMER).
// Off switch: AXLE_QUICK_REPLY=0. Every quick draft is audited as 'quick_reply', which the
// adoption dashboard reads.
const { topOfMessage } = require("./engine.js");

const MAX_WORDS = 30;
const MAX_LOOKUPS = 2;
const enabled = () => process.env.AXLE_QUICK_REPLY !== "0";

// Our own mail in a quoted part: either mailbox, or anything from our two domains.
const OURS = /@(?:budget-parts\.nl|roverparts\.eu)\b/i;

// The customer's new words: the text above the quote, without links and separator lines.
function newWords(text) {
  return topOfMessage(text)
    .replace(/<?https?:\/\/\S+>?/g, " ")
    .split("\n").filter((l) => !/^\s*[_\-=*]{3,}\s*$/.test(l)).join(" ")
    .split(/\s+/).filter(Boolean).length;
}

// Is the newest message a quick turn? text: its plain body; priorSends: our sends on the item before
// it; files: how many attachments it carries.
function isQuickTurn({ text, priorSends = 0, files = 0 }) {
  if (!enabled() || files > 0) return false;
  const words = newWords(text);
  if (!words || words > MAX_WORDS) return false;
  const top = topOfMessage(text);
  const quoted = String(text || "").slice(top.length);
  return priorSends > 0 || OURS.test(quoted);
}

// Our own instruction for a quick turn. Trusted: it is written here, never taken from the email.
const QUICK_BLOCK =
  "<quick_reply_mode>\n" +
  "The customer's newest message is a short reply in a conversation we are already having. Answer it the way a colleague would in a quick email: " +
  "match the customer's length, one to three short lines, plus the greeting and sign-off. No recap of the order or the earlier conversation, no links, no prices and no policy unless the customer asked for them. " +
  `You may use at most ${MAX_LOOKUPS} lookups, only when the customer's question needs a fact (an order's status, whether a part is in stock). ` +
  "Never hold this reply with a holding message: when you cannot answer, either ask the customer the one thing that is missing (status ready, the draft is that short question), " +
  "or, when only our staff can answer, set status awaiting_input with exactly ONE short question in questions_for_salesperson and leave interim_draft empty. " +
  "If the message only thanks us or closes the matter, the NO REPLY NEEDED rule applies as usual.\n" +
  "</quick_reply_mode>\n\n";

// The seed block for "Ask the customer": a salesperson pressed the button on the open questions.
function askCustomerSeed(openQuestions) {
  return {
    note: "TRUSTED instruction from our own staff: the salesperson pressed 'Ask the customer'. Write a short reply (status ready) that asks the customer, in their language, " +
      "only those of the questions below that the customer can answer themselves (their vehicle, model, year, VIN, which version, a photo, a measurement). One short line of context at most, then the questions. " +
      "Questions only our staff can answer (stock checks, supplier answers, a look at a shelf) stay in questions_for_salesperson and are not put to the customer. Nothing else goes in this reply.",
    questions: openQuestions,
  };
}

module.exports = { isQuickTurn, newWords, QUICK_BLOCK, askCustomerSeed, enabled, MAX_WORDS, MAX_LOOKUPS };
