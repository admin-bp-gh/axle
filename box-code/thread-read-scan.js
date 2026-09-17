// thread-read-scan.js — DRY RUN for the whole-thread mark-read (item #1308).
// Repo-only dev helper: not part of the server, deployed only on request. Copy it into
// C:\Axle\app and run it there — it needs the live .env, node_modules and axle.db.
//
//   Copy-Item C:\Admin\Projects\Axle\box-code\thread-read-scan.js C:\Axle\app\ -Force
//   cd C:\Axle\app ; node thread-read-scan.js [limit] [--all]
//
// For each OPEN inbound item it asks Graph how many messages in that item's Outlook conversation
// are unread, then runs the real thread-read.js decision over them. WRITES NOTHING: it reports
// what pressing Done would mark read, so a candidate for the live check can be picked with the
// guard's behaviour already visible.
//
// --all  also lists messages that are already READ, and prints every item rather than only the
//        interesting ones. Use it to find a thread big enough to test with when the open queue
//        happens to hold nothing but single-message conversations.
process.env.AXLE_DB = process.env.AXLE_DB || "C:\\Axle\\data\\axle.db";   // never guess the DB
require("dotenv").config({ path: require("path").join(__dirname, "..", "secrets", ".env"), quiet: true });

const rulesets = require("./rules.js");
const SEND = require("./send.js");
const E = require("./engine.js");
const TR = require("./thread-read.js");
const { db } = require("./db.js");

const ARGS = process.argv.slice(2);
const ALL = ARGS.includes("--all");
const LIMIT = Number(ARGS.find((a) => /^\d+$/.test(a)) || 25);   // items to scan (2 Graph reads each)
const MAILBOX_OF = { info: process.env[rulesets.info.mailboxEnv], drachten: process.env[rulesets.drachten.mailboxEnv] };

(async () => {
  const items = db.prepare(
    `SELECT id, mailbox, subject, sender_email, status, latest_message_id
       FROM work_items
      WHERE origin = 'inbound'
        AND status NOT IN ('done','archived')
        AND latest_message_id IS NOT NULL AND TRIM(latest_message_id) <> ''
      ORDER BY updated_at DESC
      LIMIT ?`).all(LIMIT);

  console.log(`Scanning ${items.length} open item(s). Nothing is written.\n`);
  const byKey = db.prepare("SELECT id, status FROM work_items WHERE mailbox = ? AND conversation_key = ?");
  let candidates = 0;

  for (const w of items) {
    const mailbox = MAILBOX_OF[w.mailbox];
    // The plan is always computed over the UNREAD set — that is what markReadSafe acts on.
    // --all additionally fetches the read messages, purely so the whole thread is visible.
    const found = await SEND.conversationMessages(mailbox, w.latest_message_id, { unreadOnly: true });
    if (!found.ok) { console.log(`#${w.id}  [read failed: ${found.reason}]`); continue; }
    const whole = ALL ? await SEND.conversationMessages(mailbox, w.latest_message_id) : null;

    const keyOf = new Map();
    for (const [key, msgs] of E.threadGroup(found.messages)) for (const m of msgs) keyOf.set(m.id, key);
    const plan = TR.planThreadRead(w, found.messages.map((m) => ({ id: m.id, key: keyOf.get(m.id) })),
                                   (key) => byKey.get(w.mailbox, key));

    // Only the interesting ones: a thread with mail besides the item's own newest message.
    if (!ALL && !plan.mark.length && !plan.skip.length) continue;
    if (plan.mark.length || plan.skip.length) candidates++;
    console.log(`#${w.id}  ${w.mailbox}  ${w.status}  ${String(w.subject || "").slice(0, 60)}`);
    console.log(`     ${found.messages.length} unread in the conversation` +
                (whole && whole.ok ? ` (${whole.messages.length} message(s) in total)` : "") +
                ` -> Done would mark ${plan.mark.length} extra` +
                (plan.skip.length ? `, leaving ${plan.skip.length} (${plan.skip.map((s) => s.why).join("; ")})` : ""));
    const shown = whole && whole.ok ? whole.messages : found.messages;
    for (const m of shown) {
      const tag = m.id === w.latest_message_id ? "newest (Done marks this one today)"
                : plan.mark.includes(m.id) ? "WOULD MARK READ"
                : m.isRead ? "already read — flip this one to unread to test"
                : "left unread";
      console.log(`       - ${(m.isRead ? "read  " : "UNREAD")} ${String(m.from.address).padEnd(32)} ${String(m.subject).slice(0, 40).padEnd(42)} ${tag}`);
    }
  }
  console.log(`\n${candidates} item(s) with more than one message in play.`);
  process.exit(0);
})();
