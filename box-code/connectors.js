// connectors.js — shared READ-ONLY connectors for all Axle scripts.
// Every function here reads. Nothing in this file writes to any business system.
const sql = require("mssql");

function htmlToText(html) {
  return (html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, "\"").replace(/&#\d+;/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Cleanup for plain-text bodies (Exchange-converted): normalise whitespace only.
function cleanText(t) {
  return (t || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Graph body -> text: plain-text body when available (Prefer header), else strip HTML.
function bodyText(body) {
  if (!body) return "";
  return body.contentType === "html" ? htmlToText(body.content) : cleanText(body.content);
}

// ---------- Microsoft Graph (mail read) ----------
let graphTokenCache = null;
async function graphToken() {
  if (graphTokenCache && graphTokenCache.expires > Date.now()) return graphTokenCache.token;
  const r = await fetch(`https://login.microsoftonline.com/${process.env.M365_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.M365_CLIENT_ID,
      client_secret: process.env.M365_CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
    }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error("no Graph token: " + JSON.stringify(data));
  graphTokenCache = { token: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return graphTokenCache.token;
}

// NOTE, so it is not tried again: lastModifiedDateTime is deliberately NOT selected here. It looks
// like the way to tell "someone marked this unread again" from "this was never read", but Exchange
// does not move it on a read-state change — proved on the live box 2026-08-15, item #500 (two
// isRead transitions, stamp unchanged). outlook-close uses the read_marks ledger instead.
//
// LIST select is metadata ONLY — deliberately NO `body`. Selecting `body` in a *filtered* message
// list is a known Graph 500 trigger ("An internal server error occurred. The operation failed.").
// On 2026-08-31 a single un-serialisable message inside the since-window failed the whole list page,
// so every ingest run threw before processing anything; the watermark could not advance, the window
// never cleared, and BOTH mailboxes deadlocked for ~21h. We now list metadata only and hydrate each
// body individually (fetchMessageBody), where one bad body is skipped instead of sinking the batch.
const MSG_LIST_SELECT = "id,conversationId,subject,from,receivedDateTime,categories,hasAttachments";

// All Graph reads funnel through here for one shared thing the raw fetch lacked: a hard timeout.
// Before 2026-09-01 a stalled Graph call hung the whole ingest run silently (the run just never
// finished) instead of failing cleanly. AbortController turns a stall into a normal error.
const GRAPH_TIMEOUT_MS = 30000;
async function graphGetJson(url, { timeoutMs = GRAPH_TIMEOUT_MS } = {}) {
  const token = await graphToken();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Prefer: "outlook.body-content-type=\"text\"" },
      signal: ac.signal,
    });
    return await r.json();
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Graph request timed out after ${timeoutMs}ms: ${url.slice(0, 120)}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function mapMessage(m) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    subject: m.subject || "",
    from: (m.from && m.from.emailAddress) || { address: "unknown", name: "unknown" },
    received: m.receivedDateTime,
    categories: m.categories || [],
    hasAttachments: Boolean(m.hasAttachments),
    text: bodyText(m.body).slice(0, 4000),
  };
}

// Resolve a folder displayName to its Graph id (cached per mailbox). The well-known
// "inbox" is passed straight through; custom folders (e.g. "Shopify Contact Form")
// are looked up once by displayName.
const folderIdCache = {};
async function resolveFolderId(mailbox, name) {
  if (!name || name.toLowerCase() === "inbox") return "inbox";
  const ck = mailbox + "|" + name;
  if (folderIdCache[ck]) return folderIdCache[ck];
  const token = await graphToken();
  const safe = String(name).replace(/'/g, "''");
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/users/${mailbox}/mailFolders?$filter=displayName eq '${encodeURIComponent(safe)}'&$select=id,displayName&$top=10`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  const f = (data.value || [])[0];
  if (!f) throw new Error("mail folder not found: " + name);
  folderIdCache[ck] = f.id;
  return f.id;
}

// Fetch all messages in one folder with receivedDateTime >= sinceIso, following @odata.nextLink
// pages up to maxPages. METADATA ONLY (no body — see MSG_LIST_SELECT). $orderby is dropped on BOTH
// paths: Graph returns messages newest-first by default, getMessages re-sorts client-side anyway,
// and $orderby alongside $filter+$select(body) was part of the shape that 500'd. When unreadOnly is
// set the filter is on isRead instead of receivedDateTime.
async function fetchFolderSince(mailbox, folderRef, sinceIso, maxPages, unreadOnly) {
  const folderId = await resolveFolderId(mailbox, folderRef);
  const filter = unreadOnly
    ? "&$filter=isRead eq false"
    : (sinceIso ? `&$filter=receivedDateTime ge ${sinceIso}` : "");
  let url =
    `https://graph.microsoft.com/v1.0/users/${mailbox}/mailFolders/${folderId}/messages` +
    `?$top=50${filter}&$select=${MSG_LIST_SELECT}`;
  const out = [];
  for (let page = 0; url && page < (maxPages || 10); page++) {
    const data = await graphGetJson(url);
    if (data.error) throw new Error(`${folderRef} p${page}: ${data.error.message}`);
    out.push(...(data.value || []));
    url = data["@odata.nextLink"] || null;
  }
  return out;
}

// Hydrate ONE message's body, tolerating the Graph 500 a single un-serialisable body can throw.
// Returns a Graph body object ({contentType, content}) or null. Null is safe: mapMessage's bodyText
// treats it as empty, so the message still becomes a work item (with no text) instead of failing the
// whole run — the exact failure mode that deadlocked ingest before 2026-09-01.
async function fetchMessageBody(mailbox, messageId) {
  try {
    const data = await graphGetJson(
      `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${encodeURIComponent(messageId)}?$select=body`
    );
    if (data.error) throw new Error(data.error.message);
    return data.body || null;
  } catch (e) {
    console.error(`  body hydrate failed for ${String(messageId).slice(0, 24)}…: ${e.message}`);
    return null;
  }
}

// Read new mail across one or more folders. opts:
//   folders  - array of folder names/ids to read (default ["inbox"])
//   sinceIso - only messages with receivedDateTime >= this ISO timestamp (the watermark)
//   maxPages - per-folder pagination cap (default 10 -> up to 500 messages/folder)
//   limit    - optional cap on the merged result
//   unreadOnly - read only currently-unread messages (isRead eq false), ignoring sinceIso.
//                Used for the one-time per-mailbox seed (ingest.js "unread" mode).
// Messages are merged across folders, de-duplicated by id, and returned newest-first.
async function getMessages(mailbox, opts = {}) {
  if (typeof opts === "number") opts = { limit: opts };   // back-compat: old (mailbox, count) callers
  const folders = Array.isArray(opts.folders) && opts.folders.length ? opts.folders : ["inbox"];
  const unreadOnly = !!opts.unreadOnly;
  const sinceIso = unreadOnly ? null : (opts.sinceIso || null);
  const maxPages = opts.maxPages || 10;
  const seen = new Set();
  const merged = [];
  // Per-folder isolation: one folder's list 500'ing must not lose the mail in the others. We fetch
  // each folder independently, record which failed, and press on with what we got. The caller
  // (ingest.runBox) reads folderErrors and HOLDS the watermark when any folder failed, so a skipped
  // folder's mail is retried next run rather than being stepped over.
  const folderErrors = [];
  for (const f of folders) {
    let rows;
    try {
      rows = await fetchFolderSince(mailbox, f, sinceIso, maxPages, unreadOnly);
    } catch (e) {
      folderErrors.push({ folder: f, error: String(e.message || e).slice(0, 200) });
      console.error(`  folder fetch failed [${mailbox} / ${f}]: ${e.message}`);
      continue;
    }
    for (const m of rows) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      merged.push(m);
    }
  }
  merged.sort((a, b) => (a.receivedDateTime < b.receivedDateTime ? 1 : a.receivedDateTime > b.receivedDateTime ? -1 : 0));
  const capped = opts.limit ? merged.slice(0, opts.limit) : merged;
  // Bodies are not in the list result (MSG_LIST_SELECT) — hydrate each one here, tolerantly. One
  // per message: cheap in steady state (few new mails/run), bounded on a catch-up, and a single
  // un-serialisable body is skipped rather than failing the batch.
  for (const m of capped) m.body = await fetchMessageBody(mailbox, m.id);
  const out = capped.map(mapMessage);
  out.folderErrors = folderErrors;   // [] when every folder fetched cleanly; read by ingest.runBox
  return out;
}

// Attachment metadata for one message (real file attachments only, inline images skipped).
async function listAttachments(mailbox, messageId) {
  const token = await graphToken();
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return (data.value || [])
    .filter((a) => a["@odata.type"] === "#microsoft.graph.fileAttachment" && !a.isInline)
    .map((a) => ({ id: a.id, name: a.name || "attachment", contentType: a.contentType || "", size: a.size || 0 }));
}

// Fetch one attachment's content (base64). Only plain file attachments are supported.
async function getAttachment(mailbox, messageId, attachmentId) {
  const token = await graphToken();
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  if (data["@odata.type"] !== "#microsoft.graph.fileAttachment" || !data.contentBytes)
    throw new Error("unsupported attachment type: " + (data["@odata.type"] || "unknown"));
  return { name: data.name, contentType: data.contentType, size: data.size, contentBytes: data.contentBytes };
}

async function searchMailbox(mailbox, fromAddress, count) {
  const token = await graphToken();
  const clean = String(fromAddress).replace(/[\s"\\]/g, "");
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/users/${mailbox}/messages?$search="from:${encodeURIComponent(clean)}"&$top=${count || 10}&$select=id,conversationId,subject,from,receivedDateTime,body`,
    { headers: { Authorization: `Bearer ${token}`, Prefer: "outlook.body-content-type=\"text\"" } }
  );
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return data.value.map((m) => ({
    subject: m.subject || "",
    from: (m.from && m.from.emailAddress && m.from.emailAddress.address) || "unknown",
    received: m.receivedDateTime,
    text: bodyText(m.body).slice(0, 1200),
  }));
}
// Fetch ONE message's raw HTML body (no Exchange text conversion). The contact-form parser
// needs the structural <b>label</b><pre>value</pre> HTML, which is far more reliable than the
// lossy text rendering. Read-only.
async function getMessageHtml(mailbox, messageId) {
  const token = await graphToken();
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${encodeURIComponent(messageId)}?$select=id,body`,
    { headers: { Authorization: `Bearer ${token}`, Prefer: "outlook.body-content-type=\"html\"" } }
  );
  const data = await r.json();
  if (data.error) throw new Error(data.error.message);
  return (data.body && data.body.content) || "";
}

// Resolve a mailbox's monitored folder names to their REAL Graph folder ids. resolveFolderId
// passes the well-known "inbox" straight through, which is fine for building a URL but useless
// for COMPARING against a message's parentFolderId — so the well-known name is resolved here to
// the actual id. Cached per mailbox+name by resolveFolderId for the custom folders; the inbox
// lookup is one extra GET per mailbox per run. Read-only.
const inboxIdCache = {};
async function folderIds(mailbox, names) {
  const out = new Set();
  for (const name of names || []) {
    if (!name || String(name).toLowerCase() === "inbox") {
      if (!inboxIdCache[mailbox]) {
        const token = await graphToken();
        const r = await fetch(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/inbox?$select=id`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const data = await r.json();
        if (data.error) throw new Error(data.error.message);
        inboxIdCache[mailbox] = data.id;
      }
      out.add(inboxIdCache[mailbox]);
    } else {
      out.add(await resolveFolderId(mailbox, name));
    }
  }
  return out;
}

// A folder's display name from its id — the reverse of resolveFolderId, for diagnostics ("where
// did this message actually go?"). Returns null rather than throwing when the folder is not
// readable. Read-only.
async function folderName(mailbox, folderId) {
  if (!mailbox || !folderId) return null;
  try {
    const token = await graphToken();
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/${encodeURIComponent(folderId)}?$select=displayName`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await r.json();
    return data.error ? null : data.displayName || null;
  } catch (e) { return null; }
}

// Read the current state of a set of message ids in ONE mailbox, via the Graph $batch endpoint
// (20 sub-requests per call — the documented cap). READ-ONLY: every sub-request is a GET, so
// this can never change mailbox state; the PATCH that marks mail read lives in send.js.
//
// Returns a Map id -> one of:
//   { gone: true }                    the message no longer exists at that id (HTTP 404) — it was
//                                     deleted, or moved (an Exchange move MINTS A NEW ID, so the
//                                     old one 404s; "moved" and "deleted" are indistinguishable
//                                     here and are treated the same by callers).
//   { isRead, folderId }              the message is still there; folderId is its parentFolderId,
//                                     so a caller can ask whether it is still in a folder we watch.
// Anything else (403 out of RBAC scope, 429 throttled, 5xx) is OMITTED rather than guessed at, so
// "absent" reads as "unknown, leave it alone". Never throws on a per-message failure; only a hard
// batch-level Graph error propagates.
const BATCH_MAX = 20;
async function getMessageStates(mailbox, messageIds) {
  const out = new Map();
  const ids = [...new Set((messageIds || []).filter(Boolean))];
  if (!mailbox || !ids.length) return out;
  const token = await graphToken();
  const mb = encodeURIComponent(mailbox);
  for (let i = 0; i < ids.length; i += BATCH_MAX) {
    const chunk = ids.slice(i, i + BATCH_MAX);
    const r = await fetch("https://graph.microsoft.com/v1.0/$batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: chunk.map((id, n) => ({
          id: String(n),
          method: "GET",
          url: `/users/${mb}/messages/${encodeURIComponent(id)}?$select=id,isRead,parentFolderId`,
        })),
      }),
    });
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    for (const resp of data.responses || []) {
      const id = chunk[parseInt(resp.id, 10)];
      if (!id) continue;
      if (resp.status === 404) out.set(id, { gone: true });
      else if (resp.status === 200 && resp.body && typeof resp.body.isRead === "boolean") {
        out.set(id, { isRead: resp.body.isRead, folderId: resp.body.parentFolderId || null });
      }
    }
  }
  return out;
}

// ---------- SAP B1 (read-only SQL login) ----------
const sqlConfig = () => ({
  server: process.env.SQL_SERVER,
  database: process.env.SQL_DATABASE,
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  options: { encrypt: true, trustServerCertificate: true },
});

// ONE shared, persistent connection pool for the whole process, lazily created. Previously every
// SAP call did `sql.connect()` (the mssql GLOBAL pool) and closed it in a finally — so two
// concurrent reads (e.g. gatherSeed's Promise.all of customer + stock) shared one global pool and
// the first to finish CLOSED it out from under the other ("Connection is closed" races), while
// every call paid a fresh TCP+TLS+auth handshake. A single reused pool fixes both. The cache is
// dropped on a pool-level error so the next call rebuilds; closePool() is for CLI scripts that exit.
let _poolPromise = null;
function getPool() {
  if (_poolPromise) return _poolPromise;
  const pool = new sql.ConnectionPool(sqlConfig());
  pool.on("error", () => { _poolPromise = null; });   // a dead pool won't be handed out again
  _poolPromise = pool.connect().then(() => pool).catch((e) => { _poolPromise = null; throw e; });
  return _poolPromise;
}
// Close the shared pool (used by short-lived CLI scripts so the process can exit; the long-running
// server never calls this). Safe to call when no pool was ever opened.
async function closePool() {
  const p = _poolPromise;
  _poolPromise = null;
  if (!p) return;
  try { const pool = await p; await pool.close(); } catch (e) { /* already gone */ }
}

async function sapCustomerContext(emailAddress) {
  const pool = await getPool();
  const bp = await pool.request().input("email", sql.NVarChar, "%" + emailAddress + "%")
    .query("SELECT TOP 1 CardCode, CardName, Phone1, Balance FROM OCRD WHERE E_Mail LIKE @email");
  if (!bp.recordset.length) return { customer: null, recentOrders: [] };
  const c = bp.recordset[0];
  const orders = await pool.request().input("cc", sql.NVarChar, c.CardCode)
    .query("SELECT TOP 5 DocNum, DocDate, DocTotal, DocStatus FROM ORDR WHERE CardCode = @cc ORDER BY DocDate DESC");
  return { customer: c, recentOrders: orders.recordset };
}

async function sapStockPrice(itemCodes) {
  if (!itemCodes.length) return [];
  const pool = await getPool();
  const req = pool.request();
  const params = itemCodes.slice(0, 10).map((code, i) => {
    req.input(`c${i}`, sql.NVarChar, code);
    return `@c${i}`;
  });
  const r = await req.query(
    `SELECT T0.ItemCode, T0.ItemName, T0.OnHand, T1.Price AS WebPrice
     FROM OITM T0 LEFT JOIN ITM1 T1 ON T0.ItemCode = T1.ItemCode AND T1.PriceList = 1
     WHERE T0.ItemCode IN (${params.join(",")})`
  );
  return r.recordset;
}

// ---------- Part dossier (P1.1): everything we know about ONE part ----------
// One assembled object per part so the drafting model stops stitching six OITM queries
// it gets wrong. Given any identifier a customer might quote — our ItemCode, a
// supplier/customer code (AllMakes/BritPart/Hotbray), the BaseCode (U_WS_LRNo), or a
// superseded/equivalent code that only lives in U_Alternatives — resolve the part, then
// return it WITH its BaseCode family (siblings sharing U_WS_LRNo) so brand/quality variant
// disambiguation is right in front of the model. Read-only, parameterised, shared pool.
// Shopify product handles are batched into one read-only call (best effort).

// Availability rule (single source of truth, JS side so it is unit-testable).
//
// 2026-08-12 (item 1249): the dossier used to hand the model a field literally named
// `dropship: "Y"`, and the model paraphrased the FIELD NAME into customer prose — "it ships
// directly from our supplier". That is not true: a drop-ship item is one we BUY IN, and the
// only thing the customer is ever told is the lead time. We never explain how we source.
// So the raw U_WS_DropShip flag no longer reaches the model at all. Instead each item carries
// a precomputed `availability` object whose `statement` is the exact customer-facing wording,
// leaving nothing to paraphrase. `state` is what the gates in engine.js key off.
//
//   in_stock     OnHand > 0                      -> "in stock"
//   order_in     OnHand <= 0, DropShip = 'Y'     -> we buy it in, 2-3 weeks
//   check_first  OnHand <= 0, DropShip <> 'Y'    -> availability MUST be checked with the
//                                                   supplier by a human (often NLA). Nothing
//                                                   about availability may be promised.
function availabilityOf(onHand, dropShipFlag) {
  const ds = String(dropShipFlag == null ? "" : dropShipFlag).trim().toUpperCase();
  if (Number(onHand) > 0) {
    return { state: "in_stock", statement: "In stock (never quote exact quantities)." };
  }
  if (ds === "Y") {
    return {
      state: "order_in",
      statement: "Not in stock — we order it in for the customer. Lead time 2-3 weeks. "
               + "Say ONLY the lead time; never explain how or from where we source it.",
    };
  }
  return {
    state: "check_first",
    statement: "Not in stock and NOT a stock-order item — availability is unknown and is often "
             + "NLA. Do NOT state any availability, lead time or delivery estimate. A "
             + "salesperson must check with the supplier first.",
  };
}

// Customer-facing code rule (single source of truth, JS side so it is unit-testable):
// first non-empty of AllMakes > BritPart > Hotbray > BaseCode(U_WS_LRNo) > ItemCode.
function customerCode(r) {
  const pick = (v) => (v == null ? "" : String(v).trim());
  return pick(r.U_Code_AllMakes) || pick(r.U_Code_BritPart) || pick(r.U_Code_Hotbray)
       || pick(r.U_WS_LRNo) || pick(r.ItemCode);
}

// Assemble the dossier objects from raw OITM/ITM1 rows + a sku->handle map. Pure (no I/O)
// so it is unit-testable. matchedSet = the ItemCodes the lookup resolved to; those carry the
// heavy text (faq / long_description); siblings stay compact for disambiguation. Matched
// items are listed first. Text fields are capped so a whole family stays compact.
function assembleDossier(familyRows, matchedSet, handleMap = {}) {
  const trim = (s, n) => {
    const t = (s == null ? "" : String(s)).replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n) + "…" : t;
  };
  const rows = [...familyRows].sort(
    (a, b) => (matchedSet.has(b.ItemCode) ? 1 : 0) - (matchedSet.has(a.ItemCode) ? 1 : 0)
  );
  return rows.map((r) => {
    const matched = matchedSet.has(r.ItemCode);
    const o = {
      item_code: r.ItemCode,
      customer_code: customerCode(r),
      base_code: (r.U_WS_LRNo || "").trim() || undefined,
      name: (r.ItemName || "").trim() || undefined,
      quality: (r.U_Quality || "").trim() || undefined,
      abc: (r.U_ABC || "").trim() || undefined,
      // NOT the raw U_WS_DropShip flag — see availabilityOf(). The model gets the finished
      // sentence, so there is no internal jargon left for it to invent an explanation from.
      availability: availabilityOf(r.OnHand, r.U_WS_DropShip),
      on_hand: r.OnHand,
      on_order: r.OnOrder,
      web_price_excl_vat: r.WebPrice == null ? undefined : r.WebPrice,
      fitment: trim(r.U_Tag_Model, 200) || undefined,
      alternatives: trim(r.U_Alternatives, 200) || undefined,
      handle: handleMap[r.ItemCode] || undefined,
    };
    if (matched) {
      o.matched = true;
      const faq = trim(r.U_FAQ, 1000);
      const long = trim(r.UserText, 800);
      if (faq) o.faq = faq;
      if (long) o.long_description = long;
    }
    return o;
  });
}

const PART_CODE_RE = /[^A-Za-z0-9._/\- ]/g;   // safe set for SQL params + Shopify search
async function partDossier(code) {
  const q = String(code || "").trim().replace(PART_CODE_RE, "").slice(0, 40);
  if (!q) return { query: String(code || ""), matched: [], items: [] };
  const pool = await getPool();

  // Step 1 — resolve the code to real item(s) + their BaseCode, ranked: exact ItemCode,
  // then a supplier/customer code, then a BaseCode hit.
  let matches = (await pool.request().input("code", sql.NVarChar, q).query(
    `SELECT TOP (5) ItemCode, U_WS_LRNo,
            CASE WHEN ItemCode=@code THEN 0 WHEN U_WS_LRNo=@code THEN 2 ELSE 1 END AS rnk
     FROM OITM
     WHERE ItemCode=@code OR U_Code_AllMakes=@code OR U_Code_BritPart=@code
        OR U_Code_Hotbray=@code OR U_WS_LRNo=@code
     ORDER BY rnk`
  )).recordset;

  // Step 1b — fallback: a superseded/equivalent code that only lives in U_Alternatives
  // (guarded to >=4 chars to avoid spurious substring hits).
  if (!matches.length && q.length >= 4) {
    matches = (await pool.request().input("like", sql.NVarChar, "%" + q + "%").query(
      `SELECT TOP (5) ItemCode, U_WS_LRNo FROM OITM WHERE U_Alternatives LIKE @like`
    )).recordset;
  }
  if (!matches.length) return { query: q, matched: [], items: [] };

  const matchedSet = new Set(matches.map((m) => m.ItemCode));
  const baseCodes = [...new Set(matches.map((m) => (m.U_WS_LRNo || "").trim()).filter(Boolean))];

  // Step 2 — load the BaseCode family (siblings sharing U_WS_LRNo) plus the matched items
  // themselves (covers items with no BaseCode). Cap the family.
  const req = pool.request();
  const ins = [];
  baseCodes.forEach((b, i) => { req.input("b" + i, sql.NVarChar, b); ins.push("@b" + i); });
  const mc = [...matchedSet];
  mc.forEach((c, i) => { req.input("m" + i, sql.NVarChar, c); });
  const where = [
    ins.length ? `I.U_WS_LRNo IN (${ins.join(",")})` : null,
    `I.ItemCode IN (${mc.map((_, i) => "@m" + i).join(",")})`,
  ].filter(Boolean).join(" OR ");
  const family = (await req.query(
    `SELECT TOP (12) I.ItemCode, I.U_WS_LRNo,
            I.U_Code_AllMakes, I.U_Code_BritPart, I.U_Code_Hotbray,
            I.ItemName, I.U_Quality, I.U_ABC, I.U_WS_DropShip,
            I.OnHand, I.OnOrder, P.Price AS WebPrice,
            CAST(I.U_Tag_Model AS NVARCHAR(MAX)) AS U_Tag_Model,
            I.U_Alternatives,
            CAST(I.U_FAQ AS NVARCHAR(MAX)) AS U_FAQ,
            CAST(I.UserText AS NVARCHAR(MAX)) AS UserText
     FROM OITM I
     LEFT JOIN ITM1 P ON P.ItemCode = I.ItemCode AND P.PriceList = 1
     WHERE ${where}`
  )).recordset;

  // Step 3 — Shopify product handles for the returned items, one batched read-only call.
  // Best effort: a Shopify hiccup or a non-synced item must never fail the dossier.
  let handleMap = {};
  try {
    const skus = family.map((r) => String(r.ItemCode).replace(/[^A-Za-z0-9._/-]/g, "")).filter(Boolean);
    if (skus.length) {
      const search = skus.map((s) => `sku:${s}`).join(" OR ");
      const data = await shopifyGraphql(
        `{ productVariants(first: 50, query: ${JSON.stringify(search)}) { edges { node { sku product { handle } } } } }`
      );
      for (const e of (data.productVariants && data.productVariants.edges) || []) {
        const n = e.node || {};
        if (n.sku && n.product && n.product.handle) handleMap[n.sku] = n.product.handle;
      }
    }
  } catch (e) { handleMap = {}; }

  return { query: q, matched: [...matchedSet], items: assembleDossier(family, matchedSet, handleMap) };
}

// ---------- Part finder (P1.2): model/VIN + description -> RANKED candidates ----------
// The structured-first counterpart to part_dossier (which is for when you already have a
// code). Given a free-text description plus whatever vehicle data we have (model/year/engine
// and/or VIN), constrain by our structured model-fitment flag (U_M_*) and rank candidates by
// description-token overlap + stock + ABC + a soft category boost — NOT a blind LIKE that
// truncates the right part away. All pure helpers are exported for unit testing.

// Valid model-fitment flag columns (authoritative list from business-knowledge.md). The
// resolved column is whitelisted against this set before it is ever interpolated into SQL —
// identifiers cannot be parameterised, so the whitelist is the injection guard.
const VALID_MODEL_COLS = new Set([
  "U_M_General", "U_M_Jaguar", "U_M_Series1", "U_M_Series_2_3", "U_M_Def_Old", "U_M_Def_New",
  "U_M_Disc1", "U_M_Disc2", "U_M_Disc3", "U_M_Disc4", "U_M_Disc5", "U_M_DiscSport",
  "U_M_Free_1", "U_M_Free_2", "U_M_RR_71_94", "U_M_RR_94_01", "U_M_RR_02_12", "U_M_RR_13_22",
  "U_M_RR_22", "U_M_RR_Sport_05_13", "U_M_RR_Sport_14_22", "U_M_RR_Sport_23",
  "U_M_Evoque_12_18", "U_M_Evoque_19", "U_M_Velar_17",
]);
const VALID_CAT_COLS = new Set([
  "U_C_Accessories", "U_C_Axle_Susp", "U_C_Body_Chassis", "U_C_Braking", "U_C_Cables",
  "U_C_Clutch", "U_C_Cool_Heat", "U_C_Drive_Mech", "U_C_Electrical", "U_C_Engine", "U_C_Exhaust",
  "U_C_Fixings_Hard", "U_C_Fuel_System", "U_C_Gearbox", "U_C_Interior", "U_C_Safety",
  "U_C_Service", "U_C_Tools", "U_C_Wheels", "U_C_Gifts", "U_C_Cleaning",
]);

// VIN model-year code -> year (post-2001 interpretation; the 30-year cycle repeats letters,
// so this is the most-recent-plausible read and is always treated as approximate).
const VIN_YEAR = {
  "1": 2001, "2": 2002, "3": 2003, "4": 2004, "5": 2005, "6": 2006, "7": 2007, "8": 2008, "9": 2009,
  A: 2010, B: 2011, C: 2012, D: 2013, E: 2014, F: 2015, G: 2016, H: 2017, J: 2018, K: 2019,
  L: 2020, M: 2021, N: 2022, P: 2023, R: 2024, S: 2025, T: 2026, V: 2027, W: 2028, X: 2029, Y: 2030,
};

// Deliberately conservative: decode the model YEAR (reliable, position 10) and the WMI; do NOT
// guess the model from the VDS (error-prone) — leave it null so the finder/draft asks to confirm
// the model. VIN-specific exact fitment always routes to a human/EPC check (confidence gate).
function vinDecode(vin) {
  const v = String(vin || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const info = { vin: v, wmi: v.slice(0, 3) || null, year: null, year_approx: true, model: null };
  if (v.length !== 17) { info.note = "not a 17-character VIN"; return info; }
  if (VIN_YEAR[v[9]]) info.year = VIN_YEAR[v[9]];
  info.is_landrover = v.startsWith("SAL");
  if (v.startsWith("SAJ")) info.model = "Jaguar";   // named only so the draft can say we don't do Jaguar
  return info;
}

// model (+ optional year) -> the single U_M_* fitment column. Most-specific patterns first.
// Returns { column, matched, model_label, year_needed }. column is null (matched=false) when it
// can't be pinned (unknown model, or a model that needs a year we don't have).
function modelToColumn(model, year) {
  const m = String(model || "").toLowerCase().trim();
  const y = year ? parseInt(year, 10) : null;
  const col = (c, l) => ({ column: VALID_MODEL_COLS.has(c) ? c : null, matched: VALID_MODEL_COLS.has(c), model_label: l, year_needed: false });
  const need = (l) => ({ column: null, matched: false, model_label: l, year_needed: true });
  if (!m) return { column: null, matched: false, model_label: null, year_needed: false };
  const inR = (a, b) => y != null && y >= a && y <= b;

  if (/range\s*rover\s*sport|\brrs\b|rr\s*sport/.test(m)) {
    if (inR(2005, 2013)) return col("U_M_RR_Sport_05_13", "Range Rover Sport 2005-2013");
    if (inR(2014, 2022)) return col("U_M_RR_Sport_14_22", "Range Rover Sport 2014-2022");
    if (y != null && y >= 2023) return col("U_M_RR_Sport_23", "Range Rover Sport 2023+");
    return need("Range Rover Sport");
  }
  if (/evoque/.test(m)) {
    if (inR(2012, 2018)) return col("U_M_Evoque_12_18", "Range Rover Evoque 2012-2018");
    if (y != null && y >= 2019) return col("U_M_Evoque_19", "Range Rover Evoque 2019+");
    return need("Range Rover Evoque");
  }
  if (/velar/.test(m)) return col("U_M_Velar_17", "Range Rover Velar 2017+");
  if (/discovery\s*sport|disco\s*sport/.test(m)) return col("U_M_DiscSport", "Discovery Sport");
  if (/range\s*rover|\brr\b/.test(m)) {
    if (inR(1971, 1994)) return col("U_M_RR_71_94", "Range Rover Classic 1971-1994");
    if (inR(1994, 2001)) return col("U_M_RR_94_01", "Range Rover P38 1994-2001");
    if (inR(2002, 2012)) return col("U_M_RR_02_12", "Range Rover L322 2002-2012");
    if (inR(2013, 2021)) return col("U_M_RR_13_22", "Range Rover L405 2013-2022");
    if (y != null && y >= 2022) return col("U_M_RR_22", "Range Rover L460 2022+");
    return need("Range Rover");
  }
  if (/defender/.test(m)) {
    if ((y != null && y >= 2020) || /l663|new\s*defender/.test(m)) return col("U_M_Def_New", "Defender L663 (2020+)");
    return col("U_M_Def_Old", "Defender (old-style, 1983-2016)");   // unqualified Defender = Def_Old
  }
  if (/discovery|disco/.test(m)) {
    const n = (m.match(/disco(?:very)?\s*([1-5])/) || [])[1];
    if (n) return col("U_M_Disc" + n, "Discovery " + n);
    if (inR(1989, 1998)) return col("U_M_Disc1", "Discovery 1");
    if (inR(1998, 2004)) return col("U_M_Disc2", "Discovery 2");
    if (inR(2004, 2009)) return col("U_M_Disc3", "Discovery 3");
    if (inR(2009, 2016)) return col("U_M_Disc4", "Discovery 4");
    if (y != null && y >= 2017) return col("U_M_Disc5", "Discovery 5");
    return need("Discovery (number or year)");
  }
  if (/freelander/.test(m)) {
    if (/freelander\s*2|frl\s*2|\bfl2\b/.test(m)) return col("U_M_Free_2", "Freelander 2");
    if (/freelander\s*1|frl\s*1|\bfl1\b/.test(m)) return col("U_M_Free_1", "Freelander 1");
    if (inR(1997, 2006)) return col("U_M_Free_1", "Freelander 1");
    if (inR(2006, 2014)) return col("U_M_Free_2", "Freelander 2");
    return need("Freelander (1 or 2)");
  }
  if (/series\s*1|series\s*i\b/.test(m)) return col("U_M_Series1", "Series 1");
  if (/series\s*(2|3|2a|ii|iii)/.test(m)) return col("U_M_Series_2_3", "Series 2/3");
  if (/jaguar/.test(m)) return col("U_M_Jaguar", "Jaguar");
  return { column: null, matched: false, model_label: model || null, year_needed: false };
}

const FINDER_STOP = new Set(["the", "for", "and", "my", "a", "an", "to", "is", "of", "with", "need", "want", "please", "part", "parts", "fit", "fits", "land", "rover"]);
function tokenize(s) {
  return [...new Set((String(s || "").toLowerCase().match(/[a-z0-9]{2,}/g) || []))]
    .filter((t) => !FINDER_STOP.has(t)).slice(0, 8);
}

// First description token that maps to a product category column (soft ranking boost only).
const CAT_MAP = {
  brake: "U_C_Braking", brakes: "U_C_Braking", disc: "U_C_Braking", discs: "U_C_Braking",
  pad: "U_C_Braking", pads: "U_C_Braking", caliper: "U_C_Braking", rotor: "U_C_Braking",
  clutch: "U_C_Clutch", exhaust: "U_C_Exhaust", silencer: "U_C_Exhaust",
  filter: "U_C_Service", oil: "U_C_Service", service: "U_C_Service", spark: "U_C_Service",
  suspension: "U_C_Axle_Susp", shock: "U_C_Axle_Susp", shocks: "U_C_Axle_Susp",
  spring: "U_C_Axle_Susp", wishbone: "U_C_Axle_Susp",
  bearing: "U_C_Drive_Mech", driveshaft: "U_C_Drive_Mech", propshaft: "U_C_Drive_Mech", cv: "U_C_Drive_Mech",
  gearbox: "U_C_Gearbox", radiator: "U_C_Cool_Heat", coolant: "U_C_Cool_Heat",
  thermostat: "U_C_Cool_Heat", heater: "U_C_Cool_Heat",
  fuel: "U_C_Fuel_System", injector: "U_C_Fuel_System",
  sensor: "U_C_Electrical", light: "U_C_Electrical", lamp: "U_C_Electrical",
  battery: "U_C_Electrical", alternator: "U_C_Electrical", starter: "U_C_Electrical",
  gasket: "U_C_Engine", timing: "U_C_Engine", belt: "U_C_Engine",
};
function categoryFromTokens(tokens) {
  for (const t of (tokens || [])) { const c = CAT_MAP[t]; if (c && VALID_CAT_COLS.has(c)) return c; }
  return null;
}

// Pure ranking: score each candidate row by description-token overlap (across name + fitment
// note + alternatives) with boosts for in-stock, ABC tier and a category-flag hit. Returns the
// top N shaped candidates with the fitment evidence attached. No I/O — unit-testable.
function rankCandidates(rows, tokens, opts = {}) {
  const toks = (tokens || []).map((t) => t.toLowerCase());
  const abcBoost = (a) => ({ "A+": 2, A: 1.5, B: 1 }[(a || "").trim()] || 0);
  const scored = (rows || []).map((r) => {
    const hay = ((r.ItemName || "") + " " + (r.U_Tag_Model || "") + " " + (r.U_Alternatives || "")).toLowerCase();
    const hit = toks.filter((t) => hay.includes(t));
    let score = hit.length * 10 + (r.OnHand > 0 ? 3 : 0) + abcBoost(r.U_ABC);
    if (opts.hasCat && String(r.CatFlag || "").toUpperCase() === "Y") score += 4;
    return { r, score, hit };
  });
  scored.sort((a, b) =>
    b.score - a.score ||
    ((b.r.OnHand > 0 ? 1 : 0) - (a.r.OnHand > 0 ? 1 : 0)) ||
    ((a.r.WebPrice == null ? 1e9 : a.r.WebPrice) - (b.r.WebPrice == null ? 1e9 : b.r.WebPrice))
  );
  return scored.slice(0, opts.limit || 15).map(({ r, score, hit }) => ({
    item_code: r.ItemCode,
    customer_code: customerCode(r),
    name: (r.ItemName || "").trim() || undefined,
    quality: (r.U_Quality || "").trim() || undefined,
    on_hand: r.OnHand,
    availability: availabilityOf(r.OnHand, r.U_WS_DropShip),
    web_price_excl_vat: r.WebPrice == null ? undefined : r.WebPrice,
    fitment: r.U_Tag_Model ? String(r.U_Tag_Model).replace(/\s+/g, " ").trim().slice(0, 200) : undefined,
    handle: (opts.handleMap || {})[r.ItemCode] || undefined,
    match: { model_flag: opts.column || null, tokens_matched: hit, score: Math.round(score * 10) / 10 },
  }));
}

// Batched, best-effort Shopify product handles for a set of ItemCodes (skus). One read-only
// call; never throws (a Shopify hiccup must not fail a finder/dossier lookup).
async function shopifyHandles(itemCodes) {
  try {
    const skus = [...new Set((itemCodes || []).map((s) => String(s).replace(/[^A-Za-z0-9._/-]/g, "")).filter(Boolean))].slice(0, 50);
    if (!skus.length) return {};
    const search = skus.map((s) => `sku:${s}`).join(" OR ");
    const data = await shopifyGraphql(`{ productVariants(first: 50, query: ${JSON.stringify(search)}) { edges { node { sku product { handle } } } } }`);
    const map = {};
    for (const e of (data.productVariants && data.productVariants.edges) || []) {
      const n = e.node || {};
      if (n.sku && n.product && n.product.handle) map[n.sku] = n.product.handle;
    }
    return map;
  } catch (e) { return {}; }
}

async function partFinder(params = {}) {
  const { description = "", model = "", year = null, engine = "", vin = "" } = params;
  const vinInfo = vin ? vinDecode(vin) : null;
  const useModel = (model && String(model).trim()) || (vinInfo && vinInfo.model) || "";
  const useYear = year || (vinInfo && vinInfo.year) || null;
  const mc = modelToColumn(useModel, useYear);
  const tokens = tokenize(description);
  const catCol = categoryFromTokens(tokens);

  const vehicle = {
    model: useModel || null, year: useYear || null, engine: (engine && String(engine).trim()) || null,
    source: vin ? "vin" : "given", vin: vinInfo ? vinInfo.vin : undefined, year_approx: vinInfo ? true : undefined,
    model_flag: mc.column || null,
    confidence: mc.column ? (vin && !(model && String(model).trim()) ? "medium" : "high") : "low",
  };
  const out = { vehicle, candidates: [], note: "" };

  if (!mc.column && !tokens.length) {
    out.note = "Give a model (and year) and/or a part description to search.";
    return out;
  }

  const pool = await getPool();
  const req = pool.request();
  const where = ["I.U_Shopify_Active='y'", "I.validFor='y'"];
  if (mc.column) where.push(`I.${mc.column}='Y'`);   // column whitelisted in modelToColumn
  if (tokens.length) {
    tokens.forEach((t, i) => req.input("t" + i, sql.NVarChar, "%" + t + "%"));
    const ors = tokens.map((_, i) => `I.ItemName LIKE @t${i} OR CAST(I.U_Tag_Model AS NVARCHAR(MAX)) LIKE @t${i} OR I.U_Alternatives LIKE @t${i}`).join(" OR ");
    where.push("(" + ors + ")");
  }
  const catSelect = catCol && VALID_CAT_COLS.has(catCol) ? `, I.${catCol} AS CatFlag` : "";
  // Order by description-token overlap FIRST so the most-relevant rows survive the TOP cap
  // (a common token like "front" matches hundreds of parts; without this a 3-token disc match
  // could be crowded out before the model sees it — the truncation problem P1.3 also addresses).
  const relevance = tokens.length
    ? tokens.map((_, i) => `CASE WHEN (I.ItemName LIKE @t${i} OR CAST(I.U_Tag_Model AS NVARCHAR(MAX)) LIKE @t${i} OR I.U_Alternatives LIKE @t${i}) THEN 1 ELSE 0 END`).join(" + ")
    : "0";
  const rows = (await req.query(
    `SELECT TOP (80) I.ItemCode, I.U_WS_LRNo, I.U_Code_AllMakes, I.U_Code_BritPart, I.U_Code_Hotbray,
            I.ItemName, I.U_Quality, I.U_ABC, I.OnHand, I.U_WS_DropShip, P.Price AS WebPrice,
            CAST(I.U_Tag_Model AS NVARCHAR(MAX)) AS U_Tag_Model, I.U_Alternatives${catSelect}
     FROM OITM I LEFT JOIN ITM1 P ON P.ItemCode = I.ItemCode AND P.PriceList = 1
     WHERE ${where.join(" AND ")}
     ORDER BY (${relevance}) DESC, CASE WHEN I.OnHand > 0 THEN 0 ELSE 1 END, I.U_ABC`
  )).recordset;

  const handleMap = await shopifyHandles(rows.map((r) => r.ItemCode));
  out.candidates = rankCandidates(rows, tokens, { column: mc.column, hasCat: !!catCol, handleMap, limit: 15 });

  const notes = [];
  if (!mc.column && useModel) notes.push(mc.year_needed
    ? `Could not pin ${mc.model_label || useModel} without a model year — searched by description only.`
    : `Model "${useModel}" not recognised — searched by description only.`);
  if (!useModel && !vin) notes.push("No vehicle given — results are description-only; ask for model + year + engine to narrow fitment.");
  if (vehicle.engine) notes.push("Engine is not a fitment column — used only as a ranking hint; confirm engine/VIN-specific fitment with the customer or EPC.");
  if (vin && !(vinInfo && vinInfo.model)) notes.push("VIN gives the model year; confirm the exact model — VIN-specific fitment still needs a human/EPC check.");
  out.note = notes.join(" ");
  return out;
}

// ---------- Phone lookup (voicemail caller match) ----------
// Pull phone-number-like sequences out of free text (e.g. a voicemail notification body).
function extractPhoneNumbers(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/\+?\d[\d\s().\-\/]{6,}\d/g)) {
    if (m[0].replace(/\D/g, "").length >= 9) out.push(m[0].trim());
  }
  return [...new Set(out)];
}

// Match a caller number against OCRD.Phone1/Phone2 regardless of stored format. Numbers
// are stored inconsistently (+31, 0031, 0, spaces, dashes), so we compare the last 9
// significant digits on both sides: SQL strips separators with nested REPLACEs and takes
// RIGHT(...,9); we do the same to the search number. Handles +31 6.., 0031 6.., 06.. etc.
function last9(s) { return String(s || "").replace(/\D/g, "").slice(-9); }
async function findCustomerByPhone(numbers) {
  const keys = [...new Set((numbers || []).map(last9).filter((d) => d.length === 9))];
  if (!keys.length) return null;
  const strip = (col) =>
    `RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(ISNULL(${col},''),' ',''),'-',''),'+',''),'(',''),')',''),'.',''),'/',''),9)`;
  const pool = await getPool();
  for (const k of keys) {
    const r = await pool.request().input("p", sql.NVarChar, k).query(
      `SELECT TOP 1 CardCode, CardName, Phone1, Phone2 FROM OCRD
       WHERE ${strip("Phone1")} = @p OR ${strip("Phone2")} = @p`
    );
    if (r.recordset.length) return { ...r.recordset[0], matched: k };
  }
  return null;
}

// ---------- Shopify (read-only custom app, GraphQL only) ----------
let shopifyTokenCache = null;
async function shopifyToken() {
  if (shopifyTokenCache && shopifyTokenCache.expires > Date.now()) return shopifyTokenCache.token;
  const r = await fetch(`https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  const data = await r.json();
  if (!data.access_token) throw new Error("no Shopify token");
  shopifyTokenCache = { token: data.access_token, expires: Date.now() + 23 * 3600 * 1000 };
  return shopifyTokenCache.token;
}

async function shopifyGraphql(query) {
  const token = await shopifyToken();
  const r = await fetch(`https://${process.env.SHOPIFY_SHOP}.myshopify.com/admin/api/2025-07/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query }),
  });
  const data = await r.json();
  if (!data.data) throw new Error(JSON.stringify(data.errors));
  return data.data;
}

async function shopifyCustomerContext(email) {
  const clean = String(email).replace(/[\s"\\]/g, "");
  const data = await shopifyGraphql(`{ customers(first: 1, query: "email:${clean}") { edges { node {
    displayName numberOfOrders
    orders(first: 5, reverse: true) { edges { node {
      name createdAt displayFulfillmentStatus displayFinancialStatus
      totalPriceSet { shopMoney { amount currencyCode } } } } }
  } } } }`);
  return data.customers.edges.map((e) => e.node);
}

async function shopifyOrderByName(orderName) {
  const clean = String(orderName).replace(/[^A-Za-z0-9#]/g, "");
  const data = await shopifyGraphql(`{ orders(first: 1, query: "name:${clean}") { edges { node {
    name createdAt displayFulfillmentStatus displayFinancialStatus
    customer { displayName email }
    fulfillments(first: 3) { trackingInfo { number url company } }
    lineItems(first: 10) { edges { node { sku name quantity } } }
  } } } }`);
  return data.orders.edges.map((e) => e.node);
}

// ---------- MyParcel (tracking read) ----------
// Code maps from the official API reference (developer.myparcel.nl, data-types; verified
// 2026-06-10). Raw integer codes are translated so the model and the salesperson never see
// a bare "status 3". READ-ONLY: search + track only, never shipment creation.
//
// TWO BRANCHES (added 2026-08-04). MyParcel issues ONE API KEY PER SHOP, and a key can only read
// its own shop — anything else returns 401 readResourceOwnedByOthers. Budget Parts runs two shops
// under one account (207826): 137660 "Budget Parts B.V." (Gouda) and 137714 "Budget Parts Noord"
// (Drachten). Until now Axle held only the Gouda key, so every parcel lookup for the drachten@
// mailbox silently found nothing — 3,734 Drachten shipments were invisible. Searches and tracking
// therefore fan out over every configured key and merge, tagging each result with its branch.
const MYPARCEL_STATUS = {
  1: "pending - concept", 2: "pending - registered", 3: "enroute - handed to carrier",
  4: "enroute - sorting", 5: "enroute - distribution", 6: "enroute - customs",
  7: "delivered - at recipient", 8: "delivered - ready for pickup", 9: "delivered - package picked up",
  10: "delivered - return ready for pickup", 11: "delivered - return picked up",
  12: "printed - letter", 13: "credited", 14: "printed - digital stamp",
  15: "printed - external shipment", 16: "expired", 17: "cancelled", 18: "printed - untracked",
  19: "delivered - at agreed location",
  30: "inactive - concept", 31: "inactive - registered", 32: "inactive - handed to carrier",
  33: "inactive - sorting", 34: "inactive - distribution", 35: "inactive - customs",
  36: "inactive - delivered", 37: "inactive - ready for pickup", 38: "inactive - picked up",
};
const MYPARCEL_CARRIER = {
  1: "PostNL", 2: "bpost", 3: "CheapCargo", 4: "DPD", 5: "Instabox", 6: "DHLCheapCargo",
  7: "BOL", 8: "UPS (legacy)", 9: "DHL For You", 10: "DHL Parcel Connect", 11: "DHL Europlus",
  12: "UPS Standard", 13: "UPS Express Saver", 14: "GLS", 15: "BRT", 16: "Trunkrs",
  17: "InPost", 18: "PosteItaliane",
};
const MYPARCEL_PKG = { 1: "package", 2: "mailbox package", 3: "letter", 4: "digital stamp", 5: "pallet", 6: "small package", 7: "envelope" };
const MYPARCEL_DELIVERY = { 1: "morning", 2: "standard", 3: "evening", 4: "pickup point" };
const mpStatus = (code) => `${code} (${MYPARCEL_STATUS[code] || "unknown"})`;
const mpFlag = (v) => (Number(v) === 1 || v === true) || undefined;  // 0/absent -> undefined (kept out of output)

// One entry per shop: MYPARCEL_API_KEY is the primary (labelled by MYPARCEL_SHOP_LABEL, default
// "gouda"); any MYPARCEL_API_KEY_<LABEL> adds another, e.g. MYPARCEL_API_KEY_DRACHTEN. Built lazily
// so a key added to the environment is picked up without a code change, and so Axle keeps working
// unchanged when only one key is configured.
function mpAccounts() {
  const out = [];
  if (process.env.MYPARCEL_API_KEY) {
    out.push({ shop: (process.env.MYPARCEL_SHOP_LABEL || "gouda").toLowerCase(), key: process.env.MYPARCEL_API_KEY });
  }
  for (const [k, v] of Object.entries(process.env)) {
    const m = /^MYPARCEL_API_KEY_(.+)$/.exec(k);
    if (m && v && v.trim()) out.push({ shop: m[1].toLowerCase(), key: v.trim() });
  }
  return out;
}

function mpHeaders(key) {
  const auth = Buffer.from(key || process.env.MYPARCEL_API_KEY).toString("base64");
  return { Authorization: `basic ${auth}`, Accept: "application/json", "User-Agent": "CustomApiCall/2" };
}

// Run a read against every configured shop. A branch being down, or a shipment id belonging to the
// other branch (which answers 401), must never sink the whole lookup — a partial answer beats none
// when a customer is waiting on a tracking link.
async function mpFanOut(fn) {
  const accounts = mpAccounts();
  const settled = await Promise.all(accounts.map(async (a) => {
    try { return { shop: a.shop, value: await fn(a) }; }
    catch { return { shop: a.shop, value: null }; }
  }));
  return settled.filter((r) => r.value);
}

// One shipment, mapped to the data points the team actually uses when creating shipments:
// reference (= SAP order number on the label), status, carrier, package type, delivery
// options (signature / only-recipient / return / age-check / insurance), the full recipient
// address, dates and multi-collo linkage. Use myparcelTrack(id) for events + tracking link.
function mpShipment(s) {
  const o = s.options || {};
  const r = s.recipient || {};
  return {
    id: s.id,
    barcode: s.barcode || undefined,
    status: mpStatus(s.status),
    carrier: MYPARCEL_CARRIER[s.carrier_id || s.carrier] || `carrier ${s.carrier_id || s.carrier || "?"}`,
    reference: o.label_description || s.reference_identifier || undefined,
    created: s.created,
    package_type: MYPARCEL_PKG[o.package_type] || o.package_type,
    delivery_type: MYPARCEL_DELIVERY[o.delivery_type],
    delivery_date_chosen: o.delivery_date || undefined,   // the chosen/planned date, not actual delivery
    signature: mpFlag(o.signature), only_recipient: mpFlag(o.only_recipient),
    return_if_not_home: mpFlag(o.return), age_check: mpFlag(o.age_check),
    insurance_eur: o.insurance && o.insurance.amount ? o.insurance.amount / 100 : undefined,
    // Declared parcel weight in grams. Added 2026-08-15 for carrier claims: on a lost-parcel
    // investigation the weight is evidence about what was in the box, and it was the one field
    // the claim brief wanted that this mapper did not carry.
    weight_g: (s.physical_properties && s.physical_properties.weight) || undefined,
    recipient: {
      person: r.person, company: r.company || undefined,
      street: [r.street, r.number, r.number_suffix].filter(Boolean).join(" ") || undefined,
      postal_code: r.postal_code, city: r.city, country: r.cc,
      email: r.email || undefined, phone: r.phone || undefined,
    },
    multi_collo_main_id: s.multi_collo_main_shipment_id || undefined,
  };
}

async function myparcelSearch(searchTerm, size = 5) {
  const n = Math.min(Math.max(parseInt(size, 10) || 5, 1), 10);
  const url = `https://api.myparcel.nl/shipments?q=${encodeURIComponent(searchTerm)}&size=${n}`;
  const per = await mpFanOut(async (a) => {
    const r = await fetch(url, { headers: mpHeaders(a.key) });
    if (!r.ok) return null;
    const data = await r.json();
    return data.data.shipments || [];
  });
  // Newest first across both branches, then trim to what the caller asked for.
  return per
    .flatMap(({ shop, value }) => value.map((s) => ({ shop, s })))
    .sort((x, y) => String(y.s.created).localeCompare(String(x.s.created)))
    .slice(0, n)
    .map(({ shop, s }) => ({ shop, ...mpShipment(s) }));
}

// Track & trace for shipment id(s) from myparcelSearch (GET /tracktraces/{id;id}).
// Returns per shipment: human-readable current status, the latest event, expected/estimated
// delivery moment, the customer-facing tracking link (carrier page preferred) and the full
// event history. Multiple ids per call to stay under the API rate limit.
async function myparcelTrack(shipmentIds) {
  const ids = (Array.isArray(shipmentIds) ? shipmentIds : String(shipmentIds).split(/[;,\s]+/))
    .map((x) => parseInt(x, 10)).filter((x) => x > 0).slice(0, 10);
  if (!ids.length) return [];
  const url = `https://api.myparcel.nl/tracktraces/${ids.join(";")}?extra_info=delivery_moment`;
  const per = await mpFanOut(async (a) => {
    const r = await fetch(url, { headers: mpHeaders(a.key) });
    if (!r.ok) return null;
    const data = await r.json();
    return data.data.tracktraces || [];
  });
  // An id belongs to exactly one branch, so first answer wins; dedupe guards against overlap.
  const seen = new Set();
  const merged = [];
  for (const { shop, value } of per) {
    for (const t of value) {
      if (seen.has(t.shipment_id)) continue;
      seen.add(t.shipment_id);
      merged.push({ shop, t });
    }
  }
  return merged.map(({ shop, t }) => ({
    shop,
    shipment_id: t.shipment_id,
    status: t.status ? mpStatus(t.status.current) : undefined,
    phase: t.status ? t.status.main : undefined,               // registered|handed_to_carrier|sorting|distribution|delivered
    final: t.status ? Boolean(t.status.final) : undefined,     // true = no further updates expected
    latest_event: { code: t.code, description: t.description, time: t.time },
    delayed: Boolean(t.delayed) || undefined,
    delivery_moment_type: t.delivery_moment_type || undefined, // 'expected' | 'estimated'
    delivery_moment: (t.delivery_moment && t.delivery_moment.start && t.delivery_moment.start.date) || undefined,
    tracking_url: t.link_tracktrace || t.link_consumer_portal || undefined,
    history: (t.history || []).map((h) => ({ time: h.time, code: h.code, description: h.description })),
  }));
}

// ---------- Return dossier: everything we know about ONE return request ----------
// One assembled object for a return/withdrawal request, so the drafting model does not
// stitch together Shopify + SAP by hand. Given an order reference the customer quotes (a
// Shopify order name #S18522 / S18522, or a SAP DocNum), it pulls:
//   * the Shopify Return object (status + per-line reason/note/customerNote/sku) — the
//     self-service "Return items" intake — plus the order's real customer email;
//   * the SAP order (ORDR, joined by NumAtCard = the Shopify name), whether an AR invoice
//     exists (OINV = shipped/collected; its date starts the 14-day withdrawal clock and is
//     the credit-note reference), the payment method (U_Paid → refund route), the order total;
//   * per-item facts (OITM/ITM1: name, quality, ABC, category, customer code, price);
//   * customer signals (OCRD: VAT number, tier, prior credit-note count = return history).
// It DERIVES hints only — days since invoice, withdrawal/goodwill windows, a default
// who-pays-return-shipping per reason, a business-vs-consumer signal, an electrical hint,
// a refund route. These are HINTS for the model, which makes the final judgement (Brad's
// "use AI logic" for electrical + B2C/B2B). READ-ONLY: reads Shopify + SAP, writes nothing.

// Shopify returnReason enum -> who bears return shipping by default. Our error = we pay;
// change-of-mind = customer pays; ambiguous/blank = confirm with the customer (this is the
// only case the draft asks the reason, per the agreed design).
const RETURN_REASON_WHOPAYS = {
  DEFECTIVE: "us", WRONG_ITEM: "us", NOT_AS_DESCRIBED: "us",
  UNWANTED: "customer", SIZE_TOO_SMALL: "customer", SIZE_TOO_LARGE: "customer",
  STYLE: "customer", COLOR: "customer",
  OTHER: "confirm", UNKNOWN: "confirm",
};
function whoPaysForReason(reason) {
  return RETURN_REASON_WHOPAYS[String(reason || "").toUpperCase()] || "confirm";
}

// Business-vs-consumer signal from the card name + VAT number (no hard SAP field — Brad's
// decision is to judge it). A VAT number present, or a business marker in the name, => likely
// business (no statutory withdrawal right; 15% restocking fee may apply). The model decides.
// Leading boundary only (no trailing \b) so concatenated business words match too — e.g.
// "Autobedrijf Jansen" / "Garagebedrijf" (the standard Dutch forms) must read as business.
const BUSINESS_NAME_RE = /\b(auto|bedrijf|b\.?v\.?\b|service|garage|ltd|gmbh|holding|automotive|4x4|motors|trading|company|handel|onderdelen|parts|tuning|classics?)/i;
function businessSignal(name, vat) {
  const hasVat = !!String(vat || "").trim();
  const nameHit = BUSINESS_NAME_RE.test(String(name || ""));
  return { likely_business: hasVat || nameHit, has_vat: hasVat, name_marker: nameHit };
}

// Electrical hint from the item name/category (no hard SAP field — the model confirms). Used
// only to surface the sealed / diminished-value rule as a proposal, never an auto-deduction.
const ELECTRICAL_RE = /\b(electr|sensor|ecu|relay|switch|solenoid|module|wiring|loom|harness|motor|actuator|lamp|light|bulb|headlamp|coil|battery|alternator|starter|gauge|pump|ignition|abs|airbag|control unit|amplifier|antenna|aerial)\b/i;
function electricalHint(name, cat) {
  return ELECTRICAL_RE.test(String(name || "") + " " + String(cat || ""));
}

const PAYMENT_METHOD = { Y: "paid", N: "unpaid", P: "PIN", C: "Cash", S: "Shopify", B: "Bank", A: "Account" };
// Refund route from the SAP payment letter: Shopify orders refund via Shopify; bank/PIN need
// the customer's IBAN; account is settled on the account. A credit note is always issued.
function refundRoute(uPaid) {
  const p = String(uPaid || "").toUpperCase();
  if (p === "S") return "refund via Shopify (original payment)";
  if (p === "B" || p === "P") return "refund by bank transfer — ask the customer for their IBAN";
  if (p === "A") return "settle on the customer's account";
  if (p === "N") return "order not marked paid — verify payment before any refund";
  return "confirm payment method before refunding";
}

const daysBetween = (a, b) => Math.floor((a.getTime() - b.getTime()) / 86400000);

async function returnDossier(orderRef, opts = {}) {
  const raw = String(orderRef || "").trim();
  const mName = raw.match(/S\d{4,6}/i);                       // Shopify order name digits
  const shopName = mName ? mName[0].toUpperCase() : null;     // e.g. "S18522"
  const mDoc = raw.match(/\b\d{5,7}\b/);                      // a bare SAP DocNum
  const sapDocNum = !shopName && mDoc ? parseInt(mDoc[0], 10) : null;
  if (!shopName && !sapDocNum) return { order_ref: raw, found: false, note: "no Shopify order name (S#####) or SAP DocNum found in the reference" };

  const pool = await getPool();
  const numAtCard = shopName ? "#" + shopName : null;
  const today = opts.now ? new Date(opts.now) : new Date();

  // --- Shopify: order (always) + Return object (best effort) ---
  // Two calls on purpose: the base order + line items read with the standard read_orders scope,
  // while the Return object needs the read_returns scope. Splitting them means a missing read_returns
  // grant degrades to "returns unavailable" instead of nuking the whole lookup (the whole query is
  // rejected — data:null — when a single denied field is present).
  let shop = null, returnsAvailable = false, returnsError = null;
  if (shopName) {
    try {
      const d = await shopifyGraphql(`{ orders(first:1, query:"name:${shopName}") { edges { node {
        name createdAt email displayFulfillmentStatus
        customer { email numberOfOrders }
        lineItems(first:30) { edges { node { sku name quantity } } }
      } } } }`);
      shop = (d.orders.edges[0] && d.orders.edges[0].node) || null;
    } catch (e) { shop = { error: e.message }; }
    if (shop && !shop.error) {
      try {
        const dr = await shopifyGraphql(`{ orders(first:1, query:"name:${shopName}") { edges { node {
          returns(first:5) { nodes { name status totalQuantity
            returnLineItems(first:20) { nodes { __typename ... on ReturnLineItem {
              quantity returnReason returnReasonNote customerNote
              fulfillmentLineItem { lineItem { name sku quantity } } } } } } }
        } } } }`);
        const rnode = dr.orders.edges[0] && dr.orders.edges[0].node;
        if (rnode) { shop.returns = rnode.returns; returnsAvailable = true; }
      } catch (e) { returnsError = e.message; }   // e.g. read_returns scope not granted
    }
  }

  // --- SAP: the order (join by NumAtCard = Shopify name, else by DocNum) ---
  let sapOrder = null;
  {
    const req = pool.request();
    let where;
    if (numAtCard) { req.input("nac", sql.NVarChar, numAtCard); where = `T0."NumAtCard" = @nac`; }
    else { req.input("dn", sql.Int, sapDocNum); where = `T0."DocNum" = @dn`; }
    const r = await req.query(
      `SELECT TOP 1 T0."DocEntry", T0."DocNum", T0."CardCode", T0."CardName", T0."NumAtCard",
              T0."DocStatus", T0."U_Paid", T0."DocTotal", T0."DocDate"
       FROM ORDR T0 WHERE ${where} ORDER BY T0."DocDate" DESC`);
    sapOrder = r.recordset[0] || null;
  }

  // --- SAP: AR invoice existence = shipped/collected; date = withdrawal clock + credit ref ---
  let invoice = null;
  {
    const req = pool.request();
    let where;
    if (numAtCard) { req.input("nac", sql.NVarChar, numAtCard); where = `T0."NumAtCard" = @nac`; }
    else if (sapOrder) { req.input("cc", sql.NVarChar, sapOrder.CardCode); req.input("dt", sql.Numeric, sapOrder.DocTotal); where = `T0."CardCode" = @cc AND T0."DocTotal" = @dt`; }
    else { where = "1=0"; }
    const r = await req.query(
      `SELECT TOP 1 T0."DocNum", T0."DocDate", T0."DocTotal" FROM OINV T0 WHERE ${where} ORDER BY T0."DocDate" DESC`);
    invoice = r.recordset[0] || null;
  }

  // --- Item facts for the SKUs on the return (fallback: the order's Shopify line SKUs) ---
  const retLines = [];
  const shopReturns = (shop && shop.returns && shop.returns.nodes) || [];
  for (const ret of shopReturns) {
    for (const li of (ret.returnLineItems && ret.returnLineItems.nodes) || []) {
      const fl = li.fulfillmentLineItem && li.fulfillmentLineItem.lineItem;
      retLines.push({
        return_name: ret.name, return_status: ret.status,
        sku: (fl && fl.sku) || null, line_name: (fl && fl.name) || null,
        quantity: li.quantity, reason: li.returnReason || null,
        reason_note: li.returnReasonNote || null, customer_note: li.customerNote || null,
      });
    }
  }
  // Order's Shopify line items (always readable) — used for product facts and, when the return
  // object is unavailable (missing read_returns scope), as the fitment/value context the engine
  // matches the notification's returned items against.
  const orderLineSkus = ((shop && shop.lineItems && shop.lineItems.edges) || []).map((e) => e.node.sku).filter(Boolean);
  const skus = [...new Set([...retLines.map((l) => l.sku), ...orderLineSkus].filter(Boolean))].slice(0, 30);

  let itemsByCode = {};
  if (skus.length) {
    const req = pool.request();
    const ph = skus.map((code, i) => { req.input("s" + i, sql.NVarChar, code); return "@s" + i; });
    const r = await req.query(
      `SELECT T0."ItemCode", T0."ItemName", T0."U_Quality", T0."U_ABC", T0."U_Tag_Cat",
              T0."U_Code_AllMakes", T0."U_Code_BritPart", T0."U_Code_Hotbray", T0."U_WS_LRNo",
              T0."U_WS_DropShip", T1."Price" AS "WebPrice"
       FROM OITM T0 LEFT JOIN ITM1 T1 ON T0."ItemCode" = T1."ItemCode" AND T1."PriceList" = 1
       WHERE T0."ItemCode" IN (${ph.join(",")})`);
    for (const row of r.recordset) itemsByCode[row.ItemCode] = row;
  }

  // --- Customer signals (OCRD): VAT, tier, prior credit-note count = return history ---
  let customer = null;
  if (sapOrder) {
    const r = await pool.request().input("cc", sql.NVarChar, sapOrder.CardCode).query(
      `SELECT TOP 1 T0."CardCode", T0."CardName", T0."LicTradNum", T0."E_Mail",
              T2."ListName",
              (SELECT COUNT(*) FROM ORIN X WHERE X."CardCode"=T0."CardCode") AS credit_notes,
              (SELECT COUNT(*) FROM OINV X WHERE X."CardCode"=T0."CardCode") AS invoices
       FROM OCRD T0 LEFT JOIN OPLN T2 ON T0."ListNum"=T2."ListNum" WHERE T0."CardCode"=@cc`);
    customer = r.recordset[0] || null;
  }

  // --- Derive hints (the model makes the final call) ---
  const shipped = !!invoice;
  const clockDate = invoice ? new Date(invoice.DocDate) : (sapOrder ? new Date(sapOrder.DocDate) : null);
  const daysSince = clockDate ? daysBetween(today, clockDate) : null;
  const custEmail = (shop && (shop.email || (shop.customer && shop.customer.email))) || (customer && customer.E_Mail) || null;
  const bizName = (customer && customer.CardName) || (sapOrder && sapOrder.CardName) || (shop && shop.customer && shop.customer.displayName) || "";
  const biz = businessSignal(bizName, customer && customer.LicTradNum);

  const factLine = (sku, base) => {
    const it = sku && itemsByCode[sku];
    return {
      ...base,
      customer_code: it ? customerCode(it) : sku,
      item_name: it ? it.ItemName : (base.line_name || undefined),
      quality: it ? it.U_Quality : undefined,
      abc: it ? it.U_ABC : undefined,
      category: it ? it.U_Tag_Cat : undefined,
      unit_price_excl_vat: it && it.WebPrice != null ? it.WebPrice : undefined,
      electrical_hint: it ? electricalHint(it.ItemName, it.U_Tag_Cat) : undefined,
    };
  };
  // The returned lines (reason-bearing) — populated only when the return object is readable.
  const lines = retLines.map((l) => ({ ...factLine(l.sku, l), who_pays_default: whoPaysForReason(l.reason) }));
  // All order line items with product facts — always available, and the context the engine matches
  // the notification's returned items against when the return object itself is not readable.
  const orderItems = orderLineSkus.map((sku, i) => {
    const node = ((shop && shop.lineItems && shop.lineItems.edges) || [])[i];
    return factLine(sku, { sku, line_name: node && node.node && node.node.name, quantity: node && node.node && node.node.quantity });
  });

  // return_object.present: true = a self-service return exists; false = none (e.g. a direct email);
  // "unknown" = we could not read it because the read_returns scope is not granted — the engine must
  // then take the returned items + reason from the notification email and ask the customer the reason.
  const returnObject = !returnsAvailable
    ? { present: "unknown", scope_missing: true,
        note: "Shopify read_returns scope not granted — read the returned items and reason from the notification email; treat who-pays as 'confirm' and ask the customer." }
    : shopReturns.length
      ? { present: true, status: shopReturns[0].status, name: shopReturns[0].name }
      : { present: false };

  return {
    order_ref: raw,
    shopify_name: shopName || (sapOrder && sapOrder.NumAtCard) || null,
    found: !!(sapOrder || (shop && !shop.error)),
    customer_email: custEmail,                 // the real recipient for a Shopify-notification reply
    customer_name: bizName || undefined,
    shopify_order_error: (shop && shop.error) || undefined,
    returns_available: returnsAvailable,       // false = read_returns scope missing (see return_object)
    return_object: returnObject,
    lines,
    order_items: orderItems,
    order: sapOrder ? {
      doc_num: sapOrder.DocNum, doc_status: sapOrder.DocStatus,
      order_date: sapOrder.DocDate, order_total_incl_vat: sapOrder.DocTotal,
      payment: PAYMENT_METHOD[String(sapOrder.U_Paid || "").toUpperCase()] || sapOrder.U_Paid,
      refund_route: refundRoute(sapOrder.U_Paid),
    } : null,
    invoice: invoice ? { doc_num: invoice.DocNum, date: invoice.DocDate, total: invoice.DocTotal } : null,
    shipped,                                    // AR invoice exists = goods shipped/collected
    days_since_shipped: daysSince,
    within_14_day_withdrawal: daysSince == null ? null : daysSince <= 14,   // B2C statutory
    within_goodwill_60: daysSince == null ? null : daysSince <= 60,          // 30 flex to 60
    customer_signal: biz,                       // model decides B2C vs B2B from this
    tier: customer ? customer.ListName : undefined,
    prior_credit_notes: customer ? customer.credit_notes : undefined,
    prior_invoices: customer ? customer.invoices : undefined,
    note: "Hints only — confirm electrical + B2C/B2B by judgement. Every system action (decline the Shopify return, create the credit note, refund) is a human to-do; Axle drafts only.",
  };
}

// ---------- Claim dossier: everything MyParcel's investigation needs, in one call ----------
// The carrier-claim counterpart of returnDossier. Given a BARCODE (never an order number the
// email asserts — see carrier-claim.js for why), it resolves our own shipment, then assembles
// what MyParcel asks for every time: the sales invoice to attach, the purchase value of the
// goods, a contents description, and the parcel's own facts.
//
// The purchase value is taken from INV1.StockPrice — the cost of goods SAP booked against that
// AR invoice line. That is deliberate and it is the heart of the design. It is the cost of the
// units that actually went in the box, it exists for every line including parts bought years ago
// with no traceable supplier invoice, and it is what our own books say those goods were worth.
// A "last purchase price" would be a different, later number for anything restocked since (four
// of order 227148's eight lines were bought again AFTER the parcel shipped), and two of its
// lines have no purchase record at all.
//
// The supplier invoice behind each line is carried as PROVENANCE only — the most recent purchase
// on or before the invoice date, so it can plausibly be the goods that shipped. It is shown in
// the statement as a reference; the supplier's own PDF is never sent (it lists unrelated parts
// and our whole cost base, which the team has refused before, correctly).
//
// READ-ONLY: one MyParcel read plus SAP SELECTs. Writes nothing, renders nothing, sends nothing.
async function claimDossier(barcode, opts = {}) {
  const CC = require("./carrier-claim.js");
  const raw = String(barcode || "").trim().toUpperCase();
  if (!raw) return { barcode: raw, found: false, note: "no barcode supplied" };

  // Dependencies are injectable so the suite can drive real SAP/MyParcel shapes without either
  // system. They default to the live ones; nothing but a test ever passes opts.deps.
  const deps = opts.deps || {};
  const mpSearch = deps.myparcelSearch || myparcelSearch;

  // 1. Our own shipment. No shipment, no dossier — there is no looser fallback by design.
  const shipment = await CC.resolveShipment(raw, { myparcelSearch: mpSearch });
  if (!shipment) {
    return {
      barcode: raw, found: false,
      note: "This barcode is not one of our MyParcel shipments (Gouda or Drachten), so no order, invoice or value can be established for it. Do not attach anything; ask the salesperson to check the barcode.",
    };
  }

  const pool = deps.pool || await getPool();
  const orderNums = shipment.sap_order_numbers.slice(0, 5).map((n) => parseInt(n, 10)).filter(Boolean);
  const notes = [];

  // 2. The SAP order(s) named on the label, and the AR invoice(s) copied from them. The invoice
  //    is linked structurally (INV1.BaseEntry -> ORDR.DocEntry, BaseType 17), not guessed at by
  //    matching totals: on a claim we are asserting to an insurer which document covers which
  //    parcel, so the link has to be the real one.
  let orders = [], invoices = [];
  if (orderNums.length) {
    const req = pool.request();
    const ph = orderNums.map((n, i) => { req.input("o" + i, sql.Int, n); return "@o" + i; });
    const r = await req.query(
      `SELECT T0."DocEntry", T0."DocNum", T0."CardCode", T0."CardName", T0."DocDate",
              T0."DocTotal", T0."U_Paid", T0."NumAtCard"
       FROM ORDR T0 WHERE T0."DocNum" IN (${ph.join(",")})`);
    orders = r.recordset;

    if (orders.length) {
      const req2 = pool.request();
      const ph2 = orders.map((o, i) => { req2.input("e" + i, sql.Int, o.DocEntry); return "@e" + i; });
      const r2 = await req2.query(
        `SELECT DISTINCT T2."DocEntry", T2."DocNum", T2."DocDate", T2."DocTotal", T2."DocCur",
                T2."CardCode", T2."CardName", T1."BaseEntry"
         FROM INV1 T1 JOIN OINV T2 ON T2."DocEntry" = T1."DocEntry"
         WHERE T1."BaseType" = 17 AND T1."BaseEntry" IN (${ph2.join(",")}) AND T2."CANCELED" = 'N'`);
      invoices = r2.recordset;
    }
  }
  if (!orderNums.length) notes.push("The shipment label carries no SAP order number, so no invoice could be linked.");
  else if (!orders.length) notes.push("The order number on the label matches no SAP order.");
  else if (!invoices.length) notes.push("No AR invoice was copied from this order, so the goods were never invoiced. Check with the salesperson before answering the claim.");

  // 3. Contents + purchase value, per invoice line.
  let contents = [], goodsExclVat = 0, purchaseValue = 0;
  if (invoices.length) {
    const req = pool.request();
    const ph = invoices.map((v, i) => { req.input("i" + i, sql.Int, v.DocEntry); return "@i" + i; });
    const r = await req.query(
      `SELECT T1."DocEntry", T1."LineNum", T1."ItemCode", T1."Dscription", T1."Quantity",
              T1."Price", T1."LineTotal", T1."StockPrice",
              T2."U_Quality", T2."U_Tag_Cat",
              COALESCE(NULLIF(T2."U_Code_AllMakes",''), NULLIF(T2."U_Code_BritPart",''),
                       NULLIF(T2."U_Code_Hotbray",''), NULLIF(T2."U_WS_LRNo",''), T1."ItemCode") AS "CustCode"
       FROM INV1 T1 LEFT JOIN OITM T2 ON T2."ItemCode" = T1."ItemCode"
       WHERE T1."DocEntry" IN (${ph.join(",")}) ORDER BY T1."DocEntry", T1."LineNum"`);

    // Provenance: the most recent A/P purchase of each item on or before the invoice date.
    const codes = [...new Set(r.recordset.map((x) => x.ItemCode).filter(Boolean))].slice(0, 40);
    const invDate = invoices[0].DocDate;
    let sourceByCode = {};
    if (codes.length) {
      const rq = pool.request();
      rq.input("cut", sql.DateTime, new Date(invDate));
      const cph = codes.map((c, i) => { rq.input("c" + i, sql.NVarChar, c); return "@c" + i; });
      const rs = await rq.query(
        `SELECT X."ItemCode", X."DocNum", X."DocDate", X."CardName", X."NumAtCard", X."Price" FROM (
           SELECT P1."ItemCode", P0."DocNum", P0."DocDate", P0."CardName", P0."NumAtCard", P1."Price",
                  ROW_NUMBER() OVER (PARTITION BY P1."ItemCode" ORDER BY P0."DocDate" DESC, P0."DocNum" DESC) AS rn
           FROM OPCH P0 JOIN PCH1 P1 ON P1."DocEntry" = P0."DocEntry"
           WHERE P0."CANCELED" = 'N' AND P0."DocDate" <= @cut AND P1."ItemCode" IN (${cph.join(",")})
         ) X WHERE X.rn = 1`);
      for (const row of rs.recordset) sourceByCode[row.ItemCode] = row;
    }

    for (const l of r.recordset) {
      const src = sourceByCode[l.ItemCode] || null;
      const lineCost = round2((l.Quantity || 0) * (l.StockPrice || 0));
      goodsExclVat = round2(goodsExclVat + (l.LineTotal || 0));
      purchaseValue = round2(purchaseValue + lineCost);
      if (!src) notes.push(`No purchase record on or before the invoice date for ${l.ItemCode}. Its cost is taken from SAP's booked stock value.`);
      contents.push({
        item_code: l.ItemCode,
        customer_code: l.CustCode,          // the code a catalogue shows — use THIS in the description
        description: l.Dscription,
        quality: l.U_Quality || null,       // Genuine | OEM | Aftermarket — the "brand" MyParcel asks for
        category: l.U_Tag_Cat || null,
        quantity: l.Quantity,
        unit_price_excl_vat: l.Price,
        line_total_excl_vat: l.LineTotal,
        unit_purchase_cost: l.StockPrice,
        line_purchase_cost: lineCost,
        purchase_source: src ? {
          supplier: src.CardName, supplier_invoice: src.NumAtCard,
          our_ap_docnum: src.DocNum, date: src.DocDate, unit_price: src.Price,
        } : null,
      });
    }
  }

  // 4. The insurance question, answered rather than raised. MyParcel pays out at 100% of the
  //    PURCHASE value, not the sales value — so the comparison that matters is cover against
  //    cost, and comparing cover against the invoice total (the intuitive move) overstates any
  //    shortfall. Both are returned so the brief can say so plainly.
  const insured = shipment.insurance_eur != null ? Number(shipment.insurance_eur) : null;
  const salesTotal = invoices.length ? round2(invoices.reduce((a, v) => a + (v.DocTotal || 0), 0)) : null;
  const insurance = {
    insured_eur: insured,
    purchase_value_eur: purchaseValue || null,
    sales_value_excl_vat_eur: goodsExclVat || null,
    invoice_total_eur: salesTotal,
    payout_basis: "MyParcel pays out at 100% of the PURCHASE value, so cover is judged against purchase value, not the invoice total.",
    covers_purchase_value: insured == null || !purchaseValue ? null : insured >= purchaseValue,
    shortfall_eur: insured == null || !purchaseValue ? null : round2(Math.max(0, purchaseValue - insured)),
  };

  return {
    barcode: raw,
    found: true,
    shipment: {
      shipment_id: shipment.shipment_id, shop: shipment.shop, carrier: shipment.carrier,
      status: shipment.status, created: shipment.created, reference: shipment.reference,
      weight_g: shipment.weight_g, recipient: shipment.recipient,
    },
    scope: { sap_order_numbers: shipment.sap_order_numbers, shopify_order_names: shipment.shopify_order_names },
    orders: orders.map((o) => ({
      doc_num: o.DocNum, doc_date: o.DocDate, card_code: o.CardCode, card_name: o.CardName,
      order_total: o.DocTotal, shopify_name: o.NumAtCard,
    })),
    // The verkoopfactuur: this is the document to attach, and the ONLY one resolved from SAP.
    sales_invoices: invoices.map((v) => ({
      doc_num: v.DocNum, date: v.DocDate, total: v.DocTotal, currency: v.DocCur || "EUR",
      card_code: v.CardCode, card_name: v.CardName,
    })),
    contents,
    purchase_value: purchaseValue ? {
      total_eur: purchaseValue,
      basis: "SAP booked cost of goods (INV1.StockPrice) on the AR invoice for this shipment.",
    } : null,
    insurance,
    // Our standard answer to MyParcel's "uiterlijke kenmerken" question. Supplied in BOTH
    // languages, and to be used verbatim: it is the same sentence on every claim, and left in
    // English the model re-translated it each time (2026-08-15: "bruin kartonnen doos", missing
    // the adjective inflection). Anything beyond this - a non-standard box, extra stickers - is a
    // salesperson question, never an assumption.
    parcel_appearance: {
      nl: "Bruine kartonnen doos, afgesloten met Budget Parts-tape.",
      en: "Brown cardboard box, sealed with Budget Parts branded tape.",
    },
    notes,
    note: "Read-only. Attach the sales invoice and the generated purchase-value statement; NEVER a supplier's own invoice. Anything not listed here (extra stickers, a non-standard box, product photos) is a salesperson question, not an assumption.",
  };
}

// Applied to every line AND cumulatively to the running total, which is what keeps the figure we
// quote an insurer clean: the eight lines of order 227148 sum to 74.51000000000002 if you only
// round at the end. See the note on money() in claim-statement.js for why there is no epsilon
// here - the values arrive from SAP at 2dp, and this rounds away the noise from qty x price.
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// ---------- Entity extraction (part numbers, order numbers) ----------
function extractEntities(text) {
  const partNumbers = [...new Set((text.match(/\b(?:[A-Z]{2,3}\d{6}[A-Z]?|\d{2}[A-Z]\d{4,5}[A-Z]?)\b/g) || []))];
  const orderNumbers = [...new Set((text.match(/#?S\d{5}\b/gi) || []).map((o) => o.replace("#", "").toUpperCase()))];
  return { partNumbers, orderNumbers };
}

module.exports = {
  htmlToText, graphToken, getMessages, resolveFolderId, searchMailbox, getMessageHtml, listAttachments, getAttachment,
  getMessageStates, folderIds, folderName,
  getPool, closePool, sapCustomerContext, sapStockPrice,
  partDossier, customerCode, assembleDossier, availabilityOf,
  partFinder, vinDecode, modelToColumn, rankCandidates, categoryFromTokens, tokenize, shopifyHandles,
  shopifyCustomerContext, shopifyOrderByName,
  myparcelSearch, myparcelTrack, extractEntities, shopifyGraphql,
  extractPhoneNumbers, findCustomerByPhone,
  returnDossier, whoPaysForReason, businessSignal, electricalHint, refundRoute,
  claimDossier,
};



