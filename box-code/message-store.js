// message-store.js - every incoming message of a work item and its attachments (round 2, request 1).
//
// Before this, ingest listed attachments only when Graph said hasAttachments (false for a Gmail or
// phone photo pasted into the body), kept only the newest message's list in attachments_json
// (overwritten on re-open), stored a failed listing as "none", and fetched the bytes live from Graph
// on every view by a message id that dies when the message is moved. Now:
//   - every message Axle sees for an item is a row in `messages` (sender, to, cc, received, body),
//     and the attachments of EVERY message are listed into `message_attachments` (pickAttachments'
//     rules: file attachments, inline images of 15 KB and up; item and reference attachments are
//     left out, as before);
//   - each file is copied to disk beside the database (attachments/<row id>, written atomically,
//     never named after the customer's file) at ingest, lazily on view when missing, and fetched
//     again from Graph when the file has gone. A moved message is found again by its internet
//     message id. Files over MAX_STORE_BYTES are never stored: they are served by a live fetch;
//   - a failed listing or fetch is recorded with its error and retried by the next ingest pass that
//     touches the item, or on view. One slow or failing attachment never fails an ingest. Attempts
//     are counted: after MAX_AUTO_TRIES failures ingest passes leave the row alone, and a person's
//     view retries it at most once per VIEW_RETRY_MIN minutes.
// The folder is a cache (not in the nightly backup): pruneClosed() drops files of emails closed
// more than 90 days ago, keeping the rows, and a later view fetches them again.
"use strict";
const fs = require("fs");
const path = require("path");
const C = require("./connectors.js");
const rulesets = require("./rules.js");
const SEARCH = require("./search.js");
const BASE = require("./base-path.js");
const { db, DB_PATH, audit, getMeta, setMeta } = require("./db.js");

const ATTACH_DIR = path.join(path.dirname(DB_PATH), "attachments");
const MAX_STORE_BYTES = 25 * 1024 * 1024;
const PRUNE_DAYS = 90;
const BACKFILL_FLAG = "messages_backfill_v1";
const MAX_AUTO_TRIES = 5;
const VIEW_RETRY_MIN = 10;
const INLINE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"];
const EXT_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", pdf: "application/pdf" };

const mailboxAddress = (box) => process.env[rulesets[box].mailboxEnv];
const filePath = (attId) => path.join(ATTACH_DIR, String(attId));
const short = (e) => String((e && e.message) || e).slice(0, 200);

// --- Pure decisions -------------------------------------------------------------------------------

// The type a file is treated as: the declared type, lower-cased without parameters; a declared
// "octet-stream" (or nothing) takes the type of one of the five inline-safe extensions.
function effectiveType(contentType, name) {
  let ct = String(contentType || "").split(";")[0].trim().toLowerCase();
  if (ct === "image/jpg" || ct === "image/pjpeg") ct = "image/jpeg";
  if (!ct || ct === "application/octet-stream") {
    const ext = (String(name || "").match(/\.([a-z0-9]+)$/i) || [])[1];
    ct = EXT_TYPES[String(ext || "").toLowerCase()] || "application/octet-stream";
  }
  return ct;
}

// How one attachment is served: inline only for png, jpeg, gif, webp and PDF (served as exactly
// that type, nosniff), everything else (SVG and HTML included) as a download of octet-stream.
// headerName: an ASCII file name with anything outside a safe set replaced, plus the UTF-8 name
// in filename* for the browser to show.
function servePlan(contentType, name) {
  const ct = effectiveType(contentType, name);
  const inline = INLINE_TYPES.includes(ct);
  const raw = String(name || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 150) || "attachment";
  const ascii = raw.replace(/[^\w. ()\[\]-]/g, "_");
  return {
    inline,
    contentType: inline ? ct : "application/octet-stream",
    disposition: `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`,
  };
}

const isShowableImage = (contentType, name) => /^image\/(png|jpeg|gif|webp)$/.test(effectiveType(contentType, name));

// --- Storage ----------------------------------------------------------------------------------------

// One message row for the item, created once. The same mail moved to another folder (new Graph id,
// same internet message id) keeps its row and takes the new id. Returns the row id.
function upsertMessage(itemId, box, m) {
  const byId = db.prepare("SELECT id FROM messages WHERE mailbox = ? AND graph_id = ?").get(box, m.id);
  if (byId) return byId.id;
  if (m.internetMessageId) {
    const moved = db.prepare("SELECT id FROM messages WHERE work_item_id = ? AND internet_id = ?").get(itemId, m.internetMessageId);
    if (moved) {
      db.prepare("UPDATE messages SET graph_id = ?, list_attempts = 0, list_state = CASE WHEN list_state = 'error' THEN 'pending' ELSE list_state END WHERE id = ?").run(m.id, moved.id);
      return moved.id;
    }
  }
  // DO NOTHING: the ingest task and the server (backfill, healing) may store the same message at once.
  const from = m.from || {};
  db.prepare(
    "INSERT INTO messages (work_item_id, mailbox, graph_id, internet_id, from_name, from_addr, to_json, cc_json, received, body) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(mailbox, graph_id) DO NOTHING"
  ).run(itemId, box, m.id, m.internetMessageId || null, from.name || null, from.address || null,
    JSON.stringify(m.to || []), JSON.stringify(m.cc || []), m.received || null, m.text || "");
  return db.prepare("SELECT id FROM messages WHERE mailbox = ? AND graph_id = ?").get(box, m.id).id;
}

// Record a listing (array of pickAttachments entries) or its failure (an Error) on a message row.
function recordListing(msg, result) {
  if (result instanceof Error) {
    db.prepare("UPDATE messages SET list_state = 'error', list_error = ?, list_attempts = list_attempts + 1, list_tried_at = datetime('now') WHERE id = ?").run(short(result), msg.id);
    return;
  }
  const ins = db.prepare(
    "INSERT INTO message_attachments (message_id, work_item_id, graph_att_id, name, content_type, size, is_inline, fetch_state) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id, graph_att_id) DO NOTHING");
  for (const a of result) {
    ins.run(msg.id, msg.work_item_id, String(a.id), String(a.name || "attachment").slice(0, 255), a.contentType || "",
      a.size || 0, a.inline ? 1 : 0, (a.size || 0) > MAX_STORE_BYTES ? "live" : "pending");
  }
  db.prepare("UPDATE messages SET list_state = 'listed', list_error = NULL, list_attempts = 0 WHERE id = ?").run(msg.id);
}

// Write the bytes beside the database: a temp file in the same folder, then a rename.
function writeFile(att, buf) {
  fs.mkdirSync(ATTACH_DIR, { recursive: true });
  const final = filePath(att.id);
  const tmp = `${final}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, buf);
  try { fs.renameSync(tmp, final); }
  catch (e) { try { fs.unlinkSync(tmp); } catch (x) { /* already gone */ } if (!fs.existsSync(final)) throw e; }
  db.prepare("UPDATE message_attachments SET fetch_state = 'stored', file = ?, fetch_error = NULL, attempts = 0, fetched_at = datetime('now') WHERE id = ?")
    .run(String(att.id), att.id);
}

// --- Graph ------------------------------------------------------------------------------------------

// The message's current Graph id when the stored one no longer answers (it was moved): looked up
// by internet message id and saved on the row. Null when that is not possible.
async function relocate(msg, mbx) {
  if (!msg.internet_id) return null;
  const id = await C.findMessageByInternetId(mbx, msg.internet_id);
  if (!id || id === msg.graph_id) return null;
  db.prepare("UPDATE messages SET graph_id = ? WHERE id = ?").run(id, msg.id);
  msg.graph_id = id;
  return id;
}

async function listMessage(msg, mbx) {
  let res;
  try { res = await C.listAttachments(mbx, msg.graph_id); }
  catch (e) {
    try { res = (await relocate(msg, mbx)) ? await C.listAttachments(mbx, msg.graph_id) : e; }
    catch (e2) { res = e2; }
  }
  recordListing(msg, res);
  if (res instanceof Error) audit("system", "attachments_error", msg.work_item_id, `list ${String(msg.graph_id).slice(0, 24)}: ${short(res)}`);
}

// The bytes of one attachment from Graph. When the message has moved, it is found again and the
// attachment matched by name and size (its id changes with the message).
async function fetchBytes(att, msg, mbx) {
  let file;
  try { file = await C.getAttachment(mbx, msg.graph_id, att.graph_att_id); }
  catch (e) {
    if (!(await relocate(msg, mbx).catch(() => null))) throw e;
    const again = (await C.listAttachments(mbx, msg.graph_id)).find((a) => a.name === att.name && a.size === att.size);
    if (!again) throw e;
    db.prepare("UPDATE message_attachments SET graph_att_id = ? WHERE id = ?").run(String(again.id), att.id);
    file = await C.getAttachment(mbx, msg.graph_id, again.id);
  }
  return Buffer.from(file.contentBytes, "base64");
}

const msgRow = (id) => db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
const fetchFailed = (att, e) => db.prepare("UPDATE message_attachments SET fetch_state = 'error', fetch_error = ?, attempts = attempts + 1, tried_at = datetime('now') WHERE id = ?").run(short(e), att.id);

// The SQL condition for "try this failed row again": an ingest pass while it has failed fewer than
// MAX_AUTO_TRIES times; a person's view also later, at most once per VIEW_RETRY_MIN minutes.
const retryDue = (byPerson, attempts, at) => byPerson
  ? `(${attempts} < ${MAX_AUTO_TRIES} OR ${at} IS NULL OR ${at} < datetime('now', '-${VIEW_RETRY_MIN} minutes'))`
  : `${attempts} < ${MAX_AUTO_TRIES}`;

// Fetch and store one attachment; on failure record the error (never throws).
async function fetchOne(att, mbx) {
  try {
    const buf = await fetchBytes(att, msgRow(att.message_id), mbx);
    if (buf.length > MAX_STORE_BYTES) db.prepare("UPDATE message_attachments SET fetch_state = 'live' WHERE id = ?").run(att.id);
    else writeFile(att, buf);
  } catch (e) {
    fetchFailed(att, e);
    audit("system", "attachment_fetch_error", att.work_item_id, `${att.name}: ${short(e)}`.slice(0, 200));
  }
}

// List every message of the item not yet listed and fetch every file not yet held, within the retry
// bound (byPerson: a view, see retryDue). Errors are recorded per message and per attachment.
// Returns nothing; never throws.
const unlistedSql = (byPerson) => `SELECT * FROM messages WHERE work_item_id = ? AND list_state <> 'listed' AND ${retryDue(byPerson, "list_attempts", "list_tried_at")}`;
const unfetchedSql = (byPerson) => `SELECT * FROM message_attachments WHERE work_item_id = ? AND fetch_state IN ('pending', 'error') AND ${retryDue(byPerson, "attempts", "tried_at")}`;
async function retryItem(itemId, mbx, byPerson = false) {
  for (const m of db.prepare(unlistedSql(byPerson)).all(itemId)) await listMessage(m, mbx);
  for (const a of db.prepare(unfetchedSql(byPerson)).all(itemId)) await fetchOne(a, mbx);
}

// Ingest's entry point: store the thread's messages (msgs = mapped Graph messages, newest first, as
// ingest groups them), list their attachments and fetch the files. Returns the newest message's
// attachments in the attachments_json shape [{id,name,contentType,size,inline}], or null when its
// listing failed. Never throws: a failure is audited and the item carries on.
async function storeThread(itemId, box, mbx, msgs) {
  let newest = null;
  try {
    for (const m of msgs) upsertMessage(itemId, box, m);
    await retryItem(itemId, mbx);
    const top = msgs[0] && db.prepare("SELECT id, list_state FROM messages WHERE mailbox = ? AND graph_id = ?").get(box, msgs[0].id);
    if (top && top.list_state === "listed") {
      newest = db.prepare("SELECT graph_att_id, name, content_type, size, is_inline FROM message_attachments WHERE message_id = ? ORDER BY id").all(top.id)
        .map((a) => ({ id: a.graph_att_id, name: a.name, contentType: a.content_type, size: a.size, inline: !!a.is_inline }));
    }
  } catch (e) {
    audit("system", "attachments_error", itemId, `store thread: ${short(e)}`);
  }
  SEARCH.reindexItem(itemId);
  return newest;
}

// --- Reading ----------------------------------------------------------------------------------------

const parseList = (s) => { try { return JSON.parse(s || "[]") || []; } catch (e) { return []; } };

// The item's stored messages, oldest to newest, each with its attachments (see the hand-over in
// the round 2 report for the exact shape).
function itemThread(itemId) {
  const atts = db.prepare("SELECT * FROM message_attachments WHERE work_item_id = ? ORDER BY id").all(itemId);
  return db.prepare("SELECT * FROM messages WHERE work_item_id = ? ORDER BY received, id").all(itemId).map((m) => ({
    id: m.id, graphId: m.graph_id, internetId: m.internet_id,
    from: { name: m.from_name || "", address: m.from_addr || "" },
    to: parseList(m.to_json), cc: parseList(m.cc_json),
    received: m.received, body: m.body || "",
    listState: m.list_state, listError: m.list_error,
    attachments: atts.filter((a) => a.message_id === m.id).map((a) => {
      const type = effectiveType(a.content_type, a.name);
      return {
        id: a.id, name: a.name, contentType: type, size: a.size, inline: !!a.is_inline,
        image: isShowableImage(a.content_type, a.name), pdf: type === "application/pdf",
        state: a.fetch_state, error: a.fetch_error, failed: a.fetch_state === "error", attempts: a.attempts,
        url: BASE.url(`/item/${itemId}/file/${a.id}`),
      };
    }),
  }));
}

// One attachment of an item for serving or for the drafter: { att, plan, path } with the file on
// disk, or { att, plan, buffer } for a file over the ceiling (live fetch). Fetches when the file is
// missing. Null when the attachment is not this item's. Throws when Graph cannot supply it (the
// error is recorded on the row).
async function loadAttachment(itemId, attId) {
  const att = db.prepare("SELECT * FROM message_attachments WHERE id = ? AND work_item_id = ?").get(attId, itemId);
  if (!att) return null;
  const plan = servePlan(att.content_type, att.name);
  const p = filePath(att.id);
  if (att.fetch_state === "stored" && fs.existsSync(p)) return { att, plan, path: p };
  const msg = msgRow(att.message_id);
  let buf;
  try { buf = await fetchBytes(att, msg, mailboxAddress(msg.mailbox)); }
  catch (e) {
    fetchFailed(att, e);
    throw e;
  }
  if (att.fetch_state === "live" || buf.length > MAX_STORE_BYTES) return { att, plan, buffer: buf };
  writeFile(att, buf);
  return { att, plan, path: p };
}

// --- Backfill, healing, pruning ------------------------------------------------------------------

// Fetch an existing item's thread from Graph (the messages of its Outlook conversation that group to
// this item, as ingest groups them) and store it. Throws when Graph cannot read the thread.
async function backfillItem(w) {
  const E = require("./engine.js");
  const mbx = mailboxAddress(w.mailbox);
  const msgs = await C.threadMessages(mbx, w.latest_message_id);
  const mine = E.threadGroup(msgs).get(w.conversation_key) || msgs.filter((m) => m.id === w.latest_message_id);
  await storeThread(w.id, w.mailbox, mbx, mine);
  return mine.length;
}

// Once per database (flag in meta), in the background after start-up: every open inbound item.
// Sequential, tolerant of Graph errors, one summary line at the end; again at the next start when
// every item failed.
function startBackfillOnce(delayMs = 10000) {
  if (getMeta(BACKFILL_FLAG)) return;
  setTimeout(async () => {
    const t0 = Date.now();
    const items = db.prepare("SELECT * FROM work_items WHERE status NOT IN ('done', 'archived') AND origin = 'inbound' AND latest_message_id IS NOT NULL ORDER BY id").all();
    let ok = 0, failed = 0, messages = 0;
    for (const w of items) {
      try { messages += await backfillItem(w); ok++; }
      catch (e) { failed++; audit("system", "attachments_error", w.id, `backfill: ${short(e)}`); }
    }
    const atts = db.prepare("SELECT COUNT(*) AS n FROM message_attachments").get().n;
    // Done once something worked or there was nothing to do; when every item failed (Graph down at
    // the first start after a deploy) the flag stays unset and the next start tries again.
    const done = ok > 0 || !items.length;
    if (done) setMeta(BACKFILL_FLAG, new Date().toISOString());
    const line = `${items.length} open item(s): ${ok} ok, ${failed} failed, ${messages} message(s), ${atts} attachment(s) held, ${Math.round((Date.now() - t0) / 1000)}s${done ? "" : ", tried again at the next start"}`;
    audit("system", "messages_backfill", null, line);
    console.log("Message backfill: " + line);
  }, delayMs);
}

// On view, in the background: an open inbound item with no stored message gets its thread, any
// other item retries its failed listings and fetches that are due (retryDue, byPerson). One run per
// item at a time.
const healing = new Set();
function healItem(w) {
  if (healing.has(w.id) || w.origin !== "inbound" || !w.latest_message_id) return;
  const stored = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE work_item_id = ?").get(w.id).n;
  const open = w.status !== "done" && w.status !== "archived";
  const failing = db.prepare(unlistedSql(true)).all(w.id).length + db.prepare(`${unfetchedSql(true)} AND fetch_state = 'error'`).all(w.id).length;
  if (stored ? !failing : !open) return;
  healing.add(w.id);
  (stored ? retryItem(w.id, mailboxAddress(w.mailbox), true) : backfillItem(w))
    .then(() => SEARCH.reindexItem(w.id))
    .catch((e) => audit("system", "attachments_error", w.id, `on view: ${short(e)}`))
    .finally(() => healing.delete(w.id));
}

// Delete the cached files of emails closed more than `days` ago (rows kept, state back to pending
// so a later view fetches again). Returns the number of files removed.
function pruneClosed(days = PRUNE_DAYS) {
  const rows = db.prepare(
    `SELECT a.id FROM message_attachments a JOIN work_items w ON w.id = a.work_item_id
      WHERE a.fetch_state = 'stored' AND w.status IN ('done', 'archived') AND w.updated_at < datetime('now', ?)`
  ).all(`-${days} days`);
  const reset = db.prepare("UPDATE message_attachments SET fetch_state = 'pending', file = NULL WHERE id = ?");
  for (const r of rows) {
    try { fs.unlinkSync(filePath(r.id)); } catch (e) { /* already gone */ }
    reset.run(r.id);
  }
  return rows.length;
}

module.exports = {
  ATTACH_DIR, MAX_STORE_BYTES, MAX_AUTO_TRIES, mailboxAddress,
  effectiveType, servePlan, isShowableImage,
  upsertMessage, recordListing, storeThread, retryItem, itemThread, loadAttachment,
  backfillItem, startBackfillOnce, healItem, pruneClosed,
};
