"use strict";
// voicemail-sheet.js: the call back sheet on a voicemail item (Change A2, design D54, 12 Oct 2026).
// Pure helpers, no SAP and no database: routes/item.js and routes/inbox.js read the rows and SAP,
// these decide what the sheet shows. A voicemail is the same test as Change A (send-guard.js).
//
//   P1  how often this number left a voicemail in the 14 days before this one, timed by KPN's own
//       clock (the "Time:" line, else the .wav name, else the email's received time), never by
//       when the Email app ingested it: ingest can run minutes to hours late (finding of 9 Oct 2026).
//   P2  open issues (returns, complaints, warranty) for the caller's customer card.
//   P3  the supplier panel: email domains, purchase order lines, open warranty items.

const C = require("./connectors.js");

const DAY = 24 * 3600 * 1000;
const WINDOW_DAYS = 14;
const ISSUE_CLOSED_DAYS = 30;
const ISSUE_LIMIT = 6;
const PO_LIMIT = 5;
const TZ = "Europe/Amsterdam";

// SQL for the voicemail rows P1 needs (the same test as SG.isVoicemailItem), both mailboxes.
const VOICEMAIL_ROWS_SQL =
  `SELECT id, subject, email_text, email_received, attachments_json FROM work_items
   WHERE rule_id = 'voicemail' OR LOWER(TRIM(COALESCE(sender_email, ''))) = 'voicemail@hipservice.nl'`;

// --- time -------------------------------------------------------------------------------------
const MONTHS = { jan: 1, feb: 2, mrt: 3, mar: 3, apr: 4, mei: 5, may: 5, jun: 6, jul: 7, aug: 8,
  sep: 9, sept: 9, okt: 10, oct: 10, nov: 11, dec: 12 };

// The Amsterdam wall clock of an instant, as numbers.
const partsFmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hourCycle: "h23",
  year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
function amsParts(d) {
  const p = {};
  for (const x of partsFmt.formatToParts(d)) if (x.type !== "literal") p[x.type] = Number(x.value);
  return p;
}

// An Amsterdam wall-clock time (what KPN prints) as a Date. Two passes settle the summer/winter offset.
function fromAmsterdam(y, mo, d, h, mi, s) {
  const want = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const p = amsParts(new Date(t));
    t += want - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  const out = new Date(t);
  return isNaN(out) ? null : out;
}

// KPN's body line: "Time: 9 okt. 2026 10:03:13" (Dutch month abbreviations, the dot optional).
function kpnBodyTime(text) {
  const m = String(text || "").match(/Time:\s*(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  if (!mo) return null;
  return fromAmsterdam(+m[3], mo, +m[1], +m[4], +m[5], +(m[6] || 0));
}

// The audio file's name: "<number>_YYYYMMDD_HHMMSS.wav".
function attachmentTime(attachmentsJson) {
  let list = [];
  try { list = JSON.parse(attachmentsJson || "[]") || []; } catch (e) { list = []; }
  for (const a of Array.isArray(list) ? list : []) {
    const m = String((a && a.name) || "").match(/_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.wav$/i);
    if (m) return fromAmsterdam(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
  }
  return null;
}

// A stored timestamp: SQLite's naive UTC ("YYYY-MM-DD HH:MM:SS") or Graph's ISO with a zone.
function parseStamp(s) {
  const v = String(s || "");
  if (!v) return null;
  const d = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(v) ? v.replace(" ", "T") + "Z" : v);
  return isNaN(d) ? null : d;
}

// When the caller left the voicemail. Never created_at (the ingest time).
function voicemailTime(w) {
  return kpnBodyTime(w.email_text) || attachmentTime(w.attachments_json) || parseStamp(w.email_received);
}

// --- P1: the count --------------------------------------------------------------------------
// The caller's number the Change A way (subject first). Hidden numbers give null and never count.
function callerNumber(w) {
  const shown = C.extractCallerNumbers({ subject: w.subject || "", text: w.email_text || "" })[0];
  const norm = C.normalisePhone(shown);
  return shown && norm.length >= 9 ? { shown, norm } : null;
}

// The earlier voicemails from this number within the window, oldest first: [{ id, at }].
// "Earlier" is by KPN time; two at the very same second are ordered by item id.
function earlierVoicemails(w, rows, days = WINDOW_DAYS) {
  const me = callerNumber(w);
  const at = voicemailTime(w);
  if (!me || !at) return [];
  const from = at.getTime() - days * DAY;
  const out = [];
  for (const r of rows || []) {
    if (r.id === w.id) continue;
    const n = callerNumber(r);
    if (!n || !C.samePhone(me.norm, n.shown)) continue;
    const t = voicemailTime(r);
    if (!t) continue;
    const ms = t.getTime();
    if (ms < from || ms > at.getTime() || (ms === at.getTime() && r.id > w.id)) continue;
    out.push({ id: r.id, at: t });
  }
  return out.sort((a, b) => (a.at - b.at) || (a.id - b.id));
}

// For the inbox: Map id -> voicemails from that number in the window up to and including it.
function voicemailCounts(rows, days = WINDOW_DAYS) {
  const groups = new Map();
  for (const r of rows || []) {
    const n = callerNumber(r);
    const t = voicemailTime(r);
    if (!n || !t) continue;
    if (!groups.has(n.norm)) groups.set(n.norm, []);
    groups.get(n.norm).push({ id: r.id, ms: t.getTime() });
  }
  const out = new Map();
  for (const list of groups.values()) {
    for (const me of list) {
      const from = me.ms - days * DAY;
      out.set(me.id, list.filter((o) => o.ms >= from && (o.ms < me.ms || (o.ms === me.ms && o.id <= me.id))).length);
    }
  }
  return out;
}

// "3rd" / "3e".
function ordinal(n, lang) {
  if (lang === "nl") return `${n}e`;
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return n + ({ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
}

// "Tue 6 Oct 11:57" / "di 6 okt 11:57", Amsterdam time.
const DAYS = { en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], nl: ["zo", "ma", "di", "wo", "do", "vr", "za"] };
const MON = { en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  nl: ["jan", "feb", "mrt", "apr", "mei", "jun", "jul", "aug", "sep", "okt", "nov", "dec"] };
function shortWhen(d, lang) {
  const L = lang === "nl" ? "nl" : "en";
  const p = amsParts(d);
  const wd = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const two = (x) => String(x).padStart(2, "0");
  return `${DAYS[L][wd]} ${p.day} ${MON[L][p.month - 1]} ${two(p.hour)}:${two(p.minute)}`;
}

// --- P2: open issues for the caller's customer ------------------------------------------------
const isIssue = (r) => r.intent === "return_complaint" || r.rule_id === "warranty_warp";
const isClosed = (r) => r.status === "done" || r.status === "archived";
const normAddr = (s) => String(s || "").trim().toLowerCase();
function composeCard(r) {
  try { const c = JSON.parse(r.compose_customer || "null"); return (c && c.cardCode) || null; } catch (e) { return null; }
}

// rows: work_items candidates (any superset); card: the caller's CardCode; addrs: the customer's
// on-file addresses. Open first (newest first), then closed in the last 30 days (newest first).
// Returns { shown: rows (up to 6), more: how many were left out }.
function openIssues(rows, { card, addrs, now = new Date(), selfId = null, limit = ISSUE_LIMIT } = {}) {
  if (!card) return { shown: [], more: 0 };
  const mail = new Set([...(addrs || [])].map(normAddr).filter(Boolean));
  const since = now.getTime() - ISSUE_CLOSED_DAYS * DAY;
  const mine = (r) => [r.cust_card, r.caller_card, composeCard(r)].includes(card) || mail.has(normAddr(r.sender_email));
  const when = (r) => (parseStamp(r.email_received) || parseStamp(r.created_at) || new Date(0)).getTime();
  const closedAt = (r) => (parseStamp(r.updated_at) || new Date(0)).getTime();
  const picked = (rows || []).filter((r) => r.id !== selfId && isIssue(r) && mine(r)
    && (!isClosed(r) || closedAt(r) >= since));
  const open = picked.filter((r) => !isClosed(r)).sort((a, b) => when(b) - when(a));
  const closed = picked.filter(isClosed).sort((a, b) => closedAt(b) - closedAt(a));
  const all = open.concat(closed);
  return { shown: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

// --- P3: the supplier panel -------------------------------------------------------------------
// Free mail providers: a shared gmail.com says nothing about which company wrote.
const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "icloud.com", "me.com", "mac.com", "msn.com",
  "aol.com", "ziggo.nl", "kpnmail.nl", "kpnplanet.nl", "planet.nl", "home.nl", "hetnet.nl", "xs4all.nl",
  "casema.nl", "chello.nl", "upcmail.nl", "telfort.nl", "online.nl", "quicknet.nl", "zeelandnet.nl",
  "tele2.nl", "solcon.nl", "caiway.nl", "web.de", "t-online.de", "freenet.de", "orange.fr", "free.fr",
  "laposte.net", "sfr.fr", "skynet.be", "telenet.be", "proximus.be", "btinternet.com", "sky.com",
  "proton.me", "protonmail.com", "mail.com", "yandex.com", "zoho.com", "gmx.com", "gmx.net"]);
// Providers with a domain per country (hotmail.co.uk, outlook.de, yahoo.fr, live.nl, gmx.de ...).
const FREE_MAIL_BRANDS = new Set(["hotmail", "outlook", "live", "yahoo", "ymail", "gmx", "wanadoo", "windowslive"]);

function emailDomain(addr) {
  const m = normAddr(addr).match(/@([a-z0-9.-]+\.[a-z]{2,})$/);
  return m ? m[1] : "";
}
function isFreeMail(domain) {
  const d = String(domain || "").toLowerCase();
  return !d || FREE_MAIL.has(d) || FREE_MAIL_BRANDS.has(d.split(".")[0]);
}
// The supplier's company domains from its card email(s) and its contact persons' emails. Free mail
// and our own addresses (isInternal) never count.
function supplierDomains(cardEmail, contactEmails, isInternal = () => false) {
  const out = new Set();
  for (const raw of [cardEmail, ...(contactEmails || [])]) {
    for (const a of String(raw || "").split(/[;,\s]+/)) {
      const d = emailDomain(a);
      if (d && !isFreeMail(d) && !isInternal(normAddr(a))) out.add(d);
    }
  }
  return out;
}

// SAP's "today" for the overdue flag: the Amsterdam date, as "YYYY-MM-DD".
function amsDay(d) {
  const p = amsParts(d);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
const ymd = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v || "").slice(0, 10));

// One open purchase order as the panel shows it: the value in the order's own currency
// (DocTotalFC with DocCur when that is not EUR, else DocTotal), due date, overdue.
function poLine(po, now = new Date()) {
  const cur = String(po.DocCur || "").trim().toUpperCase();
  const foreign = !!cur && cur !== "EUR";
  const due = ymd(po.DocDueDate);
  return { docNum: po.DocNum, value: Number(foreign ? po.DocTotalFC : po.DocTotal) || 0,
    currency: foreign ? cur : "EUR", due, overdue: !!due && due < amsDay(now) };
}

// Open warranty items with this supplier in the Email app: open, rule warranty_warp or intent
// return_complaint, sender at one of the supplier's domains. Newest first.
function supplierIssues(rows, domains, { limit = ISSUE_LIMIT } = {}) {
  const ds = domains instanceof Set ? domains : new Set(domains || []);
  const when = (r) => (parseStamp(r.email_received) || parseStamp(r.created_at) || new Date(0)).getTime();
  const all = (rows || []).filter((r) => isIssue(r) && !isClosed(r) && ds.has(emailDomain(r.sender_email)))
    .sort((a, b) => when(b) - when(a));
  return { shown: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

// Change A's caller line for "supplier only" (connectors.formatCallerInfo, line 6).
const isSupplierOnlyLine = (info) => /, a supplier, not a customer$/.test(String(info || ""));

// --- the caller line with its number as a tel: link ----------------------------------------
// The line stays exactly as stored; only the first occurrence of the caller's number becomes a
// link. esc and telHref are the page's own (views/ui.js, phone-numbers.js).
function callerLineHtml(w, esc, telHref) {
  const info = String(w.caller_info || "");
  const n = callerNumber(w);
  const at = n ? info.indexOf(n.shown) : -1;
  const href = n ? telHref(n.shown) : "";
  if (at < 0 || !href) return esc(info);
  return esc(info.slice(0, at)) + `<a class="wb-link" href="tel:${esc(href)}">${esc(n.shown)}</a>` + esc(info.slice(at + n.shown.length));
}

module.exports = {
  VOICEMAIL_ROWS_SQL, WINDOW_DAYS, PO_LIMIT, ISSUE_LIMIT,
  kpnBodyTime, attachmentTime, voicemailTime, callerNumber, earlierVoicemails, voicemailCounts,
  ordinal, shortWhen, openIssues, emailDomain, isFreeMail, supplierDomains, poLine, supplierIssues,
  isSupplierOnlyLine, callerLineHtml,
};
