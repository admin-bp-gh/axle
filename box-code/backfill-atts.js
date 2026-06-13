// backfill-atts.js - one-off: fetch attachment metadata for existing open work
// items (ingest only does this for new/changed conversations). READ-ONLY on
// Graph; writes only attachments_json in Axle's own SQLite DB. Re-run safe.
// Usage: node backfill-atts.js
require("dotenv").config({ path: "C:\\Axle\\secrets\\.env", quiet: true });
const rulesets = require("./rules.js");
const C = require("./connectors.js");
const { db, audit } = require("./db.js");

const MAILBOX_OF = {
  info: process.env[rulesets.info.mailboxEnv],
  drachten: process.env[rulesets.drachten.mailboxEnv],
};

(async () => {
  const items = db.prepare(
    "SELECT id, mailbox, latest_message_id FROM work_items WHERE status NOT IN ('done','archived') AND latest_message_id IS NOT NULL AND attachments_json IS NULL"
  ).all();
  console.log(`Backfilling attachment metadata for ${items.length} item(s)...`);
  for (const w of items) {
    try {
      const atts = await C.listAttachments(MAILBOX_OF[w.mailbox], w.latest_message_id);
      db.prepare("UPDATE work_items SET attachments_json = ? WHERE id = ?").run(JSON.stringify(atts), w.id);
      console.log(`#${w.id}: ${atts.length ? atts.map((a) => a.name).join(", ") : "none"}`);
    } catch (e) {
      console.log(`#${w.id}: FAILED - ${e.message.slice(0, 120)}`);
    }
  }
  audit("system", "backfill_attachments", null, `${items.length} item(s) processed`);
  console.log("Done.");
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
