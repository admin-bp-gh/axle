// migrate-domain-blocks.js — one-off migration, 2026-08-14.
//
// WHY. Whole-domain blocking was removed on 2026-07-27 after two mis-clicks ('@gmail.com',
// '@shopify.com') swallowed weeks of customer mail. The 39 domain rows created BEFORE that day
// survived, because they only ever suppressed mail inside Axle and were therefore harmless enough
// to leave alone. Wiring blocked senders through to a real Exchange inbox rule (outlook-block.js)
// changes that: those rows would start filing whole domains out of the shared Outlook inbox.
//
// Reviewing them against SAP found exactly what the July incident predicted — '@triumphcentre.nl'
// is BRITISH SPORTSCAR CENTRE, 42 invoices, last one six weeks ago. A live customer.
//
// WHAT THIS DOES. Rather than simply deleting the domain rows (which would also stop suppressing
// the genuine newsletter noise inside Axle), it converts each one down to the exact addresses Axle
// actually saw from that domain, taken from its own work_items history, and then removes the domain
// row. Suppression is preserved at the granularity we can justify; the part nobody can justify —
// "and everyone else at this domain, forever" — is dropped. Anything that returns is one click.
//
// Addresses at a domain that Axle never saw are, by definition, not senders anyone has complained
// about. They come back to the inbox, and can be blocked individually if they are a nuisance.
//
// SAFETY: touches only Axle's own SQLite; nothing in Outlook, SAP or Shopify. Prints a full plan
// and changes nothing without --apply. Every insert and delete is written to the audit log.
//
// Usage:  node migrate-domain-blocks.js            (dry run — prints the plan)
//         node migrate-domain-blocks.js --apply    (performs it)
require("dotenv").config({ path: require("path").join(__dirname, "..", "secrets", ".env"), quiet: true });
const { db, audit } = require("./db.js");

const APPLY = process.argv.includes("--apply");
const WHO = "migration-2026-08-14";

// Addresses that must NOT survive the conversion. Reviewed against SAP and against info@'s existing
// Outlook rules on 2026-08-14 (Brad's call). Converting these would carry the mistake down from the
// domain to a specific real person's address, which is worse, not better — it looks deliberate.
// Their domain row still goes; they simply end up not blocked at all, which is the correct state.
const EXCLUDE = new Map([
  ["info@triumphcentre.nl", "BRITISH SPORTSCAR CENTRE (SAP K111340) - 42 invoices, last 2026-06-29. Live customer."],
  ["paolo.nicolai@constrib.com", "exact email on SAP customer card K130314."],
  ["sales@huntersprestige.com", "info@ has a dedicated Outlook rule filing Hunters Prestige to its own folder."],
  ["inkoop@kanaaldijk.nl", "a purchasing department - reads as a business buying from us, not a bulk sender."],
  ["customerservice@dieseltechnic.com", "supplier service channel; their newsletter@ stays blocked separately."],
  ["bap@importautos.nl", "importautos.nl is SAP customer card K126579."],
  ["ellis.blackman@polybush.co.uk", "named individual at a real LR parts brand, not a bulk sender."],
]);

const domains = db.prepare("SELECT * FROM sender_blocks WHERE kind = 'domain' ORDER BY pattern").all();
if (!domains.length) { console.log("No domain rows left — nothing to do."); process.exit(0); }

// Every distinct sender Axle has ever recorded at this domain. Matches the same semantics as
// db.isBlockedSender: the domain itself, or any subdomain of it.
const seenAt = db.prepare(
  "SELECT DISTINCT lower(sender_email) AS addr FROM work_items " +
  "WHERE lower(sender_email) LIKE '%@' || ? OR lower(sender_email) LIKE '%.' || ? ORDER BY 1"
);
const alreadyBlocked = new Set(
  db.prepare("SELECT pattern FROM sender_blocks WHERE kind = 'address'").all().map((r) => r.pattern)
);

let toInsert = 0, noHistory = 0;
const plan = [];
for (const d of domains) {
  const bare = String(d.pattern).replace(/^@/, "").toLowerCase();
  const addrs = seenAt.all(bare, bare).map((r) => r.addr).filter(Boolean);
  const fresh = addrs.filter((a) => !alreadyBlocked.has(a) && !EXCLUDE.has(a));
  if (!addrs.length) noHistory++;
  toInsert += fresh.length;
  plan.push({ row: d, bare, addrs, fresh });
}

console.log(`${domains.length} domain row(s) -> ${toInsert} new address block(s)\n`);
for (const p of plan) {
  console.log(`@${p.bare}`);
  if (!p.addrs.length) console.log("    (no sender ever recorded in Axle — the domain row simply goes)");
  for (const a of p.addrs) {
    if (EXCLUDE.has(a)) console.log(`    KEEP UNBLOCKED  ${a}\n                    ^ ${EXCLUDE.get(a)}`);
    else console.log(`    ${alreadyBlocked.has(a) ? "already blocked" : "block"}  ${a}`);
  }
}
console.log(`\n${noHistory} domain(s) had no recorded sender and convert to nothing.`);
console.log(`${EXCLUDE.size} address(es) deliberately left unblocked (reviewed against SAP and the existing Outlook rules).`);

if (!APPLY) { console.log("\nDRY RUN — nothing changed. Re-run with --apply to perform it."); process.exit(0); }

const run = db.transaction(() => {
  const ins = db.prepare(
    "INSERT OR IGNORE INTO sender_blocks (pattern, kind, reason, added_by, work_item_id) " +
    "VALUES (?, 'address', ?, ?, ?)"
  );
  const del = db.prepare("DELETE FROM sender_blocks WHERE id = ?");
  for (const p of plan) {
    for (const a of p.fresh) {
      ins.run(a.slice(0, 200), `converted from domain block @${p.bare}`, WHO, p.row.work_item_id || null);
      audit(WHO, "sender_blocked", p.row.work_item_id || null, `${a} (address) — converted from @${p.bare}`);
    }
    del.run(p.row.id);
    audit(WHO, "sender_unblocked", p.row.work_item_id || null,
      `${p.row.pattern} (domain) — removed; whole-domain blocking retired 2026-07-27, converted to ${p.fresh.length} address block(s)`);
  }
});
run();

const left = db.prepare("SELECT COUNT(*) AS n FROM sender_blocks WHERE kind = 'domain'").get().n;
const addrs = db.prepare("SELECT COUNT(*) AS n FROM sender_blocks WHERE kind = 'address'").get().n;
console.log(`\nDone. ${left} domain row(s) remain, ${addrs} address block(s) total.`);
