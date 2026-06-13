// db.js — SQLite data layer for the Axle team tool.
// One work item per conversation (mailbox + conversation_key). All UI actions audit-logged.
const Database = require("better-sqlite3");

const DB_PATH = process.env.AXLE_DB || "C:\\Axle\\data\\axle.db";
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL"); // safe concurrent reads while writing

db.exec(`
CREATE TABLE IF NOT EXISTS work_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox          TEXT NOT NULL,                 -- 'info' | 'drachten'
  conversation_key TEXT NOT NULL,                 -- sender + normalised subject (engine logic)
  sender_email     TEXT NOT NULL,
  sender_name      TEXT,
  subject          TEXT,
  language         TEXT,                          -- 'en' | 'nl'
  intent           TEXT,                          -- classifier intent
  priority         INTEGER,                       -- 1 (high) .. 3 (low)
  status           TEXT NOT NULL DEFAULT 'new',   -- new|investigating|awaiting_input|ready|done|archived
  injection_flag   INTEGER NOT NULL DEFAULT 0,
  brief_md         TEXT,                          -- investigation brief (markdown)
  latest_message_id TEXT,                         -- Graph id of newest inbound email
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (mailbox, conversation_key)
);

CREATE TABLE IF NOT EXISTS questions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER NOT NULL REFERENCES work_items(id),
  kind         TEXT NOT NULL,                     -- 'blocking' | 'physical' | 'optional'
  question     TEXT NOT NULL,
  answer       TEXT,
  answered_by  TEXT,                              -- tailnet user
  answered_at  TEXT
);

CREATE TABLE IF NOT EXISTS drafts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER NOT NULL REFERENCES work_items(id),
  version      INTEGER NOT NULL,
  is_interim   INTEGER NOT NULL DEFAULT 0,        -- interim holding reply vs full reply
  body         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  tailscale_login TEXT PRIMARY KEY,               -- identity from 'tailscale whois'
  display_name    TEXT NOT NULL,
  role            TEXT NOT NULL DEFAULT 'sales'   -- 'sales' | 'admin'
);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL DEFAULT (datetime('now')),
  user         TEXT NOT NULL,
  action       TEXT NOT NULL,                     -- e.g. view_item, answer_question, approve_draft
  work_item_id INTEGER,
  detail       TEXT
);

-- Phase 5: one row per outbound email Axle sends. UNIQUE(draft_id) enforces "one send
-- per approved draft" - a double-click or retry of the same approval cannot send twice.
-- A 'pending' row is reserved before the Graph call and stamped with graph_message_id on
-- success (or deleted on failure so a genuine retry is possible).
CREATE TABLE IF NOT EXISTS sends (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id     INTEGER NOT NULL REFERENCES work_items(id),
  draft_id         INTEGER NOT NULL,
  to_addr          TEXT NOT NULL,
  subject          TEXT,
  body_sha256      TEXT NOT NULL,
  graph_message_id TEXT,                           -- null while pending
  status           TEXT NOT NULL DEFAULT 'pending',-- pending | sent
  sent_by          TEXT NOT NULL,
  sent_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (draft_id)
);

-- On-view translation cache. Axle generates wording in English and customer content
-- stays in the customer's language; this table holds each unique piece of text rendered
-- into a UI language so repeat views cost nothing. Key = sha256(targetLang + text).
CREATE TABLE IF NOT EXISTS translations (
  source_hash TEXT NOT NULL,                       -- sha256 of target_lang then a newline then source
  target_lang TEXT NOT NULL,                       -- 'en' | 'nl'
  text        TEXT NOT NULL,                       -- the translation
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_hash, target_lang)
);

-- Outbound attachments staged on a work item, to go out with the reply. Held in the DB
-- (not on disk) so they survive reloads and are attached at send time. Bytes are base64.
CREATE TABLE IF NOT EXISTS draft_attachments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER NOT NULL REFERENCES work_items(id),
  name         TEXT NOT NULL,
  content_type TEXT,
  size         INTEGER NOT NULL DEFAULT 0,
  content_b64  TEXT NOT NULL,
  added_by     TEXT,
  added_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Single-row cross-process lock for mailbox ingest. Both the scheduled task and the
-- manual "Sync now" button acquire this before running, so two ingests never overlap.
-- running=1 while a run is in flight; a stale lock (>10 min) is considered abandoned.
CREATE TABLE IF NOT EXISTS sync_state (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  running     INTEGER NOT NULL DEFAULT 0,
  started_at  TEXT,
  finished_at TEXT,
  trigger     TEXT
);
INSERT OR IGNORE INTO sync_state (id, running) VALUES (1, 0);
`);

// Lightweight migrations: add columns when the schema evolves. Safe to re-run.
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
}
ensureColumn("work_items", "owner", "TEXT");        // from routing rule
ensureColumn("work_items", "rule_id", "TEXT");      // which rule matched
ensureColumn("work_items", "summary", "TEXT");      // classifier one-liner
ensureColumn("work_items", "confidence", "TEXT");   // draft confidence high|medium|low
ensureColumn("work_items", "email_text", "TEXT");     // newest inbound email body (plain text)
ensureColumn("work_items", "email_received", "TEXT"); // newest inbound received timestamp
ensureColumn("work_items", "attachments_json", "TEXT"); // [{id,name,contentType,size}] of newest inbound
ensureColumn("work_items", "feedback", "TEXT");        // salesperson's freeform guidance for redraft
ensureColumn("work_items", "caller_info", "TEXT");     // voicemail caller match (CardName/code/number)
ensureColumn("work_items", "draft_edit", "TEXT");      // human-edited "reply to send" (persists across reloads; cleared on a fresh AI draft)

// Compose (Phase 6): a work item created from a proactively-composed outbound email rather than an
// inbound one. 'origin' distinguishes them; the compose inputs are stored so a redraft can re-run
// COMPOSE mode (which needs the trusted instruction + resolved customer, not an inbound email).
// The recipient is the deterministically-resolved + human-confirmed address (code-held; never model-set).
ensureColumn("work_items", "origin", "TEXT NOT NULL DEFAULT 'inbound'"); // 'inbound' | 'compose'
ensureColumn("work_items", "compose_instruction", "TEXT"); // salesperson's trusted prompt
ensureColumn("work_items", "compose_customer", "TEXT");    // JSON: resolved customer shown to the model (no address)
ensureColumn("work_items", "recipient", "TEXT");           // resolved + confirmed To address (compose)
ensureColumn("work_items", "scenario", "TEXT");            // optional scenario key

// Contact-form reply (session 8): enrichment for a webshop contact-form item. JSON holding the
// deterministically-parsed form fields, the resolved customer summary, the candidate address set
// and the form-typed default recipient. The recipient is NOT set here — it is human-confirmed in
// the UI (then code-held in work_items.recipient, reusing the compose column) before any send.
ensureColumn("work_items", "contact_form_json", "TEXT");

// Auto-attach (suggested documents): cached result of the read-only resolve+scope filter computed
// at ingest — the SAP documents this inbound email references and that belong to its customer.
// JSON array of classified suggestions for instant render on the detail page. Display-only: the
// actual attach re-renders live from SAP via /attach-doc behind the approval gate.
ensureColumn("work_items", "doc_suggestions_json", "TEXT");

// Per-user work-queue label for the inbox "Assigned to me" filter. Matched against
// work_items.owner (the routing-rule owner). Falls back to display_name when NULL, so a
// user whose display_name already equals their owner label (e.g. "Jack") needs no setup.
ensureColumn("users", "owner_label", "TEXT");

// Editable/sent-reply audit trail (self-improvement layer): keep the AI draft AND what was
// actually sent. drafts.source distinguishes the AI version from the human-sent version;
// sends.body stores the exact text that went to the customer, with source_draft_id linking
// back to the AI draft it was edited from.
ensureColumn("drafts", "source", "TEXT NOT NULL DEFAULT 'ai'"); // 'ai' | 'human'
ensureColumn("drafts", "edited_by", "TEXT");                    // tailnet user who edited/sent (human drafts)
ensureColumn("sends", "body", "TEXT");                          // exact plain text sent (verbatim)
ensureColumn("sends", "source_draft_id", "INTEGER");            // the AI draft this send was edited from (nullable)
ensureColumn("sends", "attachments_json", "TEXT");             // [{name,contentType,size}] sent with the reply

// HOW a closed item was resolved (status stays done/archived; this records the reason):
// 'replied' (set automatically on send) | 'done' (manual mark done) | 'phone' (resolved
// without email, e.g. called the customer) | 'no_action' (archived, nothing needed).
// NULL on open items and on legacy closed items; cleared again on reopen.
ensureColumn("work_items", "resolution", "TEXT");

// Engine-suggested close ("no reply needed"): set when the draft engine returns
// status='no_reply'. The item stays OPEN (status 'new') and a human confirms via the
// existing Done control — never an autonomous close (threat-model T13). Reset on every
// new inbound and re-set per the latest engine result on each (re)draft.
ensureColumn("work_items", "suggest_close", "INTEGER NOT NULL DEFAULT 0");

// Blocked senders (the "ignore future marketing emails" action). Ingest checks this list
// BEFORE rule matching and skips matching mail entirely - Axle-only suppression: the mail
// still arrives in the shared Outlook mailbox. Patterns are derived in code from a work
// item's stored sender address (kind 'address' = exact address, kind 'domain' = '@domain'
// suffix incl. subdomains) - never free text. Global across info@ and drachten@.
db.exec(`
CREATE TABLE IF NOT EXISTS sender_blocks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern      TEXT NOT NULL UNIQUE,
  kind         TEXT NOT NULL,
  reason       TEXT,
  added_by     TEXT NOT NULL,
  added_at     TEXT NOT NULL DEFAULT (datetime('now')),
  work_item_id INTEGER
);
`);

// True when an inbound sender address is on the blocklist (exact address, or a domain
// pattern matching the sender's domain or any subdomain of it). Small table - the domain
// scan in JS keeps the matching rule identical to rules.js senderDomain semantics.
function isBlockedSender(addr) {
  const a = String(addr || "").trim().toLowerCase();
  const domain = a.split("@")[1] || "";
  if (!a || !domain) return false;
  if (db.prepare("SELECT 1 FROM sender_blocks WHERE kind = 'address' AND pattern = ?").get(a)) return true;
  return db.prepare("SELECT pattern FROM sender_blocks WHERE kind = 'domain'").all()
    .some((r) => { const d = String(r.pattern).replace(/^@/, ""); return domain === d || domain.endsWith("." + d); });
}

// Ingest high-water-mark per mailbox (JSON map, e.g. {"info":"2026-06-08T07:00:00Z"}). Each
// ingest reads mail with receivedDateTime >= this watermark (minus a small overlap buffer) and
// advances it to the newest message seen, so a run only ever processes mail new since last sync.
ensureColumn("sync_state", "watermarks", "TEXT");

// Send de-duplication: one send per (item, exact body). Blocks a double-click/refresh from
// emailing the customer twice, while still allowing a deliberately different edited resend.
// Wrapped: a pre-existing duplicate (shouldn't occur) must never crash startup.
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sends_item_body ON sends(work_item_id, body_sha256)"); }
catch (e) { /* legacy duplicate rows present - skip the index, code still pre-checks */ }

function audit(user, action, workItemId = null, detail = null) {
  db.prepare(
    "INSERT INTO audit_log (user, action, work_item_id, detail) VALUES (?, ?, ?, ?)"
  ).run(user, action, workItemId, detail);
}

// Ingest lock (shared by ingest.js and the server's manual Sync). acquireSync returns true
// only if the lock was free (or stale >10 min); the caller must releaseSync in a finally.
function acquireSync(trigger) {
  return db.prepare(
    "UPDATE sync_state SET running = 1, started_at = datetime('now'), finished_at = NULL, trigger = ? " +
    "WHERE id = 1 AND (running = 0 OR started_at < datetime('now', '-10 minutes'))"
  ).run(trigger).changes === 1;
}
function releaseSync() {
  db.prepare("UPDATE sync_state SET running = 0, finished_at = datetime('now') WHERE id = 1").run();
}
function syncStatus() {
  return db.prepare("SELECT running, started_at, finished_at, trigger FROM sync_state WHERE id = 1").get() || { running: 0 };
}

// Per-mailbox ingest watermark (the receivedDateTime of the newest mail already processed).
// Stored as a JSON map in sync_state.watermarks. getWatermark returns null when unset.
function getWatermark(box) {
  const row = db.prepare("SELECT watermarks FROM sync_state WHERE id = 1").get();
  if (!row || !row.watermarks) return null;
  try { return JSON.parse(row.watermarks)[box] || null; } catch (e) { return null; }
}
function setWatermark(box, iso) {
  const row = db.prepare("SELECT watermarks FROM sync_state WHERE id = 1").get();
  let w = {};
  try { w = row && row.watermarks ? JSON.parse(row.watermarks) : {}; } catch (e) { w = {}; }
  w[box] = iso;
  db.prepare("UPDATE sync_state SET watermarks = ? WHERE id = 1").run(JSON.stringify(w));
}

module.exports = { db, audit, acquireSync, releaseSync, syncStatus, getWatermark, setWatermark, isBlockedSender };

// Smoke test when run directly: node db.js
if (require.main === module) {
  audit("system", "db_init", null, "schema created/verified");
  const rows = db.prepare("SELECT COUNT(*) AS n FROM audit_log").get();
  const cols = db.prepare("PRAGMA table_info(work_items)").all().map((c) => c.name).join(", ");
  console.log(`OK — work_items columns: ${cols}. Audit rows: ${rows.n}.`);
}

