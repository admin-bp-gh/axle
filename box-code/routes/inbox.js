// routes/inbox.js - the work-queue pane (GET / inline + GET /queue fragment), the
// per-browser language toggle (/setlang) and the manual Sync (/sync), incl. the
// compose modal markup the queue embeds. Extracted from server.js in UI rework
// Step 0; reshaped into the three-pane shell's queue in Step 2 (2026-06-10):
// card-rows + action-state chips (F1/F2), "Live · updated" indicator (F3) and the
// collapsed toolbar (F4). Query semantics and audit calls are unchanged from the
// old inbox; summary translations render from cache and fill in asynchronously
// (UX round, 2026-06-11 - see buildQueuePane). ACTION_COMPOSE_SEND is passed in by
// server.js so the allow-list env check stays defined in exactly one place.
const INGEST = require("../ingest.js");
const TR = require("../translate.js");
const SCEN = require("../scenarios.js");
const { db, audit, acquireSync, releaseSync, syncStatus } = require("../db.js");
const { esc, t, page, langOK, statusLabel, statusWithRes, intentLabel, ownerLabel,
        fmtDateTime, fmtTime, parseTS, shell, workPanes } = require("../views/ui.js");
const { anthropic, MAX_ATTACH_BYTES, MAX_ATTACH_TOTAL, defaultMailbox } = require("./shared.js");

module.exports = function mountInbox(app, { ACTION_COMPOSE_SEND }) {

// Language toggle: set the per-browser language cookie and return to the prior page.
app.get("/setlang", (req, res) => {
  const l = langOK(req.query.lang);
  res.setHeader("Set-Cookie", `axle_lang=${l}; Path=/; Max-Age=31536000; SameSite=Lax`);
  let back = "/";
  try { if (req.headers.referer) { const u = new URL(req.headers.referer); back = u.pathname + u.search; } } catch (e) { /* ignore */ }
  if (!back.startsWith("/")) back = "/";
  audit(req.user.tailscale_login, "set_language", null, l);
  res.redirect(back);
});

// Manual "Sync now": run the info@ + drachten@ ingest IN-PROCESS in the background. Same watermark
// path as the scheduled task -- it ingests every email new since the last sync. Holding the lock in
// the server process (with a guaranteed release in finally) means the button and "last synced"
// always update; a server restart mid-sync is healed by the startup reset above. Acquiring the same
// lock as the scheduled task ensures no overlap.
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
  res.redirect("/?synced=1");
});

// --- The work queue (Step 2: the shell's left pane) -----------------------------
// One card-row per item (F1): sender + subject, the one-line summary, a single
// action-state chip, time, small badges. Default order = "what needs me next"
// (F2): flagged -> needs your answer -> ready to send -> new -> the rest, then
// priority, then freshness. The WHERE semantics and audit detail string are
// IDENTICAL to the pre-shell inbox; summary translations are cache-inline +
// async-fill since the UX round (2026-06-11). Shared by GET / (inline) and
// GET /queue (the lazy fragment item deep-links load), so both render the same DOM.
async function buildQueuePane(req, opts) {
  const lang = req.user.lang;
  const sel = (opts && opts.sel) || 0;
  const mb = ["info", "drachten"].includes(req.query.mailbox) ? req.query.mailbox : "all";
  const show = ["open", "done", "archived", "all"].includes(req.query.show) ? req.query.show : "open";
  // Scope: "mine" shows only items routed to this user (owner label); "all" shows everything.
  // Sales default to their own queue; admins default to all for oversight. Either can toggle.
  const scope = ["mine", "all"].includes(req.query.scope) ? req.query.scope
    : (req.user.role === "admin" ? "all" : "mine");
  const myOwner = req.user.owner_label || req.user.display_name;
  const statusCond = show === "open" ? "w.status NOT IN ('done','archived')"
    : show === "done" ? "w.status = 'done'"
    : show === "archived" ? "w.status = 'archived'"
    : "1=1";
  const conds = [statusCond];
  const params = [];
  if (mb !== "all") { conds.push("w.mailbox = ?"); params.push(mb); }
  if (scope === "mine") { conds.push("w.owner = ?"); params.push(myOwner); }
  // F2 default order, open view: what needs me next. Completed views stay newest-first.
  const order = show === "open"
    ? " ORDER BY w.injection_flag DESC, CASE WHEN w.status = 'awaiting_input' THEN 0 WHEN w.status = 'ready' THEN 1 WHEN w.status = 'new' THEN 2 ELSE 3 END, w.priority ASC, w.updated_at DESC"
    : " ORDER BY w.updated_at DESC";
  const items = db.prepare(
    `SELECT w.*, (SELECT COUNT(*) FROM questions q WHERE q.work_item_id = w.id AND q.answer IS NULL) AS open_q
     FROM work_items w WHERE ${conds.join(" AND ")}${order}`
  ).all(...params);
  audit(req.user.tailscale_login, "view_inbox", null, `mailbox=${mb} scope=${scope} show=${show} items=${items.length} lang=${lang}`);
  const investigating = items.some((w) => w.status === "investigating");
  const sync = syncStatus();
  // Axle authors summaries in English; CACHED translations render inline (sync DB
  // hit), uncached ones show English first and fill in via POST /queue/summaries in
  // the background (UX round, 2026-06-11 - a cold NL queue used to stall the render
  // on one API call per item).
  const sumTr = {};
  const sumPending = new Set();
  if (lang !== "en") for (const w of items) {
    if (!w.summary) continue;
    const c = TR.cached(lang, w.summary);
    if (c) sumTr[w.id] = c; else sumPending.add(w.id);
  }
  const sumOf = (w) => (lang !== "en" && sumTr[w.id]) || w.summary || "";
  // Status-tab counts under the current mailbox + scope (the status filter itself excluded).
  const cConds = [], cParams = [];
  if (mb !== "all") { cConds.push("w.mailbox = ?"); cParams.push(mb); }
  if (scope === "mine") { cConds.push("w.owner = ?"); cParams.push(myOwner); }
  const counts = db.prepare(
    `SELECT SUM(CASE WHEN w.status NOT IN ('done','archived') THEN 1 ELSE 0 END) AS open_n,
            SUM(CASE WHEN w.status = 'done' THEN 1 ELSE 0 END) AS done_n,
            SUM(CASE WHEN w.status = 'archived' THEN 1 ELSE 0 END) AS arch_n,
            COUNT(*) AS all_n
     FROM work_items w ${cConds.length ? "WHERE " + cConds.join(" AND ") : ""}`
  ).get(...cParams);
  // Auto-attach hint: a paperclip when the item has attachable (in-scope/ambiguous) suggested
  // documents. Out-of-scope-only items show nothing here (they need an explicit confirm anyway).
  const suggHint = (w) => {
    if (!w.doc_suggestions_json || w.injection_flag) return "";
    let n = 0;
    try { n = (JSON.parse(w.doc_suggestions_json) || []).filter((s) => s.status === "in_scope" || s.status === "ambiguous").length; }
    catch (e) { return ""; }
    return n ? ` <span class="chip sugg" title="${esc(t(lang, "sugg_title"))}">&#128206;${n}</span>` : "";
  };
  const mbLink = (v, label) => `<a class="mitem${mb === v ? " on" : ""}" href="/?mailbox=${v}&show=${show}&scope=${scope}">${label}</a>`;
  const showTab = (v, label, n) => `<a class="qtab${show === v ? " on" : ""}" href="/?mailbox=${mb}&show=${v}&scope=${scope}">${label}<span class="n">${n || 0}</span></a>`;
  const scopeLink = (v, label) => `<a class="seg${scope === v ? " on" : ""}" href="/?mailbox=${mb}&show=${show}&scope=${v}">${label}</a>`;
  const searchable = (w) => [
    "#" + w.id, statusLabel(lang, w.status), w.mailbox, w.sender_name, w.sender_email, w.subject,
    sumOf(w), w.summary, intentLabel(lang, w.intent), ownerLabel(w), w.rule_id, w.email_text,
  ].filter(Boolean).join(" ").toLowerCase();
  // The single action-state chip (F2). A flagged item's one job is the careful check,
  // so the red Check chip replaces the state there.
  const stateChip = (w) => w.injection_flag
    ? `<span class="chip inj">${esc(t(lang, "check"))}</span>`
    : `<span class="chip s-${esc(w.status)}">${esc(statusWithRes(lang, w))}</span>`
      + (w.suggest_close && w.status !== "done" && w.status !== "archived"
        ? ` <span class="chip sugg" title="${esc(t(lang, "suggest_close_title"))}">${esc(t(lang, "suggest_close_chip"))}</span>` : "");
  const sumLine = (w) => `<span${sumPending.has(w.id) ? ` data-trs="${w.id}"` : ""}>${esc(sumOf(w))}</span>`
    + (w.caller_info ? `${sumOf(w) ? " &middot; " : ""}&#128222; ${esc(w.caller_info)}` : "");
  // Card-rows: plain links (work without JS); htmx upgrades a click to swap the
  // work panes in place so the queue never reloads while browsing. data-* feeds
  // the client-side search filter and sort, exactly like the old table's columns.
  const cards = items.map((w, i) => `
    <a class="qcard${sel === w.id ? " sel" : ""}" href="/item/${w.id}" hx-get="/item/${w.id}" hx-target="#workpane" hx-swap="innerHTML" hx-push-url="true"
       data-search="${esc(searchable(w))}" data-rank="${i}" data-upd="${esc(w.updated_at || "")}" data-prio="${w.priority || 2}">
      <span class="q-l1"><span class="q-from">${esc(w.sender_name || w.sender_email)}</span><span class="q-time muted">${esc(fmtDateTime(w.updated_at, lang))}</span></span>
      <span class="q-l2"><span class="q-subj">${w.origin === "compose" ? "&#9998; " : ""}${esc(w.subject || t(lang, "no_subject"))}</span><span class="q-badges">${suggHint(w)}${(w.priority || 2) === 1 && !w.injection_flag ? ` <span class="badge prio1">P1</span>` : ""}</span></span>
      <span class="q-l3"><span class="q-sum muted">${sumLine(w)}</span>${stateChip(w)}</span>
    </a>`).join("");
  const lastT = sync.finished_at ? fmtTime(parseTS(sync.finished_at), lang) : t(lang, "never");

  // --- Compose modal (built once per inbox render) ---
  const defMb = defaultMailbox(req.user);
  const scenList = SCEN.chips(lang);                       // [{key,label,skeleton}]
  const scenChipsHtml = scenList.map((s) => `<button type="button" class="schip" data-key="${esc(s.key)}">${esc(s.label)}</button>`).join("");
  const scenSkeletons = {}; scenList.forEach((s) => { scenSkeletons[s.key] = s.skeleton; });
  // UI strings the client script needs — JSON-encoded so quotes/encoding can never break the JS.
  const L = JSON.stringify({
    to: t(lang, "compose_to"), pick_address: t(lang, "compose_pick_address"), pick_customer: t(lang, "compose_pick_customer"),
    not_found: t(lang, "compose_not_found"), guest: t(lang, "compose_guest"), frozen: t(lang, "compose_frozen"),
    finding: t(lang, "compose_finding"), need_instr: t(lang, "compose_need_who_instr"), need_pick: t(lang, "compose_need_pick"),
    no_att: t(lang, "no_attachments"), remove: t(lang, "remove"), file_big: t(lang, "file_too_big"),
    att_total: t(lang, "attach_total"), creating: t(lang, "compose_creating"),
  });
  const composeUi = `
    <div id="composeModal" class="modal" style="display:none" role="dialog" aria-modal="true">
      <div class="modal-card">
        <div class="modal-head"><h2>${esc(t(lang, "compose_title"))}</h2>
          <button type="button" class="modal-x" id="composeClose" aria-label="Close">&times;</button></div>
        <form method="post" action="/compose" id="composeForm" autocomplete="off">
          <label class="fld"><span>${esc(t(lang, "compose_who"))}</span>
            <div class="whorow">
              <input type="text" name="who" id="who" placeholder="${esc(t(lang, "compose_who_ph"))}">
              <button type="button" class="mini" id="findBtn">${esc(t(lang, "compose_find"))}</button>
            </div></label>
          <div id="resolveBox" class="resolvebox" style="display:none"></div>
          <input type="hidden" name="pick_card" id="pick_card">
          <input type="hidden" name="pick_addr" id="pick_addr">
          <label class="fld"><span>${esc(t(lang, "compose_scenario"))}</span>
            <div class="chips" id="scenchips">${scenChipsHtml}</div></label>
          <input type="hidden" name="scenario" id="scenario">
          <label class="fld"><span>${esc(t(lang, "compose_instruction"))}</span>
            <div id="instrEditor" class="instr-editor" contenteditable="true" role="textbox" aria-multiline="true" data-ph="${esc(t(lang, "compose_instruction_ph"))}"></div>
            <textarea name="instruction" id="instruction" style="display:none"></textarea></label>
          <div class="fldrow">
            <label class="fld"><span>${esc(t(lang, "compose_language"))}</span>
              <select name="language" id="clang">
                <option value="auto">${esc(t(lang, "compose_lang_auto"))}</option>
                <option value="en">EN</option><option value="nl">NL</option>
                <option value="de">DE</option><option value="fr">FR</option><option value="es">ES</option>
              </select></label>
            <label class="fld"><span>${esc(t(lang, "compose_from"))}</span>
              <select name="mailbox" id="cmailbox">
                <option value="info"${defMb === "info" ? " selected" : ""}>info@</option>
                <option value="drachten"${defMb === "drachten" ? " selected" : ""}>drachten@</option>
              </select></label>
          </div>
          <label class="fld"><span>${esc(t(lang, "attachments"))}</span>
            <div class="attzone" id="cmpAttzone">
              <div id="cmpAttlist" class="muted">${esc(t(lang, "no_attachments"))}</div>
              <p class="muted attnote">${esc(t(lang, "attach_hint"))} ${esc(t(lang, "drop_hint"))}. ${esc(t(lang, "paste_hint"))}</p>
              <input type="file" id="cmpFile" multiple>
            </div></label>
          <div id="cmpAttHidden"></div>
          <div class="modal-foot">${!ACTION_COMPOSE_SEND ? `<span class="muted">${esc(t(lang, "compose_draft_only"))}</span>` : ""}
            <span class="spacer"></span>
            <button type="button" id="composeCancel">${esc(t(lang, "compose_cancel"))}</button>
            <button type="submit" class="primary" id="composeSubmit">${esc(t(lang, "compose_create"))}</button>
          </div>
        </form>
      </div>
    </div>
    <script>
    (function () {
      var modal = document.getElementById("composeModal");
      if (!modal) return;
      var L = ${L}, SKEL = ${JSON.stringify(scenSkeletons)};
      var SKELSET = Object.keys(SKEL).map(function (k) { return SKEL[k]; });
      var MAX = ${MAX_ATTACH_BYTES}, MAXTOT = ${MAX_ATTACH_TOTAL}, staged = [];
      var $ = function (id) { return document.getElementById(id); };
      function openM() { modal.style.display = "flex"; $("who").focus(); }
      function closeM() { modal.style.display = "none"; }
      $("composeBtn").addEventListener("click", openM);
      $("composeClose").addEventListener("click", closeM);
      $("composeCancel").addEventListener("click", closeM);
      // Close only on an explicit action (X / Cancel / Esc). Deliberately NOT on a backdrop/outside
      // click - a drag-to-select inside the form that releases outside the card must never dismiss it.
      document.addEventListener("keydown", function (e) { if (e.key === "Escape" && modal.style.display !== "none") closeM(); });
      function esc2(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

      // Rich instruction editor: render the scenario skeleton with bold frame labels ("Situation:")
      // and subtle italic guidance, so a paragraph reads as a fill-in-the-blanks form. The submitted
      // value is always the plain text (innerText) mirrored into the hidden #instruction field.
      function fmtSkeleton(sk) {
        var NL = String.fromCharCode(10);
        return String(sk).split(NL).map(function (line) {
          var i = line.indexOf(":");
          if (i > 0 && i <= 22) return '<div><span class="lbl">' + esc2(line.slice(0, i + 1)) + '</span><span class="hint">' + esc2(line.slice(i + 1)) + "</span></div>";
          return "<div>" + (line ? esc2(line) : "<br>") + "</div>";
        }).join("");
      }
      function syncInstr() { var ed = $("instrEditor"); if (ed) $("instruction").value = ed.innerText; }
      (function () {
        var ed = $("instrEditor"); if (!ed) return;
        ed.addEventListener("input", syncInstr);
        ed.addEventListener("paste", function (e) { e.preventDefault(); var t = ((e.clipboardData || window.clipboardData).getData("text") || ""); document.execCommand("insertText", false, t); });
      })();

      // Scenario chips: select tags the scenario + fills the instruction with a starter (only
      // when the box is empty or still holds another starter — never clobbers typed text).
      var chips = modal.querySelectorAll(".schip");
      chips.forEach(function (ch) {
        ch.addEventListener("click", function () {
          var wasOn = ch.classList.contains("on");
          chips.forEach(function (c) { c.classList.remove("on"); });
          var instr = $("instruction");
          if (wasOn) { $("scenario").value = ""; return; }
          ch.classList.add("on");
          $("scenario").value = ch.getAttribute("data-key");
          var sk = SKEL[ch.getAttribute("data-key")] || "";
          if (sk && (!instr.value.trim() || SKELSET.indexOf(instr.value) >= 0)) { $("instrEditor").innerHTML = fmtSkeleton(sk); syncInstr(); }
        });
      });

      // Recipient resolution (read-only). pick_addr is only ever set from a resolver address.
      function clearPick() { $("pick_card").value = ""; $("pick_addr").value = ""; }
      function setPick(card, addr) { $("pick_card").value = card || ""; $("pick_addr").value = addr || ""; }
      function addrRadios(name, addrs, card) {
        return addrs.map(function (a) {
          return '<label><input type="radio" name="' + name + '"' + (addrs.length === 1 ? " checked" : "") +
            ' value="' + esc2(a) + '" data-card="' + esc2(card || "") + '"> ' + esc2(a) + "</label>";
        }).join("");
      }
      function wirePicks() {
        modal.querySelectorAll('#resolveBox input[name=raddr]').forEach(function (r) {
          r.addEventListener("change", function () { setPick($("pick_card").value, r.value); });
        });
        modal.querySelectorAll('#resolveBox input[name=rcand]').forEach(function (r) {
          r.addEventListener("change", function () {
            setPick(r.getAttribute("data-card"), "");
            modal.querySelectorAll(".candaddr").forEach(function (b) { b.style.display = "none"; });
            var sub = $("cand_" + r.value);
            if (sub) { sub.style.display = "block"; var one = sub.querySelector("input[type=radio]"); if (one && sub.querySelectorAll("input").length === 1) { one.checked = true; setPick(r.getAttribute("data-card"), one.value); } }
          });
        });
        modal.querySelectorAll('#resolveBox input[name=caddr]').forEach(function (r) {
          r.addEventListener("change", function () { setPick(r.getAttribute("data-card"), r.value); });
        });
      }
      function renderResolve(d) {
        var box = $("resolveBox"); box.style.display = "block"; clearPick();
        if (d.error) { box.innerHTML = '<span class="rbad">' + esc2(d.error) + "</span>"; return; }
        if (d.resolved && d.customer) {
          var c = d.customer;
          var who = esc2(c.name || c.contactName || "") + (c.cardCode ? " (" + esc2(c.cardCode) + ")" : "") + (c.country ? " &middot; " + esc2(c.country) : "") + (c.contactName && c.contactName !== c.name ? " &middot; " + esc2(c.contactName) : "");
          var h = "";
          if (c.addresses.length <= 1) {
            setPick(c.cardCode, c.addresses[0] || "");
            h += '<div class="rok">&#10003; ' + esc2(L.to) + ": " + esc2(c.addresses[0] || "—") + "</div><div class=\\"muted\\">" + who + "</div>";
          } else {
            h += "<div>" + who + "</div><div class=\\"muted\\">" + esc2(L.pick_address) + "</div>" + addrRadios("raddr", c.addresses, c.cardCode);
            setPick(c.cardCode, "");
          }
          if (!c.knownAccount) h += '<div class="rwarn">' + esc2(L.guest) + "</div>";
          if (c.frozen) h += '<div class="rwarn">' + esc2(L.frozen) + "</div>";
          box.innerHTML = h; wirePicks(); return;
        }
        if (d.candidates && d.candidates.length) {
          var html = '<div class="muted">' + esc2(d.message || L.pick_customer) + "</div>";
          d.candidates.forEach(function (c, i) {
            var meta = esc2(c.cardCode || "") + (c.country ? " &middot; " + esc2(c.country) : "") + (c.frozen ? ' &middot; <span class="rwarn">frozen</span>' : "");
            var det = [];
            if (c.contactName && c.contactName !== c.name) det.push(esc2(c.contactName));
            if (c.email) det.push(esc2(c.email));
            html += '<label class="cand"><input type="radio" name="rcand" value="' + i + '" data-card="' + esc2(c.cardCode) + '">' +
              '<span class="cand-body">' +
                '<span class="cand-l1"><b>' + esc2(c.name || "—") + '</b> <span class="muted">&middot; ' + meta + "</span></span>" +
                (det.length ? '<span class="cand-l2 muted">' + det.join(" &middot; ") + "</span>" : "") +
                (c.reason ? '<span class="cand-r muted">— ' + esc2(c.reason) + "</span>" : "") +
              "</span></label>";
            html += '<div class="candaddr" id="cand_' + i + '" style="display:none;margin-left:26px">' +
              (c.addresses || []).map(function (a) { return '<label><input type="radio" name="caddr" value="' + esc2(a) + '" data-card="' + esc2(c.cardCode) + '"> ' + esc2(a) + "</label>"; }).join("") + "</div>";
          });
          box.innerHTML = html; wirePicks(); return;
        }
        box.innerHTML = '<span class="rwarn">' + esc2(d.message || L.not_found) + "</span>";
      }
      function doFind() {
        var who = $("who").value.trim(); if (!who) return;
        var box = $("resolveBox"); box.style.display = "block"; box.innerHTML = '<span class="spin"></span> <span class="muted">' + esc2(L.finding) + "</span>";
        fetch("/compose/resolve", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "who=" + encodeURIComponent(who) })
          .then(function (x) { return x.json(); }).then(renderResolve)
          .catch(function () { box.innerHTML = '<span class="rbad">(error)</span>'; });
      }
      $("findBtn").addEventListener("click", doFind);
      $("who").addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); doFind(); } });
      $("who").addEventListener("input", clearPick);

      // Attachments staged client-side (base64), injected as hidden inputs on submit.
      function renderAtts() {
        var list = $("cmpAttlist");
        if (!staged.length) { list.className = "muted"; list.textContent = L.no_att; return; }
        list.className = "";
        list.innerHTML = staged.map(function (f, i) {
          return '<div class="cmpatt">&#128206; ' + esc2(f.name) + ' <span class="muted">(' + Math.round(f.size / 1024) + ' KB)</span> <button type="button" class="mini" data-i="' + i + '">' + esc2(L.remove) + "</button></div>";
        }).join("");
        list.querySelectorAll("button[data-i]").forEach(function (b) {
          b.addEventListener("click", function () { staged.splice(+b.getAttribute("data-i"), 1); renderAtts(); });
        });
      }
      function addFiles(files) {
        var arr = [].slice.call(files);
        (function next(i) {
          if (i >= arr.length) { renderAtts(); return; }
          var f = arr[i];
          if (f.size > MAX) { alert(L.file_big); return next(i + 1); }
          var tot = staged.reduce(function (s, x) { return s + x.size; }, 0);
          if (tot + f.size > MAXTOT) { alert(L.att_total); return next(i + 1); }
          var rd = new FileReader();
          rd.onload = function () { staged.push({ name: f.name, ctype: f.type || "application/octet-stream", b64: String(rd.result).split(",")[1] || "", size: f.size }); next(i + 1); };
          rd.readAsDataURL(f);
        })(0);
      }
      $("cmpFile").addEventListener("change", function () { addFiles(this.files); this.value = ""; });
      var zone = $("cmpAttzone");
      ["dragenter", "dragover"].forEach(function (ev) { zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add("drag"); }); });
      zone.addEventListener("dragleave", function (e) { if (e.target === zone) zone.classList.remove("drag"); });
      zone.addEventListener("drop", function (e) { e.preventDefault(); zone.classList.remove("drag"); addFiles(e.dataTransfer.files); });

      // Paste-to-attach in the modal: an image on the clipboard (Win+Shift+S) is staged with
      // a single Ctrl+V anywhere in the modal. A paste that carries TEXT into a field stays a
      // text paste (the instruction editor's own handler above already inserts it).
      function pextOf(type) { var m = /^image\\/(png|jpe?g|gif|webp)/i.exec(type || ""); return m ? m[1].replace("jpeg", "jpg") : "png"; }
      modal.addEventListener("paste", function (e) {
        if (!e.clipboardData) return;
        var items = e.clipboardData.items || [], imgs = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].kind === "file" && /^image\\//i.test(items[i].type)) { var f = items[i].getAsFile(); if (f) imgs.push(f); }
        }
        if (!imgs.length) return;
        var tg = e.target, inField = tg && (tg.tagName === "TEXTAREA" || tg.tagName === "INPUT" || tg.isContentEditable);
        if (inField && (e.clipboardData.getData("text/plain") || "").length) return;
        e.preventDefault();
        var stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
        addFiles(imgs.map(function (f, i2) {
          return new File([f], "snippet-" + stamp + (imgs.length > 1 ? "-" + (i2 + 1) : "") + "." + pextOf(f.type), { type: f.type || "image/png" });
        }));
      });

      // Submit: require an instruction and a confirmed recipient; inject staged attachments.
      $("composeForm").addEventListener("submit", function (e) {
        syncInstr();
        if (!$("instruction").value.trim()) { e.preventDefault(); alert(L.need_instr); return; }
        if (!$("pick_addr").value) { e.preventDefault(); alert(L.need_pick); return; }
        var hid = $("cmpAttHidden"); hid.innerHTML = "";
        staged.forEach(function (f) {
          function add(n, v) { var i = document.createElement("input"); i.type = "hidden"; i.name = n; i.value = v; hid.appendChild(i); }
          add("att_name", f.name); add("att_ctype", f.ctype); add("att_data", f.b64);
        });
        $("composeSubmit").textContent = L.creating;
      });
    })();
    </script>`;

  const paneHtml = `
    ${opts && opts.syncedBanner ? `<div class="banner mini">${esc(t(lang, "sync_started"))}</div>` : ""}
    <div class="queue-head">
      <div class="qbar">
        <button type="button" class="seg compose-open" id="composeBtn">&#43; ${esc(t(lang, "compose_new"))}</button>
        <span class="seg-group">${scopeLink("mine", esc(t(lang, "scope_mine")))}${scopeLink("all", esc(t(lang, "all")))}</span>
        <span class="spacer"></span>
        <details class="menu down qfilter"><summary class="btn mini" title="${esc(t(lang, "mailbox"))}">&#9776; ${esc(t(lang, "filter_btn"))}</summary>
          <div class="menu-list"><div class="mlabel">${esc(t(lang, "mailbox"))}</div>${mbLink("all", esc(t(lang, "all")))}${mbLink("info", esc(t(lang, "info")))}${mbLink("drachten", esc(t(lang, "drachten")))}</div>
        </details>
      </div>
      <div class="qtabs">${showTab("open", esc(t(lang, "open")), counts.open_n)}${showTab("done", esc(t(lang, "done")), counts.done_n)}${showTab("archived", esc(t(lang, "archived")), counts.arch_n)}${showTab("all", esc(t(lang, "all")), counts.all_n)}</div>
      <div class="qbar">
        <input id="q" type="search" placeholder="${esc(t(lang, "search_emails"))}" autocomplete="off">
        <select id="qsort" title="${esc(t(lang, "sort_label"))}">
          <option value="rank">${esc(t(lang, "sort_needs"))}</option>
          <option value="new">${esc(t(lang, "sort_new"))}</option>
          <option value="old">${esc(t(lang, "sort_old"))}</option>
          <option value="prio">${esc(t(lang, "sort_prio"))}</option>
        </select>
        <span class="qcount" id="qcount"></span>
      </div>
      <form method="post" action="/sync" class="qlive">
        <span class="livedot${sync.running ? " busy" : ""}"></span>
        <span class="muted">${sync.running ? esc(t(lang, "syncing")) : esc(t(lang, "live_updated").replace("{t}", lastT))}</span>
        <span class="spacer"></span>
        <button class="mini" ${sync.running ? "disabled" : ""}>&#8635; ${esc(t(lang, "sync_now"))}</button>
      </form>
    </div>
    <div class="qlist" id="qlist">${cards || `<div class="qempty muted">${esc(t(lang, "no_items"))}${mb === "all" ? "" : " — " + esc(mb) + "@"}</div>`}</div>
    <script>
    (function () {
      var q = document.getElementById("q"), c = document.getElementById("qcount"), list = document.getElementById("qlist");
      if (!q || !list) return;
      var total = list.querySelectorAll(".qcard").length;
      function apply() {
        var v = q.value.trim().toLowerCase(), n = 0;
        list.querySelectorAll(".qcard").forEach(function (el) {
          var show = !v || (el.getAttribute("data-search") || "").indexOf(v) >= 0;
          el.style.display = show ? "" : "none";
          if (show) n++;
        });
        c.textContent = v ? n + " ${t(lang, "of")} " + total : "";
        sessionStorage.setItem("axle_q", q.value);
      }
      q.addEventListener("input", apply);
      q.value = sessionStorage.getItem("axle_q") || "";
      if (q.value) apply();
      // Sort (client-side, persisted per tab). "rank" = the server's needs-me-next order.
      var sel = document.getElementById("qsort");
      function key(el, k) { return el.getAttribute("data-" + k) || ""; }
      function applySort(mode) {
        var cards = Array.prototype.slice.call(list.querySelectorAll(".qcard"));
        cards.sort(function (a, b) {
          if (mode === "new") return key(a, "upd") > key(b, "upd") ? -1 : key(a, "upd") < key(b, "upd") ? 1 : 0;
          if (mode === "old") return key(a, "upd") < key(b, "upd") ? -1 : key(a, "upd") > key(b, "upd") ? 1 : 0;
          if (mode === "prio") return (+key(a, "prio") - +key(b, "prio")) || (key(a, "upd") > key(b, "upd") ? -1 : 1);
          return +key(a, "rank") - +key(b, "rank");
        });
        cards.forEach(function (x) { list.appendChild(x); });
        sessionStorage.setItem("axle_qsort", mode);
      }
      sel.addEventListener("change", function () { applySort(sel.value); });
      var saved = sessionStorage.getItem("axle_qsort");
      if (saved && saved !== "rank") { sel.value = saved; applySort(saved); }
      // Keep the highlighted card in step with htmx centre-pane swaps.
      list.addEventListener("click", function (e) {
        var a = e.target && e.target.closest ? e.target.closest("a.qcard") : null;
        if (!a) return;
        list.querySelectorAll(".qcard.sel").forEach(function (x) { x.classList.remove("sel"); });
        a.classList.add("sel");
      });
    })();
    </script>
    <script>
    (function () {
      // Background summary-translation fill (UX round): cards rendered instantly with
      // the English summary; one batched call translates the uncached ones and swaps
      // the text in (textContent - escaped by construction). The translated text is
      // also appended to the card's data-search so search finds it, like before.
      // Server-cached, so the next queue render emits no pending markers at all.
      var pend = document.querySelectorAll("#qlist [data-trs]");
      if (!pend.length) return;
      var ids = Array.prototype.map.call(pend, function (el) { return el.getAttribute("data-trs"); });
      fetch("/queue/summaries", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "ids=" + ids.join(",") })
        .then(function (x) { return x.json(); })
        .then(function (d) {
          Array.prototype.forEach.call(pend, function (el) {
            var v = d[el.getAttribute("data-trs")];
            if (!v) return;
            el.textContent = v;
            el.removeAttribute("data-trs");
            var card = el.closest ? el.closest("a.qcard") : null;
            if (card) card.setAttribute("data-search", (card.getAttribute("data-search") || "") + " " + v.toLowerCase());
          });
        })
        .catch(function () { /* English summaries stay - harmless */ });
    })();
    </script>
    <script>
    (function () {
      // Queue auto-refresh while a sync or investigation runs. Replaces the old
      // declarative page refresh, which navigated the whole DOCUMENT back to "/"
      // (the address it was parsed with) and so closed the open item after a few
      // seconds. This swaps ONLY the queue pane; the centre/context panes — and any
      // half-typed reply — are never touched. Singleton timer: each freshly rendered
      // queue fragment updates the config; sec=0 (idle) makes the timer a no-op, so
      // it extinguishes itself when the sync finishes. Same cadence and audit side
      // effects as the old refresh (/queue = the old inbox data path).
      window.__axQPoll = { sec: ${sync.running ? 8 : investigating ? 15 : 0}, qs: ${JSON.stringify(`mailbox=${mb}&show=${show}&scope=${scope}`)}, last: Date.now() };
      if (!window.__axQPollTimer) {
        window.__axQPollTimer = setInterval(function () {
          var c = window.__axQPoll;
          if (!c || !c.sec || !window.htmx) return;
          if (Date.now() - c.last < c.sec * 1000) return;
          var qp = document.getElementById("queuepane");
          // Never yank the queue out from under the user: skip while they're in it
          // (typing in search, an open menu); retry on the next tick.
          if (!qp || (document.activeElement && qp.contains(document.activeElement))) return;
          c.last = Date.now();
          var parts = location.pathname.split("/");
          var sel = parts[1] === "item" ? (parseInt(parts[2], 10) || 0) : 0;
          htmx.ajax("GET", "/queue?" + c.qs + "&sel=" + sel, { target: "#queuepane", swap: "innerHTML" });
        }, 2000);
      }
    })();
    </script>
    ${composeUi}`;
  return { html: paneHtml, sync, investigating, lang };
}

// Inbox: the full three-pane shell. The queue renders INLINE here (audit +
// translation side effects identical to the old inbox page); the centre pane is
// an empty state until an item is picked; the context pane fills per item.
app.get("/", async (req, res) => {
  const q = await buildQueuePane(req, { sel: 0, syncedBanner: !!req.query.synced });
  const empty = `<div class="empty-state"><p class="muted">${esc(t(q.lang, "shell_select"))}</p></div>`;
  const body = shell(q.html, workPanes(empty, ""));
  // No <meta> refresh on the shell (it navigated back to "/" and closed the open
  // item) — the queue pane self-polls via the singleton in buildQueuePane instead.
  res.send(page("Inbox", req.user, body, 0, { shell: true }));
});

// Queue fragment: lazy-loaded into the shell by item deep links (htmx GET), so a
// plain GET /item/:id keeps exactly its old side effects. Same data path, audit
// and translations as GET /; ?sel highlights the open item's card.
app.get("/queue", async (req, res) => {
  const q = await buildQueuePane(req, { sel: parseInt(req.query.sel, 10) || 0 });
  res.send(q.html);
});

// Background queue-summary translations (see buildQueuePane). SECURITY: ids only -
// the translated text is loaded from the DB, never taken from the client; failures
// are skipped so the card silently keeps its English summary. Bounded concurrency:
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
      catch (e) { /* keep English on this card */ }
    }));
  }
  res.json(out);
});

};
