// adoption-report.js — generates the Axle Adoption Dashboard (self-contained HTML).
//
// Reads the Axle SQLite DB directly and writes a single static HTML file with all
// metrics embedded as JSON and rendered client-side with Chart.js (CDN). No server,
// no connectors — just open the file. Designed to run on the box against the LIVE DB
// so the dashboard refreshes itself on a daily schedule.
//
// Usage:
//   node adoption-report.js [outputPath]
//   AXLE_DB=C:\Axle\data\axle.db node adoption-report.js C:\Admin\Projects\Axle\adoption-dashboard.html
//
// Defaults: DB  = process.env.AXLE_DB || ../data/axle.db (the live box DB)
//           out = ./adoption-dashboard.html
const fs = require("fs");
const path = require("path");

const DB_PATH = process.env.AXLE_DB || path.join(__dirname, "..", "data", "axle.db");
const OUT = process.argv[2] || path.join(__dirname, "adoption-dashboard.html");

// Two ways to get DATA:
//  - Normal (on the box): read the live SQLite DB directly via better-sqlite3.
//  - AXLE_DATA_JSON set: render from a pre-computed metrics JSON (used to build the
//    dashboard from an environment without a native sqlite binding). Same template either way.
let DATA;
if (process.env.AXLE_DATA_JSON) {
  DATA = JSON.parse(fs.readFileSync(process.env.AXLE_DATA_JSON, "utf8"));
} else {
  DATA = computeFromDb();
}
fs.writeFileSync(OUT, renderHtml(DATA));
console.log(`Wrote ${OUT}  (items=${DATA.meta.totalItems}, sends=${DATA.meta.totalSends}, window ${(DATA.meta.windowStart||'').slice(0,10)}..${(DATA.meta.windowEnd||'').slice(0,10)})`);

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

  db.close();
  return { meta, perUser, mailbox, trend, intents, confidence };
}

// --- render ---------------------------------------------------------------
function renderHtml(D) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Axle — Adoption Dashboard</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
  :root{--bg:#0f1419;--card:#1a212b;--line:#2a3441;--ink:#e7edf3;--mut:#8b97a6;--accent:#4f9cf9;--good:#3ecf8e;--warn:#f5a623;--bad:#f56565;--purple:#a78bfa;}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  .wrap{max-width:1180px;margin:0 auto;padding:28px 22px 60px}
  h1{font-size:22px;margin:0 0 2px} h2{font-size:15px;margin:30px 0 12px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em;font-weight:600}
  .sub{color:var(--mut);font-size:13px;margin-bottom:6px}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
  .kpi{font-size:28px;font-weight:700;line-height:1.1} .kpi small{font-size:14px;color:var(--mut);font-weight:500}
  .lbl{color:var(--mut);font-size:12px;margin-top:4px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:18px} @media(max-width:840px){.grid2{grid-template-columns:1fr}}
  .panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
  table{width:100%;border-collapse:collapse;font-size:13px} th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)} th{color:var(--mut);font-weight:600}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
  .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;font-weight:600}
  .pill.good{background:rgba(62,207,142,.15);color:var(--good)} .pill.warn{background:rgba(245,166,35,.15);color:var(--warn)} .pill.bad{background:rgba(245,101,101,.15);color:var(--bad)}
  .bar{height:9px;border-radius:6px;background:var(--line);overflow:hidden;display:flex}
  .bar i{display:block;height:100%}
  canvas{max-height:300px}
  .foot{color:var(--mut);font-size:12px;margin-top:34px;border-top:1px solid var(--line);padding-top:14px}
  .legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--mut);margin:6px 0 10px}
  .dot{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:5px;vertical-align:middle}
</style></head><body><div class="wrap">
<h1>Axle — Adoption Dashboard</h1>
<div class="sub" id="meta"></div>
<div class="cards" id="kpis"></div>

<h2>Adoption by user</h2>
<div class="panel"><table id="userTable"><thead><tr>
  <th>User</th><th class="num">Axle sends</th><th class="num">Verbatim</th><th>Draft acceptance</th><th class="num">Median match</th><th>Last Axle send</th>
</tr></thead><tbody></tbody></table>
<div class="legend" style="margin-top:12px">
  <span><i class="dot" style="background:var(--good)"></i>Sent verbatim</span>
  <span><i class="dot" style="background:var(--accent)"></i>Light edit</span>
  <span><i class="dot" style="background:var(--warn)"></i>Moderate edit</span>
  <span><i class="dot" style="background:var(--bad)"></i>Heavy rewrite</span>
</div></div>

<h2>Daily activity — items in vs. replies sent through Axle</h2>
<div class="grid2">
  <div class="panel"><div class="sub">info@ (Jack)</div><canvas id="infoChart"></canvas></div>
  <div class="panel"><div class="sub">drachten@ (Rob/Huub)</div><canvas id="drachChart"></canvas></div>
</div>

<h2>Where replies are resolved</h2>
<div class="grid2"><div class="panel"><canvas id="resInfo"></canvas></div><div class="panel"><canvas id="resDrach"></canvas></div></div>

<div class="grid2">
  <div><h2>Draft edited most by topic</h2><div class="panel"><canvas id="intentChart"></canvas></div></div>
  <div><h2>Is Axle's confidence trustworthy?</h2><div class="panel"><canvas id="confChart"></canvas>
    <div class="sub" style="margin-top:10px">% of sends left verbatim, by Axle's self-rated draft confidence. Bars near-equal = the badge carries little signal.</div></div></div>
</div>

<div class="foot" id="foot"></div>
</div>
<script>
const D = ${JSON.stringify(D)};
const C = {ink:'#e7edf3',mut:'#8b97a6',line:'#2a3441',accent:'#4f9cf9',good:'#3ecf8e',warn:'#f5a623',bad:'#f56565',purple:'#a78bfa'};
Chart.defaults.color = C.mut; Chart.defaults.borderColor = C.line; Chart.defaults.font.family='-apple-system,Segoe UI,Roboto,sans-serif';
const fmtDate = s => s ? new Date(s).toLocaleDateString('en-GB',{day:'2-digit',month:'short'}) : '—';
const daysAgo = s => s ? Math.round((Date.now()-new Date(s))/864e5) : null;

// meta + KPIs
document.getElementById('meta').textContent =
  'Window ' + fmtDate(D.meta.windowStart) + ' – ' + fmtDate(D.meta.windowEnd) +
  ' · generated ' + new Date(D.meta.generatedAt).toLocaleString('en-GB') + ' · ' + D.meta.dbPath;
const info = D.mailbox.find(m=>m.mailbox==='info')||{}, drach = D.mailbox.find(m=>m.mailbox==='drachten')||{};
const allGraded = D.perUser.reduce((a,u)=>a+u.verbatim+u.light+u.moderate+u.heavy,0);
const allVerb = D.perUser.reduce((a,u)=>a+u.verbatim,0);
const kpis = [
  {k:D.meta.totalSends, s:'', l:'Replies sent via Axle'},
  {k:allGraded?Math.round(100*allVerb/allGraded):0, s:'%', l:'Sent verbatim (no edit)'},
  {k:info.sentPct, s:'%', l:'info@ items replied via Axle'},
  {k:drach.sentPct, s:'%', l:'drachten@ items replied via Axle'},
];
document.getElementById('kpis').innerHTML = kpis.map(x=>
  '<div class="card"><div class="kpi">'+x.k+'<small>'+x.s+'</small></div><div class="lbl">'+x.l+'</div></div>').join('');

// user table
const acc = u => { const t=u.verbatim+u.light+u.moderate+u.heavy||1; const seg=(n,c)=>n?'<i style="width:'+(100*n/t)+'%;background:'+c+'"></i>':'';
  return '<div class="bar">'+seg(u.verbatim,C.good)+seg(u.light,C.accent)+seg(u.moderate,C.warn)+seg(u.heavy,C.bad)+'</div>'; };
const staleness = d => { const a=daysAgo(d); if(a==null) return '<span class="pill bad">never</span>';
  return fmtDate(d)+' '+(a>=3?'<span class="pill bad">'+a+'d ago</span>':a>=1?'<span class="pill warn">'+a+'d ago</span>':'<span class="pill good">today</span>'); };
document.querySelector('#userTable tbody').innerHTML = D.perUser.filter(u=>u.sends>0||u.user!=='admin').map(u=>
  '<tr><td>'+u.label+'</td><td class="num">'+u.sends+'</td><td class="num">'+u.verbatimPct+'%</td><td style="min-width:170px">'+acc(u)+'</td>'+
  '<td class="num">'+(u.medianSim!=null?Math.round(u.medianSim*100)+'%':'—')+'</td><td>'+staleness(u.lastSend)+'</td></tr>').join('');

// daily charts
function trendChart(id, newArr, sentArr, color){
  new Chart(document.getElementById(id),{type:'bar',
    data:{labels:D.trend.days.map(d=>d.slice(5)),datasets:[
      {label:'Items in',data:newArr,backgroundColor:C.line,borderRadius:3},
      {label:'Sent via Axle',data:sentArr,backgroundColor:color,borderRadius:3}]},
    options:{plugins:{legend:{position:'bottom'}},scales:{x:{grid:{display:false}},y:{beginAtZero:true,ticks:{precision:0}}}}});
}
trendChart('infoChart', D.trend.infoNew, D.trend.infoSent, C.good);
trendChart('drachChart', D.trend.drachNew, D.trend.drachSent, C.warn);

// resolution doughnuts
const RES_COLORS = {replied:C.good, done:C.accent, phone:C.purple, no_action:C.mut, open:C.warn};
function resChart(id, mb){
  const r = mb.resolution||{}; const keys=Object.keys(r);
  new Chart(document.getElementById(id),{type:'doughnut',
    data:{labels:keys.map(k=>({replied:'Replied via Axle',done:'Closed (sent elsewhere)',phone:'Phone',no_action:'No reply needed',open:'Still open'}[k]||k)),
      datasets:[{data:keys.map(k=>r[k]),backgroundColor:keys.map(k=>RES_COLORS[k]||C.mut),borderWidth:0}]},
    options:{cutout:'58%',plugins:{legend:{position:'right',labels:{boxWidth:12}},title:{display:true,text:mb.label,color:C.ink}}}});
}
resChart('resInfo', info); resChart('resDrach', drach);

// intent edit rate
new Chart(document.getElementById('intentChart'),{type:'bar',
  data:{labels:D.intents.map(i=>i.intent),datasets:[
    {label:'Verbatim %',data:D.intents.map(i=>i.verbatimPct),backgroundColor:C.good,borderRadius:3},
    {label:'Moderate+heavy edit %',data:D.intents.map(i=>i.modHeavyPct),backgroundColor:C.bad,borderRadius:3}]},
  options:{indexAxis:'y',plugins:{legend:{position:'bottom'}},scales:{x:{beginAtZero:true,max:100}}}});

// confidence calibration
new Chart(document.getElementById('confChart'),{type:'bar',
  data:{labels:D.confidence.map(c=>c.confidence+' (n='+c.n+')'),datasets:[
    {label:'Sent verbatim %',data:D.confidence.map(c=>c.pct),backgroundColor:D.confidence.map(c=>c.confidence==='high'?C.good:c.confidence==='medium'?C.warn:C.bad),borderRadius:3}]},
  options:{plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,max:100,title:{display:true,text:'% verbatim'}}}}});

document.getElementById('foot').innerHTML =
  'Verbatim = sent text ≥97% identical to Axle\\'s AI draft · Light ≥80% · Moderate ≥45% · Heavy &lt;45%. '+
  'Drachten figures cover the shared Rob/Huub login. Regenerate by running <code>node adoption-report.js</code> on the box against the live DB.';
</script></body></html>`;
}
