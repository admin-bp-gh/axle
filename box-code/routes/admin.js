// routes/admin.js - block-sender confirm + insert, the team blocklist page and the
// admin-only audit viewer. Extracted VERBATIM from server.js (UI rework Step 0,
// 2026-06-10).
const RESOLVE = require("../resolve-customer.js"); // read-only SAP-customer check on the block page
const OB = require("../outlook-block.js");        // Outlook-side filing of blocked senders (action #7)
const { db, audit } = require("../db.js");
const { esc, t, page, fmtDateTime } = require("../views/ui.js");
const { markReadSafe } = require("./shared.js");

module.exports = function mountAdmin(app) {

// ---- Block sender (Axle-only suppression, reversible) -------------------------------------
// GET = a confirm page showing the ONE address that will be blocked, with a SAP-customer check so
// a real customer isn't blocked by accident. POST = insert the block, archive this item
// (resolution no_action) and mark the inbound read. The pattern is derived in code from the
// item's STORED sender address - never from typed input. Blocks are global (info@ +
// drachten@); the mail still arrives in Outlook (no mailbox write). Everything is audited.
//
// Single addresses ONLY since 2026-07-27 — see the POST handler for why the whole-domain option
// was removed.
app.get("/item/:id/block", async (req, res) => {
  const lang = req.user.lang;
  const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(req.params.id);
  if (!w) return res.status(404).send(page("Not found", req.user, `<p>${esc(t(lang, "not_found"))}</p>`));
  if (w.origin === "compose") return res.redirect("/item/" + w.id);
  const addr = String(w.sender_email || "").trim().toLowerCase();
  const domain = addr.split("@")[1] || "";
  if (!addr || !domain) return res.redirect("/item/" + w.id);
  // Never offer to block ourselves. With the Outlook rule live (action #7) a block on one of our
  // own domains would file our own internal mail — including action #6's cross-mailbox handover
  // forwards — out of the inbox. Cheap guard, catastrophic omission.
  if (OB.isInternal(addr)) return res.redirect("/item/" + w.id);

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
      <p class="muted">${esc(t(lang, OB.active() ? "block_explain_outlook" : "block_explain"))}</p>
      ${sapNote}
      <form method="post" action="/item/${w.id}/block">
        <p><b>${esc(t(lang, "block_addr_opt"))}:</b> ${esc(addr)}</p>
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
  // Whole-domain blocking was REMOVED on 2026-07-27 (Brad's call). Two mis-clicks on the old
  // "the whole domain" option — '@gmail.com' and '@shopify.com' — silently swallowed 13 days of
  // consumer customer email and 4 weeks of webshop contact-form messages, with no trace anywhere
  // anyone looks. The blast radius of the option was wildly out of proportion to its usefulness,
  // so only single addresses can be blocked now. `kind` is no longer read from the request at all.
  //
  // Pre-existing domain rows still MATCH in isBlockedSender (they are all legitimate
  // single-organisation domains — marketing senders, spam domains); they simply cannot be created
  // any more, and remain removable on the Blocked page.
  const kind = "address";
  const pattern = addr.slice(0, 200);
  if (OB.isInternal(pattern)) return res.redirect("/item/" + w.id);   // mirrors the GET guard
  db.prepare("INSERT OR IGNORE INTO sender_blocks (pattern, kind, reason, added_by, work_item_id) VALUES (?, ?, 'unwanted sender', ?, ?)")
    .run(pattern, kind, req.user.tailscale_login, w.id);
  db.prepare("UPDATE work_items SET status = 'archived', resolution = 'no_action', updated_at = datetime('now') WHERE id = ?").run(w.id);
  audit(req.user.tailscale_login, "sender_blocked", w.id, `${pattern} (${kind})`);
  await markReadSafe(req.user.tailscale_login, w);
  // Outlook side (action #7): rebuild the inbox rule from the table, then sweep this sender's mail
  // already in the inbox into the "Axle Blocked" folder. DB first, mailbox second, and applyBlock
  // never throws — a Graph failure is audited and leaves the Axle-side block standing rather than
  // failing the whole action in the user's face.
  await OB.applyBlock(req.user.tailscale_login, pattern, w.id);
  res.redirect("/");
});

// Blocklist viewer: visible to the whole team, unblock allowed for anyone (audited), so a
// mistake is fixable on the spot without waiting for Brad.
app.get("/blocks", async (req, res) => {
  const lang = req.user.lang;
  const rows = db.prepare("SELECT * FROM sender_blocks ORDER BY id DESC").all();

  // Outlook-side status panel. Says plainly whether blocked mail is actually being filed, and how
  // much has been - the antidote to the 2026-07-27 incident, where suppression was invisible.
  // Best effort: any Graph trouble degrades to a note, never a broken page.
  let olPanel = "";
  try {
    const st = await OB.status();
    if (!st.enabled && !st.dry) {
      olPanel = `<p class="muted"><b>${esc(t(lang, "blocks_ol_status"))}:</b> ${esc(t(lang, "blocks_ol_off"))}</p>`;
    } else {
      const bits = st.boxes.map((b) => {
        const state = b.error ? esc(b.error)
          : b.rule === "missing" ? esc(t(lang, "blocks_ol_missing"))
          : `${esc(t(lang, st.dry ? "blocks_ol_dry" : "blocks_ol_on"))} &middot; ${b.count == null ? "?" : b.count} ${esc(t(lang, "blocks_ol_msgs"))}`;
        const when = b.syncedAt ? esc(fmtDateTime(b.syncedAt, lang)) : esc(t(lang, "blocks_ol_never"));
        return `<li>${esc(b.mailbox)} &mdash; ${state} <span class="muted">(${when})</span></li>`;
      }).join("");
      olPanel = `<div class="box"><p><b>${esc(t(lang, "blocks_ol_status"))}</b></p><ul>${bits}</ul></div>`;
    }
  } catch (e) { olPanel = ""; }
  const trs = rows.map((b) => `<tr>
      <td>${esc(b.pattern)}</td><td>${esc(b.kind)}</td><td>${esc(b.added_by)}</td>
      <td class="muted">${esc(fmtDateTime(b.added_at, lang))}</td>
      <td>${b.work_item_id ? `<a href="/item/${b.work_item_id}">#${b.work_item_id}</a>` : ""}</td>
      <td><form method="post" action="/blocks/${b.id}/unblock"><button class="mini">${esc(t(lang, "unblock"))}</button></form></td>
    </tr>`).join("");
  res.send(page(t(lang, "blocks_title"), req.user, `
    <h2>${esc(t(lang, "blocks_title"))}</h2>
    <p class="muted">${esc(t(lang, OB.active() ? "blocks_explain_outlook" : "blocks_explain"))}</p>
    ${olPanel}
    ${rows.length
      ? `<table><tr><th>${esc(t(lang, "col_sender_b"))}</th><th>${esc(t(lang, "col_kind_b"))}</th><th>${esc(t(lang, "col_by_b"))}</th><th>${esc(t(lang, "col_when_b"))}</th><th>${esc(t(lang, "col_item_b"))}</th><th></th></tr>${trs}</table>`
      : `<p class="muted">${esc(t(lang, "blocks_none"))}</p>`}`));
});

app.post("/blocks/:id/unblock", async (req, res) => {
  const b = db.prepare("SELECT * FROM sender_blocks WHERE id = ?").get(req.params.id);
  if (b) {
    db.prepare("DELETE FROM sender_blocks WHERE id = ?").run(b.id);
    audit(req.user.tailscale_login, "sender_unblocked", b.work_item_id || null, `${b.pattern} (${b.kind})`);
    // Rebuild the rule without this pattern and move the sender's filed mail back to the inbox.
    // Unblocking is the fix-a-mistake path, so it has to undo the visible effect, not just the row.
    await OB.applyUnblock(req.user.tailscale_login, b.kind === "address" ? b.pattern : null, b.work_item_id || null);
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
