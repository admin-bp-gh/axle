"use strict";
// backfill-conversation-id.js - one-off (15 Oct 2026): fill messages.conversation_id for the rows
// stored before the column existed, so a new email attaches to its conversation's item
// (conversation.js itemByConversation) for older threads too.
//
// Reads every messages row with conversation_id IS NULL, newest first, asks Graph for the message's
// conversationId by its Graph id, and when that id no longer answers (the mail was moved) finds the
// message again by its internet message id. Writes ONLY messages.conversation_id; no other column,
// no other table, nothing in the mailbox. Rows Graph cannot find are left NULL and counted.
//
// Run on the box after the deploy (C:\Axle\app, the live database):
//   node C:\Axle\app\backfill-conversation-id.js --dry      reads Graph, prints what it would write
//   node C:\Axle\app\backfill-conversation-id.js            writes
// Optional: --limit N (rows this run). Safe to run again: it only picks rows still NULL.
require("dotenv").config({ path: require("path").join(__dirname, "..", "secrets", ".env"), quiet: true });
const C = require("./connectors.js");
const MS = require("./message-store.js");
const { db, audit } = require("./db.js");

const DRY = process.argv.includes("--dry");
const li = process.argv.indexOf("--limit");
const LIMIT = li > 0 ? Math.max(1, Number(process.argv[li + 1]) || 0) : 0;
const BATCH = 25;
const DELAY_MS = 150;   // between Graph calls: a few per second, well under Graph's throttling
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function conversationOf(mbx, row) {
  try { return await C.messageConversationId(mbx, row.graph_id); }
  catch (e) {
    if (!row.internet_id) throw e;
    const id = await C.findMessageByInternetId(mbx, row.internet_id);
    if (!id) throw e;
    await sleep(DELAY_MS);
    return C.messageConversationId(mbx, id);
  }
}

(async () => {
  db.pragma("busy_timeout = 5000");   // the server writes to the same database
  const rows = db.prepare("SELECT id, mailbox, graph_id, internet_id FROM messages WHERE conversation_id IS NULL ORDER BY id DESC" + (LIMIT ? ` LIMIT ${LIMIT}` : "")).all();
  const write = db.prepare("UPDATE messages SET conversation_id = ? WHERE id = ? AND conversation_id IS NULL");
  console.log(`${rows.length} message row(s) without a conversation id${DRY ? " (dry run: nothing is written)" : ""}`);
  let filled = 0, missing = 0, failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let mbx;
    try { mbx = MS.mailboxAddress(r.mailbox); } catch (e) { mbx = null; }
    if (!mbx) { failed++; continue; }
    try {
      const conv = await conversationOf(mbx, r);
      if (!conv) missing++;
      else { if (!DRY) write.run(conv, r.id); filled++; }
    } catch (e) {
      failed++;
      if (failed <= 10) console.log(`  row ${r.id}: ${String(e.message || e).slice(0, 120)}`);
    }
    if ((i + 1) % BATCH === 0) console.log(`  ${i + 1}/${rows.length}: ${filled} filled, ${missing} without id, ${failed} not found`);
    await sleep(DELAY_MS);
  }
  const line = `${rows.length} row(s): ${filled} ${DRY ? "would be filled" : "filled"}, ${missing} without id, ${failed} not found in Graph`;
  console.log(line);
  if (!DRY) audit("system", "conversation_id_backfill", null, line);
  await C.closePool();
})().catch((e) => { console.error("backfill-conversation-id:", e.message || e); process.exit(1); });
