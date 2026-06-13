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

const MSG_SELECT = "id,conversationId,subject,from,receivedDateTime,body,categories,hasAttachments";

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

// Fetch all messages in one folder with receivedDateTime >= sinceIso (newest first),
// following @odata.nextLink pages up to maxPages. Server-side filter + ordering on the
// same property is allowed; pagination ends naturally once the filter is exhausted.
// When unreadOnly is set, the filter is on isRead instead, and $orderby is dropped --
// Graph rejects ordering by receivedDateTime while filtering on a different property
// (isRead). getMessages re-sorts the merged result newest-first client-side regardless.
async function fetchFolderSince(mailbox, folderRef, sinceIso, maxPages, unreadOnly) {
  const token = await graphToken();
  const folderId = await resolveFolderId(mailbox, folderRef);
  const filter = unreadOnly
    ? "&$filter=isRead eq false"
    : (sinceIso ? `&$filter=receivedDateTime ge ${sinceIso}` : "");
  const orderby = unreadOnly ? "" : "&$orderby=receivedDateTime desc";
  let url =
    `https://graph.microsoft.com/v1.0/users/${mailbox}/mailFolders/${folderId}/messages` +
    `?$top=50${orderby}${filter}&$select=${MSG_SELECT}`;
  const out = [];
  for (let page = 0; url && page < (maxPages || 10); page++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Prefer: "outlook.body-content-type=\"text\"" } });
    const data = await r.json();
    if (data.error) throw new Error(data.error.message);
    out.push(...(data.value || []));
    url = data["@odata.nextLink"] || null;
  }
  return out;
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
  for (const f of folders) {
    const rows = await fetchFolderSince(mailbox, f, sinceIso, maxPages, unreadOnly);
    for (const m of rows) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      merged.push(m);
    }
  }
  merged.sort((a, b) => (a.receivedDateTime < b.receivedDateTime ? 1 : a.receivedDateTime > b.receivedDateTime ? -1 : 0));
  const capped = opts.limit ? merged.slice(0, opts.limit) : merged;
  return capped.map(mapMessage);
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

function mpHeaders() {
  const auth = Buffer.from(process.env.MYPARCEL_API_KEY).toString("base64");
  return { Authorization: `basic ${auth}`, Accept: "application/json", "User-Agent": "CustomApiCall/2" };
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
  const r = await fetch(`https://api.myparcel.nl/shipments?q=${encodeURIComponent(searchTerm)}&size=${n}`, { headers: mpHeaders() });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.data.shipments || []).map(mpShipment);
}

// Track & trace for shipment id(s) from myparcelSearch (GET /tracktraces/{id;id}).
// Returns per shipment: human-readable current status, the latest event, expected/estimated
// delivery moment, the customer-facing tracking link (carrier page preferred) and the full
// event history. Multiple ids per call to stay under the API rate limit.
async function myparcelTrack(shipmentIds) {
  const ids = (Array.isArray(shipmentIds) ? shipmentIds : String(shipmentIds).split(/[;,\s]+/))
    .map((x) => parseInt(x, 10)).filter((x) => x > 0).slice(0, 10);
  if (!ids.length) return [];
  const r = await fetch(`https://api.myparcel.nl/tracktraces/${ids.join(";")}?extra_info=delivery_moment`, { headers: mpHeaders() });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.data.tracktraces || []).map((t) => ({
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

// ---------- Entity extraction (part numbers, order numbers) ----------
function extractEntities(text) {
  const partNumbers = [...new Set((text.match(/\b(?:[A-Z]{2,3}\d{6}[A-Z]?|\d{2}[A-Z]\d{4,5}[A-Z]?)\b/g) || []))];
  const orderNumbers = [...new Set((text.match(/#?S\d{5}\b/gi) || []).map((o) => o.replace("#", "").toUpperCase()))];
  return { partNumbers, orderNumbers };
}

module.exports = {
  htmlToText, graphToken, getMessages, resolveFolderId, searchMailbox, getMessageHtml, listAttachments, getAttachment,
  getPool, closePool, sapCustomerContext, sapStockPrice,
  shopifyCustomerContext, shopifyOrderByName,
  myparcelSearch, myparcelTrack, extractEntities, shopifyGraphql,
  extractPhoneNumbers, findCustomerByPhone,
};



