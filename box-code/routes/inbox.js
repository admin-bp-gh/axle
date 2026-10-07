// routes/inbox.js - the work queue (GET / inline, GET /queue fragment, GET /queue/stamp probe,
// POST /queue/summaries), the per-browser language cookie (/setlang), the manual Sync (/sync) and
// the compose drawer (composeUi, rendered once per full page; routes/item.js appends it to deep
// links through app.locals.composeUi). Extracted from server.js in UI rework Step 0.
// Redesign phase 1 (2026-10-07), Queue A: the open list only. Header: Mine | All, then search,
// compose and More (History, Mailbox, Sync now, Blocked senders, the owner pages). History is the
// done and archived emails with a server-side search (?show=history&q=). Every switch posts or
// fetches in place through assets/axle.js; the markup carries data attributes, no inline script.
// Query semantics, audit rows and the live probe are as before. ACTION_COMPOSE_SEND is passed in
// by server.js so the allow-list env check stays defined in exactly one place.
const INGEST = require("../ingest.js");
const TR = require("../translate.js");
const K = require("../knowledge.js");
const { db, audit, acquireSync, releaseSync, syncStatus } = require("../db.js");
const { esc, t, page, langOK, statusLabel, statusWithRes, intentLabel, ownerLabel,
        fmtDateTime, fmtTime, parseTS, shell, voidPane, icon, iconBtn, homeLink } = require("../views/ui.js");
const { anthropic, MAX_ATTACH_BYTES, MAX_ATTACH_TOTAL, defaultMailbox } = require("./shared.js");
const BASE = require("../base-path.js");          // AXLE_BASE_PATH URL prefix

module.exports = function mountInbox(app, { ACTION_COMPOSE_SEND }) {

// Language cookie: set the per-browser language and return to the prior page. The control lives
// on the Workbench home page now; the route stays for it and for old links.
app.get("/setlang", (req, res) => {
  const l = langOK(req.query.lang);
  res.setHeader("Set-Cookie", `axle_lang=${l}; Path=${BASE.path || "/"}; Max-Age=31536000; SameSite=Lax`);
  let back = BASE.url("/");
  try { if (req.headers.referer) { const u = new URL(req.headers.referer); back = u.pathname + u.search; } } catch (e) { /* ignore */ }
  if (!back.startsWith("/")) back = BASE.url("/");
  audit(req.user.tailscale_login, "set_language", null, l);
  res.redirect(back);
});

// Manual "Sync now": run the info@ + drachten@ ingest IN-PROCESS in the background. Same watermark
// path as the scheduled task -- it ingests every email new since the last sync. Holding the lock in
// the server process (with a guaranteed release in finally) means the button and "last synced"
// always update; a server restart mid-sync is healed by the startup reset above. Acquiring the same
// lock as the scheduled task ensures no overlap. axle.js posts it in place and refreshes the queue;
// the redirect is for a browser without script.
function startSync(login) {
  if (!acquireSync("manual:" + login)) return false; // already running (scheduled or manual)
  audit(login, "manual_sync", null, "started");
  setImmediate(async () => {
    try {
      await INGEST.runBoxes(["info", "drachten"]);
      audit(login, "manual_sync_done", null, null);
    } catch (e) {
      audit(login, "manual_sync_error", null, e.message.slice(0, 200));
    } finally {
      releaseSync();
    }
  });
  return true;
}
app.post("/sync", (req, res) => {
  startSync(req.user.tailscale_login);
  res.redirect(BASE.url("/?synced=1"));
});

// --- The work queue ---------------------------------------------------------------------------
// The queue's filter, resolved once from the request so the pane render and the cheap change probe
// (GET /queue/stamp) agree on exactly the same rows.
//  mailbox: sales see everything by default because their scope is already "mine"; admins land on
//    Gouda (info@) and switch in the More menu. An explicit ?mailbox= always wins.
//  show: "open" (the list) or "history" (done and archived). The old tab values done, archived and
//    all are History now, so their links keep working.
//  scope: "mine" (the user's owner label) or "all". Sales default to mine, admins to all. It applies
//    to the open list only. Browsing History follows the mailbox; a History search (q) ignores both
//    and searches every closed email, its rows naming their mailbox.
//  q: History's server-side search over sender name and address, subject, summary and "#id".
function queueFilter(req) {
  const mb = ["info", "drachten", "all"].includes(req.query.mailbox) ? req.query.mailbox
    : (req.user.role === "admin" ? "info" : "all");
  const show = ["history", "done", "archived", "all"].includes(req.query.show) ? "history" : "open";
  const scope = ["mine", "all"].includes(req.query.scope) ? req.query.scope
    : (req.user.role === "admin" ? "all" : "mine");
  const q = show === "history" ? String(req.query.q || "").trim().slice(0, 100) : "";
  const myOwner = req.user.owner_label || req.user.display_name;
  const conds = [show === "open" ? "w.status NOT IN ('done','archived')" : "w.status IN ('done','archived')"];
  const params = [];
  const mineOnly = scope === "mine" && show === "open";
  const oneBox = mb !== "all" && !q;
  if (oneBox) { conds.push("w.mailbox = ?"); params.push(mb); }
  if (mineOnly) { conds.push("w.owner = ?"); params.push(myOwner); }
  if (q) {
    const like = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    conds.push("(w.sender_name LIKE ? ESCAPE '\\' OR w.sender_email LIKE ? ESCAPE '\\' OR w.subject LIKE ? ESCAPE '\\' OR w.summary LIKE ? ESCAPE '\\' OR ('#' || w.id) LIKE ? ESCAPE '\\')");
    params.push(like, like, like, like, like);
  }
  // Counts under the current mailbox + scope (status and search excluded), for the change stamp.
  const cConds = [], cParams = [];
  if (oneBox) { cConds.push("w.mailbox = ?"); cParams.push(mb); }
  if (mineOnly) { cConds.push("w.owner = ?"); cParams.push(myOwner); }
  return { mb, show, scope, q, conds, params, cConds, cParams };
}
// The filter as the query string the client sends back (refresh, probe, Load more).
const filterQs = (f) => `mailbox=${f.mb}&scope=${f.scope}&show=${f.show}${f.q ? "&q=" + encodeURIComponent(f.q) : ""}`;

// Change stamp for the queue as filtered: row count + newest updated_at of the matching rows +
// the open, done, archived and total counts. Any ingest, status change, reassignment or edit moves
// at least one of these, so a differing stamp means "the pane you are looking at is stale". Two
// trivial indexed aggregates; safe to probe every few seconds from every open browser.
function queueStamp(f) {
  const r = db.prepare(`SELECT COUNT(*) AS n, MAX(updated_at) AS u FROM work_items w WHERE ${f.conds.join(" AND ")}`).get(...f.params);
  const c = db.prepare(
    `SELECT SUM(CASE WHEN w.status NOT IN ('done','archived') THEN 1 ELSE 0 END) AS open_n,
            SUM(CASE WHEN w.status = 'done' THEN 1 ELSE 0 END) AS done_n,
            SUM(CASE WHEN w.status = 'archived' THEN 1 ELSE 0 END) AS arch_n,
            COUNT(*) AS all_n
     FROM work_items w ${f.cConds.length ? "WHERE " + f.cConds.join(" AND ") : ""}`
  ).get(...f.cParams);
  return [r.n, r.u || "", c.open_n || 0, c.done_n || 0, c.arch_n || 0, c.all_n || 0].join("|");
}

// One list row (the vocabulary list row): sender and time; subject with the suggested-document
// count; one line of summary; a status pill only when the email is not simply ready to send (New,
// Needs your answer, Drafting, Check, or the closed status in History) and a P1 pill.
function rowHtml(w, ctx) {
  const { lang, sel, sumOf, sumPending, boxes } = ctx;
  const closed = w.status === "done" || w.status === "archived";
  let clip = 0;
  if (!closed && w.doc_suggestions_json && !w.injection_flag) {
    try { clip = (JSON.parse(w.doc_suggestions_json) || []).filter((s) => s.status === "in_scope" || s.status === "ambiguous").length; }
    catch (e) { clip = 0; }
  }
  const pill = (text, tone, dot) => `<span class="wb-pill" data-tone="${tone}">${dot ? '<i class="wb-dot" aria-hidden="true"></i>' : ""}${esc(text)}</span>`;
  const tone = { new: "neutral", awaiting_input: "warn", investigating: "info" }[w.status];
  const end = (w.injection_flag && !closed ? pill(t(lang, "check"), "bad", true)
      : closed ? pill(statusWithRes(lang, w), "neutral")
      : tone ? pill(statusLabel(lang, w.status), tone, true) : "")
    + ((w.priority || 2) === 1 && !w.injection_flag && !closed ? pill("P1", "bad") : "")
    + (boxes ? pill(t(lang, w.mailbox), "neutral") : "");
  const searchable = [
    "#" + w.id, statusLabel(lang, w.status), w.mailbox, w.sender_name, w.sender_email, w.subject,
    sumOf(w), w.summary, intentLabel(lang, w.intent), ownerLabel(w), w.rule_id, w.email_text,
  ].filter(Boolean).join(" ").toLowerCase();
  const sum = esc(sumOf(w)) + (w.caller_info ? `${sumOf(w) ? " · " : ""}${esc(w.caller_info)}` : "");
  return `<a class="wb-row" role="option" href="${BASE.path}/item/${w.id}" hx-get="${BASE.path}/item/${w.id}" hx-target="#workpane" hx-swap="innerHTML" hx-push-url="true" data-id="${w.id}" aria-selected="${sel === w.id}" data-search="${esc(searchable)}">
<span class="wb-row__title">${esc(w.sender_name || w.sender_email)}</span><span class="wb-row__meta">${esc(fmtDateTime(w.updated_at, lang))}</span>
<span class="wb-row__line">${clip ? `<span class="ax-clip" aria-label="${esc(t(lang, "sugg_title"))}: ${clip}">${icon("clip")}${clip}</span>` : ""}${w.origin === "compose" ? `<span class="ax-clip" aria-label="${esc(t(lang, "compose_new"))}">${icon("edit")}</span>` : ""}${esc(w.subject || t(lang, "no_subject"))}</span>
<span class="wb-row__sum"${sumPending.has(w.id) ? ` data-trs="${w.id}"` : ""}>${sum}</span>${end ? `<span class="wb-row__end">${end}</span>` : ""}</a>`;
}

async function buildQueuePane(req, opts) {
  const lang = req.user.lang;
  const sel = (opts && opts.sel) || 0;
  const f = queueFilter(req);
  const { mb, show, scope, q, conds, params } = f;
  const hist = show === "history";
  // History loads PAGE_SIZE rows at a time (Load more); the open list is always whole.
  const PAGE_SIZE = 50;
  const pageNo = hist ? Math.max(1, parseInt((opts && opts.page) || req.query.page, 10) || 1) : 1;
  const offset = (pageNo - 1) * PAGE_SIZE;
  // The open list: what needs me next. History: newest first.
  const order = hist ? " ORDER BY w.updated_at DESC"
    : " ORDER BY w.injection_flag DESC, CASE WHEN w.status = 'awaiting_input' THEN 0 WHEN w.status = 'ready' THEN 1 WHEN w.status = 'new' THEN 2 ELSE 3 END, w.priority ASC, w.updated_at DESC";
  const items = db.prepare(`SELECT w.* FROM work_items w WHERE ${conds.join(" AND ")}${order}${hist ? " LIMIT ? OFFSET ?" : ""}`)
    .all(...params, ...(hist ? [PAGE_SIZE, offset] : []));
  const total = hist ? db.prepare(`SELECT COUNT(*) AS n FROM work_items w WHERE ${conds.join(" AND ")}`).get(...params).n : items.length;
  audit(req.user.tailscale_login, "view_inbox", null, `mailbox=${mb} scope=${scope} show=${show} items=${total} lang=${lang}`);
  const qs = filterQs(f);
  // Axle authors summaries in English; CACHED translations render inline, uncached ones show
  // English first and axle.js fills them in through POST /queue/summaries ([data-trs]).
  const sumTr = {};
  const sumPending = new Set();
  if (lang !== "en") for (const w of items) {
    if (!w.summary) continue;
    const c = TR.cached(lang, w.summary);
    if (c) sumTr[w.id] = c; else sumPending.add(w.id);
  }
  const sumOf = (w) => (lang !== "en" && sumTr[w.id]) || w.summary || "";
  // A History search spans both mailboxes: each row names its own (Gouda, Drachten).
  const boxes = !!f.q;
  const rows = items.map((w) => rowHtml(w, { lang, sel, sumOf, sumPending, boxes })).join("\n");
  const hasMore = hist && offset + items.length < total;
  const moreRow = `<div class="ax-qmore" id="qmoreRow"${pageNo > 1 ? ' hx-swap-oob="true"' : ""}><button type="button" class="wb-btn wb-btn--sm" hx-get="${BASE.path}/queue?${esc(qs)}&page=${pageNo + 1}" hx-target="#qlist" hx-swap="beforeend">${esc(t(lang, "load_more"))}</button></div>`;
  // Page 2 and later of History: only the new rows and the out-of-band Load more row.
  if (pageNo > 1) return { html: `${rows}\n${hasMore ? moreRow : `<div id="qmoreRow" hx-swap-oob="delete"></div>`}`, lang, empty: false };

  const sync = syncStatus();
  const L = (k) => esc(t(lang, k));
  const admin = req.user.role === "admin";
  const teachN = admin ? K.pendingCount(db) : 0;
  const mbItem = (v, label) => `<button type="button" class="wb-menu__item" role="menuitemradio" aria-checked="${mb === v}" data-q="mailbox=${v}"><span>${label}</span>${mb === v ? icon("check", "wb-menu__mark") : ""}</button>`;
  const link = (href, label, extra) => `<a class="wb-menu__item" role="menuitem" href="${BASE.path}${href}"><span>${label}</span>${extra || ""}</a>`;
  const menu = `<template id="m-qmore" data-title="${L("more")}" data-align="end">`
    + (hist ? "" : `<button type="button" class="wb-menu__item" role="menuitem" data-q="show=history"><span>${L("history")}<small>${L("history_detail")}</small></span></button><div class="wb-menu__sep" role="separator"></div>`)
    + `<span class="wb-menu__label">${L("mailbox")}</span>${mbItem("all", L("all"))}${mbItem("info", L("info"))}${mbItem("drachten", L("drachten"))}`
    + `<div class="wb-menu__sep" role="separator"></div><button type="button" class="wb-menu__item" role="menuitem" data-sync${sync.running ? " disabled" : ""}><span>${L("sync_now")}</span></button>`
    + `<div class="wb-menu__sep" role="separator"></div>${link("/blocks", L("blocks_title"))}`
    + (admin ? link("/teach", L("teach_review"), teachN ? `<span class="wb-count">${teachN}</span>` : "") + link("/audit", L("audit_log")) + link("/adoption", L("adoption")) : "")
    + `</template>`;
  const btnSearch = iconBtn(t(lang, "search"), "search", "data-qsearch");
  const btnCompose = iconBtn(t(lang, "compose_new"), "edit", "data-compose");
  const btnMore = iconBtn(t(lang, "more"), "dots", 'data-menu="qmore" aria-haspopup="menu" aria-expanded="false"');
  const icons = `<span class="ax-icons">${hist ? "" : btnSearch}${btnCompose}${btnMore}</span>`;
  const head = hist
    ? `<div class="ax-qhd">${iconBtn(t(lang, "history_back"), "back", 'data-q="show=open"', "ax-qback")}<h2 class="ax-qt">${L("history")}</h2>${icons}</div>
<div class="ax-qfind"><div class="wb-input"><span class="wb-adorn">${icon("search")}</span><input type="search" id="qh" value="${esc(q)}" placeholder="${L("history_search")}" aria-label="${L("history_search")}" autocomplete="off" enterkeyhint="search"><button type="button" class="wb-clear" data-qh-clear aria-label="${L("clear_search")}" title="${L("clear_search")}"${q ? "" : " hidden"}>${icon("x")}</button></div></div>`
    : `<div class="ax-qhd"><div class="wb-seg" role="radiogroup" aria-label="${L("show_label")}"><button type="button" role="radio" aria-checked="${scope === "mine"}" data-q="scope=mine">${L("mine")}</button><button type="button" role="radio" aria-checked="${scope === "all"}" data-q="scope=all">${L("all")}</button></div>${icons}
<div class="wb-input ax-qsearch"><span class="wb-adorn">${icon("search")}</span><input type="search" id="q" placeholder="${L("search_emails")}" aria-label="${L("search_emails")}" autocomplete="off"></div>${iconBtn(t(lang, "close_search"), "x", "data-qsearch-close", "ax-qclose")}</div>`;
  const empty = hist ? (q ? t(lang, "history_no_match").replace("{q}", q) : t(lang, "history_none")) : t(lang, "no_open");
  const lastT = sync.finished_at ? fmtTime(parseTS(sync.finished_at), lang) : t(lang, "never");
  const html = `<div class="ax-q" data-qs="${esc(qs)}" data-stamp="${esc(queueStamp(f))}" data-show="${show}">
<header class="wb-page__hd ax-ptop">${homeLink(lang)}<h1 class="wb-page__t">Axle</h1>${icons}</header>
${head}
<div data-ax-banner>${opts && opts.syncedBanner ? `<div class="wb-banner ax-flash" data-tone="info">${icon("info")}<div class="wb-banner__body">${L("sync_started")}</div></div>` : ""}</div>
<div class="wb-list" role="listbox" id="qlist" data-page="${pageNo}" aria-label="${L(hist ? "history" : "inbox")}">${rows || `<div class="wb-empty">${esc(empty)}</div>`}</div>
${hasMore ? moreRow : ""}
${menu}
</div>
<p class="ax-live"${sync.running ? " data-running" : ""}><span id="qlivet">${sync.running ? L("syncing") : esc(t(lang, "updated").replace("{t}", lastT))}</span><button type="button" class="wb-pillbtn" id="qupd" hidden>${L("updates_waiting")}</button></p>`;
  return { html, lang, empty: !hist && !items.length };
}

// --- Compose (Compose A) ----------------------------------------------------------------------
// A drawer from 640 up, a page on the phone (axle.js draws the one markup either way). Customer
// (the resolver, read-only), What should it say, Attach; Cancel, Write it myself (reveals Subject,
// the main button becomes Send; only while allow-list #3 is on), Draft with Axle. Language is
// automatic and Send from follows the person, as the old selects defaulted. Posts exactly the
// fields POST /compose reads; the recipient is re-resolved and re-validated there.
function composeUi(req) {
  const lang = req.user.lang;
  const L = (k) => esc(t(lang, k));
  const send = !!ACTION_COMPOSE_SEND;
  return `
<div class="ax-ov" id="compose" data-kind="drawer" data-form role="dialog" aria-modal="true" aria-labelledby="compose-t" data-max="${MAX_ATTACH_BYTES}" data-max-total="${MAX_ATTACH_TOTAL}" hidden>
  <div class="ax-ov__hd">${iconBtn(t(lang, "back"), "back", "data-close", "ax-ov__back")}<h2 class="ax-ov__t" id="compose-t">${L("compose_new")}</h2>${iconBtn(t(lang, "close"), "x", "data-close", "ax-ov__x")}</div>
  <form class="ax-ov__bd" id="composeForm" method="post" action="${BASE.path}/compose" autocomplete="off" novalidate data-compose-form>
    <div data-ax-banner></div>
    <div class="wb-field">
      <label class="wb-label" for="cmp-who">${L("compose_customer_label")}</label>
      <div class="wb-input"><span class="wb-adorn" data-cmp-adorn>${icon("search")}</span><input type="text" id="cmp-who" role="combobox" aria-autocomplete="none" aria-expanded="false" aria-controls="cmp-res" placeholder="${L("compose_who_ph")}" enterkeyhint="search"><button type="button" class="wb-clear" data-cmp-clear aria-label="${L("close")}" hidden>${icon("x")}</button></div>
      <p class="wb-msg" data-msg="who" hidden></p>
      <div class="ax-cmp-res" id="cmp-res" aria-live="polite"></div>
    </div>
    <input type="hidden" name="who"><input type="hidden" name="pick_card"><input type="hidden" name="pick_addr">
    <input type="hidden" name="scenario" value=""><input type="hidden" name="language" value="auto"><input type="hidden" name="mailbox" value="${defaultMailbox(req.user)}">
    ${send ? `<div class="wb-field ax-cmp-write"><label class="wb-label" for="cmp-subject">${L("compose_subject")}</label><div class="wb-input"><input type="text" id="cmp-subject" name="subject" maxlength="200"></div><p class="wb-msg" data-msg="subject" hidden></p></div>` : ""}
    <div class="wb-field"><label class="wb-label" for="cmp-msg">${L("compose_instruction")}</label><div class="wb-input wb-input--area ax-cmp-msg"><textarea id="cmp-msg" name="instruction" placeholder="${L("compose_instruction_ph")}"></textarea></div><p class="wb-msg" data-msg="instruction" hidden></p></div>
    <div class="ax-cmp-att" data-cmp-drop>
      <button type="button" class="wb-btn wb-btn--ghost ax-ov-btn" data-cmp-attach>${icon("clip")}<span>${L("attach")}</span></button>
      <input type="file" id="cmp-file" multiple hidden>
      <div class="ax-chips" id="cmp-atts"></div>
      <p class="wb-msg" data-msg="att" hidden></p>
    </div>
    ${send ? "" : `<p class="wb-hint">${L("compose_draft_only")}</p>`}
  </form>
  <div class="ax-ov__ft">
    <button type="button" class="wb-btn wb-btn--ghost ax-ov-desk" data-close>${L("compose_cancel")}</button>
    ${send ? `<button type="button" class="wb-btn ax-cmp-draft" data-cmp-write>${L("compose_write")}</button><button type="button" class="wb-btn ax-cmp-write" data-cmp-write>${L("compose_draft_ai")}</button>` : ""}
    <button type="submit" form="composeForm" class="wb-btn wb-btn--primary ax-cmp-draft" name="mode" value="draft">${L("compose_draft_ai")}</button>
    ${send ? `<button type="submit" form="composeForm" class="wb-btn wb-btn--commit ax-cmp-write" name="mode" value="send" data-send>${icon("send")}<span>${L("send")}</span></button>` : ""}
  </div>
</div>`;
}
app.locals.composeUi = composeUi;

// Inbox: the queue beside the work area. The queue renders INLINE here (audit + translation side
// effects as the old inbox page); the work area says what to do until an email is picked.
app.get("/", async (req, res) => {
  const q = await buildQueuePane(req, { sel: 0, syncedBanner: !!req.query.synced, page: 1 });
  const body = shell(q.html, voidPane(q.lang), q.empty) + composeUi(req);
  res.send(page("Inbox", req.user, body, 0, { shell: true }));
});

// Queue fragment: the live refresh, every in-place switch (Mine | All, Mailbox, History and its
// search), Load more, and the lazy queue of item deep links. Same data path, audit and
// translations as GET /; ?sel marks the open email's row.
app.get("/queue", async (req, res) => {
  const q = await buildQueuePane(req, { sel: parseInt(req.query.sel, 10) || 0 });
  res.send(q.html);
});

// Change probe for the live queue (see assets/axle.js): the stamp of the queue as the caller has it
// filtered, plus whether an ingest is running. Deliberately NOT audited and translation-free: it
// fires every 10 s from every open browser and must stay a pair of indexed aggregates.
app.get("/queue/stamp", (req, res) => {
  const f = queueFilter(req);
  res.set("Cache-Control", "no-store");
  res.json({ stamp: queueStamp(f), running: !!syncStatus().running });
});

// Background queue-summary translations (see buildQueuePane). SECURITY: ids only -
// the translated text is loaded from the DB, never taken from the client; failures
// are skipped so the row silently keeps its English summary. Bounded concurrency:
// a cold NL queue can hold a few hundred uncached summaries.
app.post("/queue/summaries", async (req, res) => {
  const lang = req.user.lang;
  if (lang === "en") return res.json({});
  const ids = [...new Set(String(req.body.ids || "").split(",").map((s) => parseInt(s, 10)).filter(Number.isInteger))].slice(0, 300);
  const out = {};
  const CHUNK = 8;
  for (let i = 0; i < ids.length; i += CHUNK) {
    await Promise.all(ids.slice(i, i + CHUNK).map(async (id) => {
      const row = db.prepare("SELECT summary FROM work_items WHERE id = ?").get(id);
      if (!row || !row.summary) return;
      try { const x = await TR.translate(anthropic, lang, row.summary); if (x) out[id] = x; }
      catch (e) { /* keep English on this row */ }
    }));
  }
  res.json(out);
});

};
