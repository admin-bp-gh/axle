// redraft-open.js — re-run every OPEN work item through the current drafting build.
//
// 2026-08-12: the accuracy gates changed what Axle is allowed to say (no VIN claims, no sourcing
// mechanism, only high-confidence statements, interim required on a hold). Items drafted before
// the change still hold their old text, so they are re-drafted once against the new build rather
// than left for a salesperson to find. One-off maintenance, safe to re-run.
//
// Read-only on the business systems (drafting only) and it never sends: exactly the same code
// path as the "Save & redraft" button, one item at a time.
//
//   node C:\Axle\app\redraft-open.js            # all open items, both mailboxes
//   node C:\Axle\app\redraft-open.js --dry      # list what would be redrafted, change nothing
//   node C:\Axle\app\redraft-open.js --id 1249  # a single item
//   node C:\Axle\app\redraft-open.js --limit 5

"use strict";
require("dotenv").config({ path: require("path").join(__dirname, "..", "secrets", ".env"), quiet: true });
const { db, audit } = require("./db.js");   // db.js exports { db, audit, ... }, not the DB itself
const { runRedraft } = require("./routes/shared.js");
const C = require("./connectors.js");

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DRY = has("--dry");
const ONE = parseInt(val("--id", "0"), 10) || 0;
const LIMIT = parseInt(val("--limit", "0"), 10) || 0;
const LOGIN = "system:redraft-open";

(async () => {
  // 'investigating' is excluded: another redraft is already in flight for that item.
  const rows = ONE
    ? db.prepare("SELECT id, mailbox, status, subject FROM work_items WHERE id = ?").all(ONE)
    : db.prepare(
        `SELECT id, mailbox, status, subject FROM work_items
         WHERE status NOT IN ('done','archived','investigating')
         ORDER BY id`
      ).all();

  const todo = LIMIT ? rows.slice(0, LIMIT) : rows;
  console.log(`${todo.length} open item(s) to redraft${DRY ? "  (DRY RUN — nothing will change)" : ""}\n`);
  for (const r of todo) {
    console.log(`  #${r.id}  [${r.mailbox}]  ${r.status.padEnd(14)}  ${String(r.subject || "").slice(0, 60)}`);
  }
  if (DRY || !todo.length) { await C.closePool(); return; }

  console.log("");
  let ok = 0, failed = 0;
  for (const r of todo) {
    process.stdout.write(`#${r.id} ... `);
    try {
      // Mirror the route: mark it investigating so the UI shows "Drafting…" and a concurrent
      // ingest/redraft cannot pick up the same item.
      db.prepare("UPDATE work_items SET status = 'investigating', updated_at = datetime('now') WHERE id = ?").run(r.id);
      audit(LOGIN, "redraft_started", r.id, "bulk redraft onto the accuracy-gates build");
      await runRedraft(r.id, LOGIN);          // awaited: strictly one at a time
      const after = db.prepare("SELECT status, confidence FROM work_items WHERE id = ?").get(r.id);
      console.log(`${after.status} (confidence ${after.confidence})`);
      ok++;
    } catch (e) {
      console.log(`FAILED — ${e.message.slice(0, 120)}`);
      // Never strand an item in 'investigating' because of a crash mid-run.
      db.prepare("UPDATE work_items SET status = 'awaiting_input', updated_at = datetime('now') WHERE id = ? AND status = 'investigating'").run(r.id);
      failed++;
    }
  }
  console.log(`\nDone: ${ok} redrafted, ${failed} failed.`);
  await C.closePool();
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
