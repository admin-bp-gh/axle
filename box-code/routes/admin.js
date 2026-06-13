// routes/admin.js - block-sender confirm + insert, the team blocklist page and the
// admin-only audit viewer. Extracted VERBATIM from server.js (UI rework Step 0,
// 2026-06-10).
const RESOLVE = require("../resolve-customer.js"); // read-only SAP-customer check on the block page
const { db, audit } = require("../db.js");
const { esc, t, page, fmtDateTime } = require("../views/ui.js");
const { markReadSafe } = require("./shared.js");

module.exports = function mountAdmin(app) {

// ---- Block sender (Axle-only suppression, reversible) -------------------------------------
// GET = a confirm page: choose address-only vs whole-domain, with a SAP-customer check so a
// real customer isn't blocked by accident. POST = insert the block, archive this item
// (resolution no_action) and mark the inbound read. The pattern is derived in code from the
// item's STORED sender address - never from typed input. Blocks are global (info@ +
// drachten@); the mail still arrives in Outlook (no mailbox write). Everything is audited.
app.get("/item/:id/block", async (req, res) => {
  const lang = req.user.lang;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(lang, "not_found"))}</p>`));
  if (w.origin === "compose") return res.redirect("/item/" + w.id);
  const addr = String(w.sender_email || "").trim().toLowerCase();
  const domain = addr.split("@")[1] || "";
  if (!addr || !domain) return res.redirect("/item/" + w.id);

  // SAP check: warn when the address belongs to a real customer (guest matches have no
  // CardCode and don't count). A SQL failure must not break the page - show "unknown".
  let sapNote = `<p class="muted">${esc(t(lang, "block_sap_unknown"))}</p>`;
  try {
    const r = await RESOLVE.resolveCustomer(addr);
    const hit = (r && r.customer && r.customer.cardCode) ? r.customer
      : ((r && r.candidates) || []).find((c) => c.cardCode);
    sapNote = hit
      ? `<p><b>&#9888; ${esc(t(lang, "block_sap_warn"))}</b> ${esc(hit.name || "?")} [${esc(hit.cardCode)}]</p>`
      : `<p class="muted">${esc(t(lang, "block_sap_none"))}</p>`;
  } catch (e) { /* keep the unknown note */ }

  res.send(page(t(lang, "block_title"), req.user, `
    <p><a href="/item/${w.id}">&larr; #${w.id}</a></p>
    <h2>${esc(t(lang, "block_title"))}</h2>
    <div class="box">
      <p><b>${esc(w.sender_name || addr)}</b> &lt;${esc(addr)}&gt;</p>
      <p class="muted">${esc(t(lang, "block_explain"))}</p>
      ${sapNote}
      <form method="post" action="/item/${w.id}/block">
        <p><label><input type="radio" name="kind" value="address" checked> ${esc(t(lang, "block_addr_opt"))} (${esc(addr)})</label><br>
           <label><input type="radio" name="kind" value="domain"> ${esc(t(lang, "block_dom_opt"))} (@${esc(domain)})</label></p>
        <button class="primary">${esc(t(lang, "block_confirm_btn"))}</button>
        <a href="/item/${w.id}" style="margin-left:10px">${esc(t(lang, "block_back"))}</a>
      </form>
    </div>`));
});

app.post("/item/:id/block", async (req, res) => {
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(req.user.lang, "not_found"))}</p>`));
  if (w.origin === "compose") return res.redirect("/item/" + w.id);
  const addr = String(w.sender_email || "").trim().toLowerCase();
  const domain = addr.split("@")[1] || "";
  if (!addr || !domain) return res.redirect("/item/" + w.id);
  const kind = req.body.kind === "domain" ? "domain" : "address";
  const pattern = (kind === "domain" ? "@" + domain : addr).slice(0, 200);
  db.prepare("INSERT OR IGNORE INTO sender_blocks (pattern, kind, reason, added_by, work_item_id) VALUES (?, ?, 'unwanted sender', ?, ?)")
    .run(pattern, kind, req.user.tailscale_login, w.id);
  db.prepare("UPDATE work_items SET status = 'archived', resolution = 'no_action', updated_at = datetime('now') WHERE id = ?").run(w.id);
  audit(req.user.tailscale_login, "sender_blocked", w.id, `${pattern} (${kind})`);
  await markReadSafe(req.user.tailscale_login, w);
  res.redirect("/");
});

// Blocklist viewer: visible to the whole team, unblock allowed for anyone (audited), so a
// mistake is fixable on the spot without waiting for Brad.
app.get("/blocks", (req, res) => {
  const lang = req.user.lang;
  const rows = db.prepare("SELECT * FROM sender_blocks ORDER BY id DESC").all();
  const trs = rows.map((b) => `<tr>
      <td>${esc(b.pattern)}</td><td>${esc(b.kind)}</td><td>${esc(b.added_by)}</td>
      <td class="muted">${esc(fmtDateTime(b.added_at, lang))}</td>
      <td>${b.work_item_id ? `<a href="/item/${b.work_item_id}">#${b.work_item_id}</a>` : ""}</td>
      <td><form method="post" action="/blocks/${b.id}/unblock"><button class="mini">${esc(t(lang, "unblock"))}</button></form></td>
    </tr>`).join("");
  res.send(page(t(lang, "blocks_title"), req.user, `
    <h2>${esc(t(lang, "blocks_title"))}</h2>
    <p class="muted">${esc(t(lang, "blocks_explain"))}</p>
    ${rows.length
      ? `<table><tr><th>${esc(t(lang, "col_sender_b"))}</th><th>${esc(t(lang, "col_kind_b"))}</th><th>${esc(t(lang, "col_by_b"))}</th><th>${esc(t(lang, "col_when_b"))}</th><th>${esc(t(lang, "col_item_b"))}</th><th></th></tr>${trs}</table>`
      : `<p class="muted">${esc(t(lang, "blocks_none"))}</p>`}`));
});

app.post("/blocks/:id/unblock", (req, res) => {
  const b = db.prepare("SELECT * FROM sender_blocks WHERE id = ?").get(req.params.id);
  if (b) {
    db.prepare("DELETE FROM sender_blocks WHERE id = ?").run(b.id);
    audit(req.user.tailscale_login, "sender_unblocked", b.work_item_id || null, `${b.pattern} (${b.kind})`);
  }
  res.redirect("/blocks");
});

// Audit log viewer (admin only). Searchable over the WHOLE table (not just the newest 500):
// free text runs a parameterised LIKE across user/action/detail (wildcards escaped, so input
// is matched literally), combinable with an action-type dropdown and a work-item filter.
// Results stay capped at the newest 500 matches. The search itself is audit-logged.
app.get("/audit", (req, res) => {
  if (req.user.role !== "admin") {
    audit(req.user.tailscale_login, "audit_denied", null, null);
    return res.status(403).send(page("Forbidden", req.user, "<p>Admins only.</p>"));
  }
  const q = String(req.query.q || "").trim().slice(0, 100);
  const act = String(req.query.action || "").trim().slice(0, 60);
  const item = parseInt(String(req.query.item || ""), 10) || 0;
  audit(req.user.tailscale_login, "view_audit", null,
    (q || act || item) ? `q=${q || "-"} action=${act || "-"} item=${item || "-"}` : null);

  const conds = [], params = [];
  if (q) {
    const like = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    conds.push("(user LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\' OR COALESCE(detail, '') LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  if (act) { conds.push("action = ?"); params.push(act); }
  if (item) { conds.push("work_item_id = ?"); params.push(item); }
  const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
  const rows = db.prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT 500`).all(...params);
  const actionNames = db.prepare("SELECT DISTINCT action FROM audit_log ORDER BY action").all().map((r) => r.action);

  const opts = ['<option value="">(any action)</option>']
    .concat(actionNames.map((a) => `<option value="${esc(a)}"${a === act ? " selected" : ""}>${esc(a)}</option>`)).join("");
  const form = `<form method="get" action="/audit" style="margin:0 0 10px;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
      <input name="q" value="${esc(q)}" placeholder="Search user, action or detail&hellip;" style="width:18em">
      <select name="action">${opts}</select>
      <input name="item" value="${item || ""}" inputmode="numeric" placeholder="Item #" style="width:6em">
      <button class="mini">Search</button>${(q || act || item) ? ` <a href="/audit">Clear</a>` : ""}
    </form>`;
  const trs = rows.map((r) => `<tr><td>${r.id}</td><td class="muted">${esc(r.ts)}</td><td>${esc(r.user)}</td><td>${esc(r.action)}</td><td>${r.work_item_id ? `<a href="/item/${r.work_item_id}">#${r.work_item_id}</a>` : ""}</td><td class="muted">${esc(r.detail || "")}</td></tr>`).join("");
  const note = (q || act || item)
    ? `${rows.length} match(es)${rows.length === 500 ? " — newest 500 shown, narrow the search for older entries" : ""}, newest first. Times are UTC.`
    : "Last 500 entries, newest first. Times are UTC.";
  res.send(page("Audit", req.user, `${form}<p class="muted">${esc(note)}</p><table><tr><th>#</th><th>When</th><th>User</th><th>Action</th><th>Item</th><th>Detail</th></tr>${trs}</table>`));
});

};
