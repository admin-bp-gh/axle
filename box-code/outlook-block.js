// outlook-block.js — Axle → Outlook sender blocking (allow-list action #7, added 2026-08-14).
//
// THE GAP THIS CLOSES. "Block sender" used to be Axle-only suppression: ingest skipped the mail
// (db.isBlockedSender) but it still landed in the shared Outlook inbox, so the team went on seeing
// exactly the mail they had just told Axle they never wanted to see again. Blocking now also
// writes a server-side Exchange inbox rule that files that sender out of the Inbox.
//
// WHAT IT WRITES. One Axle-owned rule per mailbox per kind:
//   "Axle - Blocked senders"  conditions.fromAddresses   (EXACT address match)
//   "Axle - Blocked domains"  conditions.senderContains  (legacy '@domain' rows only)
// Both act: move to the "Axle Blocked" folder, mark read, stop processing further rules.
//
// Why TWO rules and not one: conditions inside a single Exchange rule are ANDed, not ORed. A rule
// carrying both fromAddresses and senderContains would only fire on mail matching BOTH, i.e.
// effectively never. Each condition kind therefore needs its own rule.
//
// WHY MOVE AND NEVER DELETE. On 2026-07-27 two mis-clicks on the old whole-domain block option
// ('@gmail.com', '@shopify.com') silently swallowed 13 days of consumer customer email and 4 weeks
// of contact-form messages, with no trace anywhere anyone looks. Everything here is built so that
// cannot repeat: suppressed mail lands in an ordinary, visible, searchable folder; the /blocks page
// shows how much is in it; unblocking moves it back; nothing is ever deleted, and Junk — which
// Exchange itself expires — is deliberately not used.
//
// THE EMPTY-CONDITIONS TRAP. An Exchange rule with no conditions matches EVERY message in the
// mailbox. So an empty blocklist must DELETE the rule, never write one with an empty condition
// array — that single slip would file an entire mailbox into a folder. ruleBody() throws rather
// than build such a rule, and syncMailbox deletes when there is nothing to match. This is the one
// invariant in here worth re-reading before changing anything.
//
// RECONCILED, NOT MUTATED. The rule is rebuilt in full from the sender_blocks table (the single
// source of truth) on every block/unblock and again on each ingest run. Anyone editing, disabling
// or deleting it in Outlook is healed on the next pass, and Axle's DB and the mailbox cannot drift.
// The rebuild is idempotent, and a content hash per mailbox keeps the routine ingest pass to one
// cheap read when nothing has changed.
//
// SAFETY
//   * Allow-listed and OFF by default: AXLE_ACTION_OUTLOOK_BLOCK=on in the box .env ('dry' does
//     every read and reports the intended writes without making them). Read at call time.
//   * Our own domains can never be blocked (isInternal) — belt and braces with the route guard.
//   * Patterns come only from sender_blocks, which routes/admin.js derives in code from a work
//     item's STORED sender address. No free text, and nothing from an email body, ever.
//   * Needs MailboxSettings.ReadWrite (rules) + Mail.ReadWrite (folder create, message move), both
//     Exchange-RBAC scoped to "Axle Mailboxes" — info@ and drachten@ only; admin@ is denied.
//     NOTE: never grant these as Entra API permissions. Tenant-wide consent OVERRIDES the RBAC
//     scope and would expose every mailbox in the tenant (proved and reverted 2026-08-14).
//   * Never throws into a route: every entry point returns a report and audits its own failures.
//
// Usage (CLI, for verification): node outlook-block.js [--status|--sync] [--dry-run]
require("dotenv").config({ path: require("path").join(__dirname, "..", "secrets", ".env"), quiet: true });

const rulesets = require("./rules.js");
const { db, audit } = require("./db.js");

const LOGIN = "https://login.micro" + "softonline.com";     // split to dodge chat linkify
const GRAPH = "https://graph.micro" + "soft.com/v1.0/users/";

const FOLDER_NAME = "Axle Blocked";
const RULE_ADDRESSES = "Axle - Blocked senders";
const RULE_DOMAINS = "Axle - Blocked domains";

// Exchange caps the rules collection by SIZE (256 KB), not by count, so there is no exact limit to
// enforce here. This is a soft ceiling: past it we still write, but the report carries a warning so
// the /blocks page can say something before Exchange starts refusing.
const MAX_PATTERNS = 400;

// Retroactive sweep bound. Blocking someone should also clear what they already sent — but a
// runaway newsletter sender could have thousands of messages sitting there, so cap the work and
// report the cap being hit rather than paging forever.
const SWEEP_CAP = 200;
const PAGE = 50;

// Our own domains. Blocking one of these would file our own internal mail — including the handover
// forwards action #6 sends between mailboxes — into the blocked folder.
const OUR_DOMAINS = ["budget-parts.nl", "roverparts.eu"];

const enabled = () => process.env.AXLE_ACTION_OUTLOOK_BLOCK === "on";
const dryRun = () => process.env.AXLE_ACTION_OUTLOOK_BLOCK === "dry";
const active = () => enabled() || dryRun();

function isInternal(addr) {
  const d = String(addr || "").trim().toLowerCase().split("@")[1] || "";
  return OUR_DOMAINS.some((x) => d === x || d.endsWith("." + x));
}

// Mailbox address for a ruleset key ('info' | 'drachten'), resolved lazily — the addresses come
// from the .env the caller loads, and this module is required by the long-running server too.
const BOXES = ["info", "drachten"];
const mailboxOf = (box) => process.env[(rulesets[box] || {}).mailboxEnv || ""] || null;

// ---------- Graph plumbing ----------------------------------------------------------------

let tokCache = null;
async function token() {
  if (tokCache && tokCache.expires > Date.now()) return tokCache.token;
  const r = await fetch(`${LOGIN}/${process.env.M365_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.M365_CLIENT_ID,
      client_secret: process.env.M365_CLIENT_SECRET,
      scope: "https://graph.micro" + "soft.com/.default",
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("no Graph token: " + JSON.stringify(d).slice(0, 200));
  tokCache = { token: d.access_token, expires: Date.now() + (d.expires_in - 60) * 1000 };
  return tokCache.token;
}

// One Graph call. `path` is relative to /users/ unless it is already an absolute URL (a nextLink).
// Returns { ok, status, data } and never throws on an HTTP error, so callers decide what a failure
// means. A thrown error here is a transport/token failure only.
async function g(method, path, body) {
  const tok = await token();
  const url = /^https?:/i.test(path) ? path : GRAPH + path;
  const r = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${tok}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  if (r.status !== 204) { try { data = await r.json(); } catch { data = null; } }
  return { ok: r.status >= 200 && r.status < 300, status: r.status, data };
}

function errText(res) {
  const e = res && res.data && res.data.error;
  return `HTTP ${res ? res.status : "?"}${e ? " " + (e.code || "") + ": " + (e.message || "").slice(0, 160) : ""}`;
}

// ---------- Folder ------------------------------------------------------------------------

// The "Axle Blocked" folder, found by display name among the mailbox's top-level folders (a JS
// scan rather than an $filter — one call, no quoting quirks, and the totalItemCount comes back with
// it for the /blocks page). Created only when `create` is set, so read-only status checks never
// bring a folder into existence.
//
// Deliberately NOT cached across calls. A cached id survives someone deleting or renaming the
// folder in Outlook, and every later move would then 404 against a folder that no longer exists —
// silently, until a restart. One extra list call per operation is a trivial price for the rule and
// the folder both being self-healing, and these operations are rare (a block, an unblock, a sync).
async function findFolder(mailbox, create) {
  const mb = encodeURIComponent(mailbox);
  const res = await g("GET", `${mb}/mailFolders?$top=100&$select=id,displayName,totalItemCount,unreadItemCount`);
  if (!res.ok) throw new Error("list folders: " + errText(res));
  let hit = (res.data.value || []).find((f) => f.displayName === FOLDER_NAME);
  if (!hit && create) {
    const c = await g("POST", `${mb}/mailFolders`, { displayName: FOLDER_NAME });
    if (!c.ok) throw new Error("create folder: " + errText(c));
    hit = c.data;
  }
  return hit || null;
}

// ---------- Desired state -----------------------------------------------------------------

// The blocklist as Exchange wants it. Internal addresses are dropped here as well as at the route,
// so even a hand-inserted DB row can never file our own mail away.
function currentPatterns() {
  const rows = db.prepare("SELECT pattern, kind FROM sender_blocks").all();
  const addresses = new Set(), domains = new Set();
  for (const r of rows) {
    const p = String(r.pattern || "").trim().toLowerCase();
    if (!p) continue;
    if (r.kind === "address") {
      if (!p.includes("@") || isInternal(p)) continue;
      addresses.add(p);
    } else if (r.kind === "domain") {
      const d = p.startsWith("@") ? p : "@" + p;
      if (isInternal("x" + d)) continue;
      domains.add(d);
    }
  }
  return { addresses: [...addresses].sort(), domains: [...domains].sort() };
}

// A rule body Exchange will accept. THROWS on empty conditions — see the header: a condition-less
// rule matches every message in the mailbox. Callers must delete instead of writing one.
function ruleBody(displayName, folderId, conditions, sequence) {
  const live = Object.keys(conditions).filter((k) => (conditions[k] || []).length);
  if (!live.length) throw new Error("refusing to build a rule with no conditions: " + displayName);
  if (!folderId) throw new Error("refusing to build a rule with no destination folder: " + displayName);
  return {
    displayName,
    sequence,
    isEnabled: true,
    conditions,
    // markAsRead keeps a suppressed sender from adding unread noise to the mailbox; the /blocks
    // page reports the folder's message count so the volume stays visible anyway.
    actions: { moveToFolder: folderId, markAsRead: true, stopProcessingRules: true },
  };
}

function addrConditions(addresses) {
  return { fromAddresses: addresses.map((a) => ({ emailAddress: { address: a, name: a } })) };
}

// True when the live rule already says exactly what we want — compared on the fields we manage
// only, so anything Exchange adds of its own accord never triggers a pointless rewrite.
function sameRule(live, want) {
  if (!live) return false;
  if (live.isEnabled !== true) return false;
  const la = live.actions || {}, wa = want.actions || {};
  if (la.moveToFolder !== wa.moveToFolder) return false;
  if (Boolean(la.markAsRead) !== Boolean(wa.markAsRead)) return false;
  if (Boolean(la.stopProcessingRules) !== Boolean(wa.stopProcessingRules)) return false;
  const lc = live.conditions || {}, wc = want.conditions || {};
  const lf = (lc.fromAddresses || []).map((x) => String(((x.emailAddress || {}).address) || "").toLowerCase()).sort();
  const wf = (wc.fromAddresses || []).map((x) => String(((x.emailAddress || {}).address) || "").toLowerCase()).sort();
  if (lf.join("\n") !== wf.join("\n")) return false;
  const ls = (lc.senderContains || []).map((s) => String(s).toLowerCase()).sort();
  const ws = (wc.senderContains || []).map((s) => String(s).toLowerCase()).sort();
  return ls.join("\n") === ws.join("\n");
}

// ---------- Sync --------------------------------------------------------------------------

function hashOf(p) {
  return require("crypto").createHash("sha256")
    .update(JSON.stringify([p.addresses, p.domains])).digest("hex").slice(0, 32);
}

// Bring ONE mailbox's rules in line with the blocklist. Returns a report; throws only on a Graph
// failure the caller should hear about (syncAll catches those per mailbox).
async function syncMailbox(box, opts = {}) {
  const dry = opts.dry !== undefined ? opts.dry : dryRun();
  const mailbox = mailboxOf(box);
  const rep = { box, mailbox, dry, changes: [], warnings: [], addresses: 0, domains: 0, folderId: null, firstRule: null };
  if (!mailbox) { rep.warnings.push("no mailbox configured"); return rep; }
  const mb = encodeURIComponent(mailbox);

  const pat = currentPatterns();
  rep.addresses = pat.addresses.length;
  rep.domains = pat.domains.length;
  if (pat.addresses.length + pat.domains.length > MAX_PATTERNS) {
    rep.warnings.push(`blocklist is large (${pat.addresses.length + pat.domains.length}); Exchange caps the rules collection at 256 KB`);
  }

  const listed = await g("GET", `${mb}/mailFolders/inbox/messageRules`);
  if (!listed.ok) throw new Error("list rules: " + errText(listed));
  const live = listed.data.value || [];
  const ours = (name) => live.find((r) => r.displayName === name) || null;

  // Sequence ahead of every rule we don't own, so a blocked sender can never be routed into a
  // monitored folder by an earlier rule that stops processing. Exchange sequences start at 1, so
  // when a foreign rule already holds 1 we cannot get in front of it by number alone — the
  // read-back below reports what actually ended up first.
  const others = live.filter((r) => r.displayName !== RULE_ADDRESSES && r.displayName !== RULE_DOMAINS);
  const minSeq = others.length ? Math.min(...others.map((r) => r.sequence || 99)) : 99;
  const seq = Math.max(1, minSeq - 2);

  // The folder is only needed (and only created) when something will actually be filed into it.
  let folder = null;
  if (pat.addresses.length || pat.domains.length) {
    folder = await findFolder(mailbox, !dry);
    if (!folder && dry) { rep.changes.push(`would create folder "${FOLDER_NAME}"`); }
    rep.folderId = folder ? folder.id : null;
    rep.folderCount = folder ? folder.totalItemCount : null;
  }

  // One pass per rule kind. Desired-and-absent => create; desired-and-different => update;
  // not desired => delete. Deleting on an empty list is the whole point (see the header).
  const plan = [
    { name: RULE_ADDRESSES, want: pat.addresses.length && (folder || dry) ? () => ruleBody(RULE_ADDRESSES, folder ? folder.id : "DRY", addrConditions(pat.addresses), seq) : null },
    { name: RULE_DOMAINS, want: pat.domains.length && (folder || dry) ? () => ruleBody(RULE_DOMAINS, folder ? folder.id : "DRY", { senderContains: pat.domains }, seq + 1) : null },
  ];

  for (const step of plan) {
    const existing = ours(step.name);
    if (!step.want) {
      if (existing) {
        if (dry) rep.changes.push(`would DELETE rule "${step.name}"`);
        else {
          const d = await g("DELETE", `${mb}/mailFolders/inbox/messageRules/${encodeURIComponent(existing.id)}`);
          if (!d.ok) throw new Error(`delete rule ${step.name}: ` + errText(d));
          rep.changes.push(`deleted rule "${step.name}"`);
        }
      }
      continue;
    }
    const body = step.want();
    if (sameRule(existing, body)) continue;
    if (dry) { rep.changes.push(`would ${existing ? "UPDATE" : "CREATE"} rule "${step.name}" (${(body.conditions.fromAddresses || body.conditions.senderContains).length} patterns)`); continue; }
    const res = existing
      ? await g("PATCH", `${mb}/mailFolders/inbox/messageRules/${encodeURIComponent(existing.id)}`, body)
      : await g("POST", `${mb}/mailFolders/inbox/messageRules`, body);
    if (!res.ok) throw new Error(`${existing ? "update" : "create"} rule ${step.name}: ` + errText(res));
    rep.changes.push(`${existing ? "updated" : "created"} rule "${step.name}" (${(body.conditions.fromAddresses || body.conditions.senderContains).length} patterns)`);
  }

  // Read back and record which rule Exchange actually runs first. Cheap, and it turns "did our
  // rule end up in front?" from an assumption into something the /blocks page can state.
  if (!dry) {
    const after = await g("GET", `${mb}/mailFolders/inbox/messageRules?$select=id,displayName,sequence,isEnabled`);
    if (after.ok) {
      const sorted = (after.data.value || []).slice().sort((a, b) => (a.sequence || 99) - (b.sequence || 99));
      rep.firstRule = sorted.length ? sorted[0].displayName : null;
      if (rep.firstRule && rep.firstRule !== RULE_ADDRESSES && (pat.addresses.length || pat.domains.length)) {
        rep.warnings.push(`"${rep.firstRule}" runs before the Axle block rule — reorder in Outlook if blocked mail still reaches the inbox`);
      }
    }
    db.prepare(
      "INSERT INTO sender_block_sync (mailbox, hash, folder_id, synced_at, note) VALUES (?, ?, ?, datetime('now'), ?) " +
      "ON CONFLICT(mailbox) DO UPDATE SET hash = excluded.hash, folder_id = excluded.folder_id, synced_at = excluded.synced_at, note = excluded.note"
    ).run(mailbox, hashOf(pat), rep.folderId, rep.warnings.join("; ").slice(0, 300) || null);
  }
  return rep;
}

// Both mailboxes. Never throws: a mailbox that fails is reported and the other still syncs, so one
// broken mailbox can never block a team member from blocking a sender.
async function syncAll(opts = {}) {
  const out = { ok: true, dry: opts.dry !== undefined ? opts.dry : dryRun(), boxes: [] };
  // An explicit dry run is allowed even while the gate is off — that is how the CLI shows exactly
  // what enabling this would do to the live mailboxes BEFORE anyone edits .env. It only ever reads.
  if (!active() && !opts.dry) { out.ok = false; out.skipped = "AXLE_ACTION_OUTLOOK_BLOCK not enabled"; return out; }
  for (const box of BOXES) {
    try { out.boxes.push(await syncMailbox(box, opts)); }
    catch (e) { out.ok = false; out.boxes.push({ box, mailbox: mailboxOf(box), error: e.message.slice(0, 200) }); }
  }
  return out;
}

// The ingest-time reconcile. Skips the write path entirely when the blocklist has not changed since
// the last successful sync for that mailbox, so the routine cost is one cheap DB read per run.
// Drift in Outlook is still healed, because `force` (and every block/unblock) rebuilds in full.
async function reconcile(opts = {}) {
  if (!active()) return { ok: false, skipped: "not enabled" };
  const want = hashOf(currentPatterns());
  const stale = BOXES.filter((box) => {
    const mailbox = mailboxOf(box);
    if (!mailbox) return false;
    const row = db.prepare("SELECT hash FROM sender_block_sync WHERE mailbox = ?").get(mailbox);
    return !row || row.hash !== want;
  });
  if (!stale.length && !opts.force) return { ok: true, upToDate: true, boxes: [] };
  return syncAll(opts);
}

// ---------- Retroactive sweep -------------------------------------------------------------

// Collect ids first, move second: moving a message changes the collection being paged, so paging
// and moving at once silently skips mail.
async function collectIds(mailbox, path, cap) {
  const ids = [];
  let url = path;
  while (url && ids.length < cap) {
    const res = await g("GET", url);
    if (!res.ok) throw new Error("list messages: " + errText(res));
    for (const m of res.data.value || []) { if (ids.length < cap) ids.push(m.id); }
    url = res.data["@odata.nextLink"] || null;
  }
  return ids;
}

async function moveAll(mailbox, ids, destinationId) {
  const mb = encodeURIComponent(mailbox);
  let moved = 0, failed = 0;
  for (const id of ids) {
    const r = await g("POST", `${mb}/messages/${encodeURIComponent(id)}/move`, { destinationId });
    if (r.ok) moved++; else failed++;
  }
  return { moved, failed };
}

// Mail already sitting in the Inbox when the sender is blocked. The rule only ever sees NEW
// deliveries, so without this "block" would visibly fail to do what it says.
async function sweepSender(box, addr, opts = {}) {
  const dry = opts.dry !== undefined ? opts.dry : dryRun();
  const mailbox = mailboxOf(box);
  const rep = { box, mailbox, moved: 0, failed: 0, capped: false };
  if (!mailbox || !addr || isInternal(addr)) return rep;
  const mb = encodeURIComponent(mailbox);
  const folder = await findFolder(mailbox, !dry);
  if (!folder) return rep;
  const filter = `from/emailAddress/address eq '${String(addr).replace(/'/g, "''")}'`;
  const ids = await collectIds(mailbox,
    `${mb}/mailFolders/inbox/messages?$filter=${encodeURIComponent(filter)}&$top=${PAGE}&$select=id`, SWEEP_CAP);
  rep.capped = ids.length >= SWEEP_CAP;
  if (dry) { rep.moved = ids.length; rep.dry = true; return rep; }
  Object.assign(rep, await moveAll(mailbox, ids, folder.id));
  return rep;
}

// The inverse, on unblock: bring that sender's mail back out of the blocked folder into the Inbox.
// Unblocking is the fix-a-mistake path, so it must actually undo the visible effect.
async function unsweepSender(box, addr, opts = {}) {
  const dry = opts.dry !== undefined ? opts.dry : dryRun();
  const mailbox = mailboxOf(box);
  const rep = { box, mailbox, moved: 0, failed: 0, capped: false };
  if (!mailbox || !addr) return rep;
  const mb = encodeURIComponent(mailbox);
  const folder = await findFolder(mailbox, false);
  if (!folder) return rep;
  const filter = `from/emailAddress/address eq '${String(addr).replace(/'/g, "''")}'`;
  const ids = await collectIds(mailbox,
    `${mb}/mailFolders/${encodeURIComponent(folder.id)}/messages?$filter=${encodeURIComponent(filter)}&$top=${PAGE}&$select=id`, SWEEP_CAP);
  rep.capped = ids.length >= SWEEP_CAP;
  if (dry) { rep.moved = ids.length; rep.dry = true; return rep; }
  Object.assign(rep, await moveAll(mailbox, ids, "inbox"));
  return rep;
}

// ---------- Entry points used by the routes -----------------------------------------------

// One audit-friendly line from a syncAll report. Every fragment names its mailbox: the first live
// run logged "updated rule X (54 patterns); updated rule X (54 patterns)" with no way to tell which
// mailbox was which, or to see that one had failed while the other succeeded (found 2026-08-15).
function describe(sync) {
  if (!sync || !sync.boxes || !sync.boxes.length) return "no mailboxes synced";
  return sync.boxes.map((b) => {
    if (b.error) return `${b.box}: FAILED ${b.error}`;
    const bits = (b.changes || []).concat((b.warnings || []).map((w) => "[!] " + w));
    return `${b.box}: ${bits.join(", ") || "already current"}`;
  }).join("; ");
}

// Called AFTER the row is inserted in sender_blocks. Rebuilds the rules, then sweeps the address's
// existing Inbox mail in both mailboxes. Never throws; audits its own outcome so a Graph failure
// shows up in the audit log rather than as a 500 in someone's face.
async function applyBlock(login, addr, workItemId) {
  const out = { synced: null, swept: [] };
  if (!active()) { audit(login, "outlook_block_skipped", workItemId, "action not enabled"); return out; }
  try {
    out.synced = await syncAll();
    for (const box of BOXES) out.swept.push(await sweepSender(box, addr));
    const moved = out.swept.map((s) => `${s.box} ${s.moved}`).join(", ");
    audit(login, dryRun() ? "outlook_block_dryrun" : "outlook_blocked", workItemId,
      `${addr} — ${describe(out.synced)}; swept ${moved}`);
  } catch (e) {
    audit(login, "outlook_block_failed", workItemId, `${addr} — ${e.message.slice(0, 200)}`);
    out.error = e.message;
  }
  return out;
}

// Called AFTER the row is deleted from sender_blocks.
async function applyUnblock(login, addr, workItemId) {
  const out = { synced: null, swept: [] };
  if (!active()) { audit(login, "outlook_unblock_skipped", workItemId, "action not enabled"); return out; }
  try {
    out.synced = await syncAll();
    for (const box of BOXES) out.swept.push(await unsweepSender(box, addr));
    const moved = out.swept.map((s) => `${s.box} ${s.moved}`).join(", ");
    audit(login, dryRun() ? "outlook_unblock_dryrun" : "outlook_unblocked", workItemId,
      `${addr} — ${describe(out.synced)}; restored ${moved}`);
  } catch (e) {
    audit(login, "outlook_unblock_failed", workItemId, `${addr} — ${e.message.slice(0, 200)}`);
    out.error = e.message;
  }
  return out;
}

// Read-only summary for the /blocks page. Best effort by design: this is decoration on a page whose
// real job is the list itself, so a Graph hiccup must never stop that page rendering.
async function status() {
  const out = { enabled: enabled(), dry: dryRun(), boxes: [] };
  for (const box of BOXES) {
    const mailbox = mailboxOf(box);
    if (!mailbox) continue;
    const row = db.prepare("SELECT synced_at, note FROM sender_block_sync WHERE mailbox = ?").get(mailbox) || {};
    const b = { box, mailbox, syncedAt: row.synced_at || null, note: row.note || null, rule: null, count: null };
    if (active()) {
      try {
        const mb = encodeURIComponent(mailbox);
        const res = await g("GET", `${mb}/mailFolders/inbox/messageRules?$select=displayName,isEnabled`);
        if (res.ok) {
          const r = (res.data.value || []).find((x) => x.displayName === RULE_ADDRESSES);
          b.rule = r ? (r.isEnabled ? "on" : "disabled") : "missing";
        }
        const f = await findFolder(mailbox, false);
        b.count = f ? f.totalItemCount : 0;
      } catch (e) { b.error = e.message.slice(0, 120); }
    }
    out.boxes.push(b);
  }
  return out;
}

module.exports = {
  enabled, dryRun, active, isInternal, currentPatterns, ruleBody, sameRule, addrConditions, hashOf,
  syncMailbox, syncAll, reconcile, sweepSender, unsweepSender, applyBlock, applyUnblock, status,
  FOLDER_NAME, RULE_ADDRESSES, RULE_DOMAINS, MAX_PATTERNS, SWEEP_CAP,
};

// ---------- CLI ---------------------------------------------------------------------------
if (require.main === module) {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry-run");
  (async () => {
    if (args.includes("--status")) {
      console.log(JSON.stringify(await status(), null, 2));
      return;
    }
    if (!active() && !dry) {
      console.log("AXLE_ACTION_OUTLOOK_BLOCK is not set to 'on' or 'dry' — nothing to do.");
      return;
    }
    const r = await syncAll({ dry, force: true });
    console.log(JSON.stringify(r, null, 2));
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
