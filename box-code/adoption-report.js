// adoption-report.js: the Axle Adoption Dashboard.
//
// Reads the Axle SQLite DB directly (computeFromDb) and draws the numbers as an Axle page in the
// shared vocabulary, in plain HTML and CSS (renderHtml; no chart library, no external requests).
// The server shows it to owners at /adoption; run from the command line it writes a single HTML
// file that opens on its own (the stylesheets inline, no scripts).
//
// Usage:
//   node adoption-report.js [outputPath]
//   AXLE_DB=C:\Axle\data\axle.db node adoption-report.js C:\Axle\data\adoption-dashboard.html
//
// Defaults: DB  = process.env.AXLE_DB || ../data/axle.db (the live box DB)
//           out = AXLE_REPORT_OUT || ../data/adoption-dashboard.html
//
// Scheduled (2026-10-04, P4.10/P4.11): the "Axle Report" task runs run-report.ps1 daily as `axle`;
// the server serves the file to admins at /adoption. Sections added then: weekly acceptance trend
// (the before/after for prompt changes such as the 4 Oct style exemplars) and the most-edited
// drafts of the last 7 days, grouped by intent, each linking to its item.
const fs = require("fs");
const path = require("path");

const UI = require("./views/ui.js");
const BASE = require("./base-path.js");

const DB_PATH = process.env.AXLE_DB || path.join(__dirname, "..", "data", "axle.db");

function render(user) { return renderHtml(computeFromDb(), user); }

if (require.main === module) {
  const OUT = process.argv[2] || path.join(__dirname, "..", "data", "adoption-dashboard.html");
  // AXLE_DATA_JSON: render from pre-computed metrics (for building the file without a sqlite binding).
  const DATA = process.env.AXLE_DATA_JSON ? JSON.parse(fs.readFileSync(process.env.AXLE_DATA_JSON, "utf8")) : computeFromDb();
  fs.writeFileSync(OUT, standalone(renderHtml(DATA, { lang: "en" })));
  console.log(`Wrote ${OUT}  (items=${DATA.meta.totalItems}, sends=${DATA.meta.totalSends}, window ${(DATA.meta.windowStart||'').slice(0,10)}..${(DATA.meta.windowEnd||'').slice(0,10)})`);
}
module.exports = { render, computeFromDb, renderHtml };

function computeFromDb() {
const Database = require("better-sqlite3");
const db = new Database(DB_PATH, { readonly: true });

// --- helpers --------------------------------------------------------------
const norm = (t) => (t || "").replace(/\s+/g, " ").trim().toLowerCase();

// Normalised Levenshtein ratio (1 = identical). Used to grade how close the sent
// email is to Axle's AI draft. Strings here are short emails, so O(n*m) is fine.
function simRatio(a, b) {
  a = norm(a); b = norm(b);
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  if (a === b) return 1;
  const m = a.length, n = b.length;
  let prev = new Array(n + 1), cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  const dist = prev[n];
  return 1 - dist / Math.max(m, n);
}
const bucketOf = (r) =>
  r == null ? "no_draft" : r >= 0.97 ? "verbatim" : r >= 0.80 ? "light" : r >= 0.45 ? "moderate" : "heavy";

const shortName = (u) => (u || "").split("@")[0];
// Friendly labels: the drachten@ login is the shared Rob/Huub account.
const LABELS = { jack: "Jack (info@)", drachten: "Rob/Huub (drachten@)", admin: "Brad (admin)", brendan: "Brendan (info@)", tom: "Tom" };
const label = (u) => LABELS[shortName(u)] || shortName(u);

// --- pull rows ------------------------------------------------------------
const items = db.prepare("SELECT id, mailbox, intent, status, resolution, language, confidence, created_at FROM work_items").all();
const sends = db.prepare("SELECT id, work_item_id, sent_by, source_draft_id, body, sent_at FROM sends WHERE status='sent'").all();
const draftsById = {};
for (const d of db.prepare("SELECT id, body, source FROM drafts").all()) draftsById[d.id] = d;
const views = db.prepare("SELECT DISTINCT work_item_id, user FROM audit_log WHERE action='view_item' AND user NOT IN ('system')").all();

const meta = {
  dbPath: DB_PATH,
  generatedAt: new Date().toISOString(),
  windowStart: db.prepare("SELECT MIN(created_at) m FROM work_items").get().m,
  windowEnd: db.prepare("SELECT MAX(created_at) m FROM work_items").get().m,
  totalItems: items.length,
  totalSends: sends.length,
};

// --- per-send similarity --------------------------------------------------
const itemById = {}; for (const it of items) itemById[it.id] = it;
const sendRows = sends.map((s) => {
  const ai = s.source_draft_id ? draftsById[s.source_draft_id] : null;
  const r = ai && ai.body && s.body ? simRatio(ai.body, s.body) : null;
  return { ...s, sim: r, bucket: bucketOf(r), intent: (itemById[s.work_item_id] || {}).intent };
});

// --- per-user adoption ----------------------------------------------------
const USERS = ["jack", "drachten", "admin"];
const viewedByUser = {};
for (const v of views) { const u = shortName(v.user); (viewedByUser[u] = viewedByUser[u] || new Set()).add(v.work_item_id); }

const perUser = USERS.map((u) => {
  const us = sendRows.filter((s) => shortName(s.sent_by) === u);
  const graded = us.filter((s) => s.sim != null);
  const med = graded.length ? graded.map((s) => s.sim).sort((a, b) => a - b)[Math.floor(graded.length / 2)] : null;
  const bc = { verbatim: 0, light: 0, moderate: 0, heavy: 0, no_draft: 0 };
  us.forEach((s) => bc[s.bucket]++);
  const lastSend = us.length ? us.map((s) => s.sent_at).sort().slice(-1)[0] : null;
  return {
    user: u, label: label(u + "@x"),
    sends: us.length,
    verbatim: bc.verbatim, light: bc.light, moderate: bc.moderate, heavy: bc.heavy,
    verbatimPct: us.length ? Math.round((100 * bc.verbatim) / us.length) : 0,
    medianSim: med,
    lastSend,
  };
});

// --- per-mailbox funnel & resolution -------------------------------------
const MB = ["info", "drachten"];
const mailbox = MB.map((mb) => {
  const mi = items.filter((i) => i.mailbox === mb);
  const ids = new Set(mi.map((i) => i.id));
  const sentIds = new Set(sendRows.filter((s) => ids.has(s.work_item_id)).map((s) => s.work_item_id));
  const viewedIds = new Set(views.filter((v) => ids.has(v.work_item_id) && shortName(v.user) !== "admin").map((v) => v.work_item_id));
  const res = {};
  mi.forEach((i) => { const k = i.resolution || "open"; res[k] = (res[k] || 0) + 1; });
  return {
    mailbox: mb, label: mb === "info" ? "info@ (Gouda · Jack/Brendan)" : "drachten@ (Rob/Huub)",
    items: mi.length,
    viewed: viewedIds.size, viewedPct: mi.length ? Math.round((100 * viewedIds.size) / mi.length) : 0,
    sent: sentIds.size, sentPct: mi.length ? Math.round((100 * sentIds.size) / mi.length) : 0,
    resolution: res,
  };
});

// --- daily trend (items created vs Axle sends, per mailbox) ---------------
const day = (ts) => (ts || "").slice(0, 10);
const dset = new Set();
const created = {}, sent = {};
items.forEach((i) => { const d = day(i.created_at); dset.add(d); created[i.mailbox + "|" + d] = (created[i.mailbox + "|" + d] || 0) + 1; });
sendRows.forEach((s) => { const it = itemById[s.work_item_id]; if (!it) return; const d = day(s.sent_at); dset.add(d); sent[it.mailbox + "|" + d] = (sent[it.mailbox + "|" + d] || 0) + 1; });
const days = [...dset].sort();
const trend = {
  days,
  infoNew: days.map((d) => created["info|" + d] || 0),
  infoSent: days.map((d) => sent["info|" + d] || 0),
  drachNew: days.map((d) => created["drachten|" + d] || 0),
  drachSent: days.map((d) => sent["drachten|" + d] || 0),
};

// --- edit rate by intent --------------------------------------------------
const byIntent = {};
sendRows.forEach((s) => {
  const k = s.intent || "unknown";
  const o = byIntent[k] || (byIntent[k] = { intent: k, n: 0, verbatim: 0, modHeavy: 0 });
  o.n++; if (s.bucket === "verbatim") o.verbatim++; if (s.bucket === "moderate" || s.bucket === "heavy") o.modHeavy++;
});
const intents = Object.values(byIntent).filter((o) => o.n >= 3).sort((a, b) => b.n - a.n)
  .map((o) => ({ ...o, modHeavyPct: Math.round((100 * o.modHeavy) / o.n), verbatimPct: Math.round((100 * o.verbatim) / o.n) }));

// --- confidence calibration ----------------------------------------------
const conf = {};
sendRows.forEach((s) => {
  const c = (itemById[s.work_item_id] || {}).confidence || "none";
  const o = conf[c] || (conf[c] = { confidence: c, n: 0, verbatim: 0 });
  o.n++; if (s.bucket === "verbatim") o.verbatim++;
});
const confidence = ["high", "medium", "low", "none"].filter((k) => conf[k]).map((k) => ({ ...conf[k], pct: Math.round((100 * conf[k].verbatim) / conf[k].n) }));

// --- weekly acceptance trend ---------------------------------------------
// ISO week buckets of graded sends: the before/after view for any drafting change.
const isoWeek = (ts) => {
  const d = new Date(ts); d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const y = d.getUTCFullYear(), wk = Math.ceil(((d - Date.UTC(y, 0, 1)) / 864e5 + 1) / 7);
  return `${y}-W${String(wk).padStart(2, "0")}`;
};
const wk = {};
sendRows.filter((s) => s.sim != null).forEach((s) => {
  const k = isoWeek(s.sent_at);
  const o = wk[k] || (wk[k] = { week: k, n: 0, verbatim: 0, modHeavy: 0 });
  o.n++; if (s.bucket === "verbatim") o.verbatim++; if (s.bucket === "moderate" || s.bucket === "heavy") o.modHeavy++;
});
const weekly = Object.values(wk).sort((a, b) => (a.week < b.week ? -1 : 1))
  .map((o) => ({ ...o, verbatimPct: Math.round((100 * o.verbatim) / o.n), modHeavyPct: Math.round((100 * o.modHeavy) / o.n) }));

// --- most-edited drafts, last 7 days (P4.11 digest) ----------------------
const since = new Date(Date.now() - 7 * 864e5).toISOString();
const digest = sendRows
  .filter((s) => s.sim != null && s.sim < 0.80 && s.sent_at >= since)
  .map((s) => ({ item: s.work_item_id, intent: s.intent || "unknown", user: label(s.sent_by), sent_at: s.sent_at,
                 sim: Math.round(s.sim * 100), bucket: s.bucket,
                 aiLen: (draftsById[s.source_draft_id].body || "").length, sentLen: (s.body || "").length }))
  .sort((a, b) => a.intent.localeCompare(b.intent) || a.sim - b.sim);

  db.close();
  return { meta, perUser, mailbox, trend, intents, confidence, weekly, digest };
}

// --- render ---------------------------------------------------------------
// D: computeFromDb()'s numbers, drawn as they are (the shares the old charts showed are worked out
// here the same way). user: the reader (language, framed or not).
function renderHtml(D, user) {
  const { esc, pill, intentLabel, parseTS, TZ } = UI;
  const lang = UI.langOK(user.lang);
  const t = (k) => UI.t(lang, k);
  const L = (k) => esc(t(k));
  const loc = lang === "nl" ? "nl-NL" : "en-GB";
  const date = (s, year) => s ? parseTS(s).toLocaleDateString(loc, { timeZone: TZ, day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) }).replace(".", "") : "";
  const pc = (n) => `${n} %`;
  const meter = (p) => `<span class="ax-meter"><span><i style="width:${p}%"></i></span><b>${pc(p)}</b></span>`;
  const card = (title, body, hint) => `<section class="wb-card"><div class="wb-card__hd"><h2 class="wb-card__t">${title}</h2>${hint ? `<span class="wb-hint">${hint}</span>` : ""}</div>${body}</section>`;
  const table = (head, rows) => `<div class="ax-scroll"><table class="wb-table"><thead><tr>${head.join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
  const th = (k, num) => `<th${num ? ' class="wb-num"' : ""}>${L(k)}</th>`;
  const num = (v) => `<td class="wb-num">${v}</td>`;

  // The four tiles
  const info = D.mailbox.find((m) => m.mailbox === "info") || {}, drach = D.mailbox.find((m) => m.mailbox === "drachten") || {};
  const allGraded = D.perUser.reduce((a, u) => a + u.verbatim + u.light + u.moderate + u.heavy, 0);
  const allVerb = D.perUser.reduce((a, u) => a + u.verbatim, 0);
  const stats = [
    [t("ad_sends"), D.meta.totalSends],
    [t("ad_unchanged"), pc(allGraded ? Math.round(100 * allVerb / allGraded) : 0)],
    [t("ad_box_replied").replace("{box}", "info@"), pc(info.sentPct)],
    [t("ad_box_replied").replace("{box}", "drachten@"), pc(drach.sentPct)],
  ];

  // Adoption by user: sends, unchanged share, the edit mix as one thin bar, median match, last send
  const BUCKETS = [["verbatim", "ax-fill-ok"], ["light", "ax-fill-info"], ["moderate", "ax-fill-warn"], ["heavy", "ax-fill-bad"]];
  const mix = (u) => {
    const n = u.verbatim + u.light + u.moderate + u.heavy || 1;
    return `<span class="ax-stack ax-stack--thin">${BUCKETS.filter(([k]) => u[k]).map(([k, c]) => `<i class="${c}" style="width:${100 * u[k] / n}%" title="${L("ad_b_" + k)}: ${u[k]}"></i>`).join("")}</span>`;
  };
  const last = (s) => {
    if (!s) return pill(t("ad_never"), "bad");
    const a = Math.round((Date.now() - parseTS(s)) / 864e5);
    return `${esc(date(s))} ${a >= 3 ? pill(t("ad_days").replace("{n}", a), "bad") : a >= 1 ? pill(a === 1 ? t("ad_day_1") : t("ad_days").replace("{n}", a), "warn") : pill(t("ad_today"), "ok")}`;
  };
  const users = card(L("ad_by_user"), table(
    [th("col_user"), th("ad_col_sends", 1), th("ad_b_verbatim", 1), th("ad_col_accept"), th("ad_col_median", 1), th("ad_col_last")],
    D.perUser.filter((u) => u.sends > 0 || u.user !== "admin").map((u) => `<tr><td>${esc(u.label)}</td>${num(u.sends)}${num(pc(u.verbatimPct))}<td class="ax-mixcell">${mix(u)}</td>${num(u.medianSim != null ? pc(Math.round(u.medianSim * 100)) : "")}<td class="ax-nowrap">${last(u.lastSend)}</td></tr>`))
    + `<div class="ax-legend ax-legend--row">${BUCKETS.map(([k, c]) => `<div><i class="${c}"></i>${L("ad_b_" + k)}</div>`).join("")}</div>`);

  // Daily activity per mailbox: emails in beside sends through Axle, one thin pair of bars a day
  const daily = (mb, ins, sent) => {
    const max = Math.max(1, ...ins, ...sent);
    const days = D.trend.days.map((d, i) => `<span title="${esc(date(d))}: ${ins[i]} ${L("ad_in").toLowerCase()}, ${sent[i]} ${L("ad_sent").toLowerCase()}"><i style="height:${100 * ins[i] / max}%"></i><i class="ax-fill-info" style="height:${100 * sent[i] / max}%"></i></span>`).join("");
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    return card(esc(mb.label || mb.mailbox), `<div class="wb-card__bd"><div class="ax-days">${days}</div>
      <div class="ax-daysax"><span>${esc(date(D.trend.days[0]))}</span><span>${esc(date(D.trend.days[D.trend.days.length - 1]))}</span></div>
      <div class="ax-legend ax-legend--row"><div><i class="ax-fill-in"></i>${L("ad_in")}<b>${sum(ins)}</b></div><div><i class="ax-fill-info"></i>${L("ad_sent")}<b>${sum(sent)}</b></div></div></div>`);
  };

  // Where replies are resolved: one stacked bar a mailbox, a legend with count and share
  const resolved = (mb) => {
    const r = mb.resolution || {}, keys = Object.keys(r), n = keys.reduce((a, k) => a + r[k], 0) || 1;
    const label = (k) => (UI.STRINGS.en["ad_r_" + k] ? L("ad_r_" + k) : esc(k));
    return card(esc(mb.label), `<div class="wb-card__bd"><div class="ax-stack">${keys.map((k, i) => `<i class="ax-c${i + 1}" style="width:${100 * r[k] / n}%"></i>`).join("")}</div>
      <div class="ax-legend">${keys.map((k, i) => `<div><i class="ax-c${i + 1}"></i>${label(k)}<b>${r[k]} · ${pc(Math.round(100 * r[k] / n))}</b></div>`).join("")}</div></div>`);
  };

  // Draft acceptance by week, by topic, by confidence: rows with the shares as meters
  const weekly = card(L("ad_weekly"), table([th("ad_col_week"), th("ad_col_sends", 1), th("ad_b_verbatim"), th("ad_col_heavy")],
    D.weekly.map((w) => `<tr><td class="ax-nowrap">${esc(w.week)}</td>${num(w.n)}<td>${meter(w.verbatimPct)}</td><td>${meter(w.modHeavyPct)}</td></tr>`)), L("ad_weekly_hint"));
  const topics = card(L("ad_topics"), table([th("ad_col_topic"), th("ad_col_sends", 1), th("ad_b_verbatim"), th("ad_col_heavy")],
    D.intents.map((i) => `<tr><td>${esc(intentLabel(lang, i.intent))}</td>${num(i.n)}<td>${meter(i.verbatimPct)}</td><td>${meter(i.modHeavyPct)}</td></tr>`)));
  const conf = card(L("ad_conf"), table([th("ad_col_conf"), th("ad_col_sends", 1), th("ad_b_verbatim")],
    D.confidence.map((c) => `<tr><td>${L("ad_c_" + c.confidence)}</td>${num(c.n)}<td>${meter(c.pct)}</td></tr>`)), L("ad_conf_hint"));

  // Most-edited drafts, last 7 days
  const tone = { light: "ok", moderate: "warn", heavy: "bad" };
  const digest = card(L("ad_digest"), D.digest.length ? table(
    [th("ad_col_topic"), th("col_email"), th("ad_col_by"), th("col_when_b"), th("ad_col_match", 1), th("ad_col_edit"), th("ad_col_chars", 1)],
    D.digest.map((d) => `<tr><td>${esc(intentLabel(lang, d.intent))}</td><td><a class="wb-link" href="${BASE.path}/item/${d.item}">#${d.item}</a></td><td>${esc(d.user)}</td><td class="ax-nowrap">${esc(date(d.sent_at))}</td>${num(pc(d.sim))}<td>${pill(t("ad_b_" + d.bucket), tone[d.bucket])}</td>${num(`${d.aiLen} → ${d.sentLen}`)}</tr>`))
    : `<div class="wb-empty">${L("ad_digest_none")}</div>`, L("ad_digest_hint"));

  const start = D.meta.windowStart, end = D.meta.windowEnd;
  const year = (s) => UI.ymdTZ(parseTS(s)).slice(0, 4);
  const span = t("ad_window").replace("{from}", date(start, year(start) !== year(end))).replace("{to}", date(end, true));
  return UI.deskPage(t("adoption"), user, `<p class="ax-sub">${esc(span)} · ${esc(t("updated").replace("{t}", UI.fmtDateTime(D.meta.generatedAt, lang)))}</p>
<div class="ax-stats">${stats.map(([l, v]) => `<div class="wb-card ax-stat"><span class="wb-label">${esc(l)}</span><b>${esc(v)}</b></div>`).join("")}</div>
${users}
<h2 class="ax-h2">${L("ad_daily")}</h2>
<div class="ax-grid2">${daily(info, D.trend.infoNew, D.trend.infoSent)}${daily(drach, D.trend.drachNew, D.trend.drachSent)}</div>
<h2 class="ax-h2">${L("ad_resolved")}</h2>
<div class="ax-grid2">${resolved(info)}${resolved(drach)}</div>
${weekly}
${digest}
<div class="ax-grid2">${topics}${conf}</div>
<p class="wb-hint">${L("ad_thresholds")}</p>`);
}

// The command line's file opens on its own: the stylesheets inline, no scripts.
function standalone(html) {
  return html
    .replace(/<link rel="stylesheet" href="[^"]*\/assets\/([a-z]+\.css)\?v=[^"]*">/g, (m, f) => `<style>${fs.readFileSync(path.join(__dirname, "assets", f), "utf8")}</style>`)
    .replace(/<script src="[^"]*"[^>]*><\/script>\n?/g, "");
}
