// routes/sprocket.js — the Sprocket helper endpoint + the admin request-review view. Identity-gated
// like every route (the server's global middleware rejects any request without a registered tailnet
// identity), so Sprocket is reachable ONLY through the Axle UI over Tailscale — no external surface.
//
// READ-ONLY / LOG-ONLY: this reads the help doc + live allow-list and answers, and the ONLY thing it
// ever writes is Sprocket's own feature-request log (sprocket-store.js). No SAP/Shopify/email/MyParcel
// writes, no system action. All user input is UNTRUSTED data; sprocket.js fences it before the model
// sees it. Every ask, and every request logged, is audit-logged for Brad to review.
const Anthropic = require("@anthropic-ai/sdk");
const { db, audit } = require("../db.js");
const { esc, t, page, fmtDateTime } = require("../views/ui.js");
const SPROCKET = require("../sprocket.js");
const STORE = require("../sprocket-store.js");
const NOTIFY = require("../sprocket-notify.js");
const { MAILBOX_OF } = require("./shared.js");

// One client for the process, reusing the dedicated Axle org key from the box .env
// (ANTHROPIC_API_KEY) — same pattern as routes/shared.js.
const anthropic = new Anthropic();

// Parse the client-sent transcript safely into [{role:'you'|'bot', text}] (capped, validated).
function parseHistory(raw) {
  let arr;
  try { arr = JSON.parse(String(raw || "[]")); } catch (e) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.slice(-16).map((h) => ({
    role: h && h.role === "you" ? "you" : "bot",
    text: String((h && h.text) || "").slice(0, 2000),
  })).filter((h) => h.text);
}

module.exports = function mountSprocket(app) {

  // POST /sprocket/ask — body: q (the new message) + history (JSON transcript). Returns JSON
  // { answer, helpLoaded, saved }. When the model signals a confirmed request, we persist it to
  // the store (with de-dupe) and audit it — that is the only write.
  app.post("/sprocket/ask", async (req, res) => {
    const login = req.user.tailscale_login;
    const lang = req.user.lang;
    const q = String(req.body.q || "").trim();
    if (!q) return res.status(400).json({ error: "empty" });
    const history = parseHistory(req.body.history);

    try {
      // Give Sprocket the open requests so it can flag a semantic duplicate (dupe_of) at save time.
      const openRequests = STORE.loadRequests().filter((r) => STORE.OPEN.has(r.status)).map((r) => ({ id: r.id, goal: r.goal }));
      const out = await SPROCKET.converse(anthropic, { message: q, history, openRequests });
      let answer = out.text, saved = false;

      if (out.save && (out.save.goal || "").trim()) {
        // The original wish = the first user turn of the conversation (else the current message).
        const original = (history.find((h) => h.role === "you") || {}).text || q;
        const result = STORE.saveRequest({
          ...out.save, original_question: original, requester: req.user.display_name, language: lang,
        });
        saved = true;
        if (result.deduped) {
          audit(login, "sprocket_request_voted", null, `id=${result.id} votes=${result.votes} self=${!!result.selfDupe} goal="${String(out.save.goal).slice(0, 100)}"`);
          answer = answer + "\n\n" + t(lang, result.selfDupe ? "sprocket_dupe_note_self" : "sprocket_dupe_note");
        } else {
          audit(login, "sprocket_request_logged", null, `id=${result.id} goal="${String(out.save.goal).slice(0, 100)}"`);
        }

        // Notify Brad of genuinely NEW activity (a new request, or a cross-user +1) — async,
        // opt-in (AXLE_SPROCKET_NOTIFY) and best-effort, so a mail hiccup never affects the chat
        // reply. A self-dupe (the same person re-asking) adds nothing new, so it never notifies.
        const notifyKind = !result.deduped ? "new" : (result.selfDupe ? null : "vote");
        if (notifyKind && NOTIFY.NOTIFY_ON()) {
          const fromMailbox = process.env.AXLE_SPROCKET_NOTIFY_FROM || MAILBOX_OF.info;
          setImmediate(() => {
            NOTIFY.sendNotification(notifyKind, result.record, { fromMailbox })
              .then((res) => { if (res && res.sent) audit("system", "sprocket_notify_sent", null, `${notifyKind} ${result.id} -> ${res.to}`); })
              .catch((e) => audit("system", "sprocket_notify_failed", null, `${result.id}: ${String((e && e.message) || e).slice(0, 150)}`));
          });
        }
      } else {
        audit(login, "sprocket_ask", null,
          `q="${q.slice(0, 120)}" help=${out.helpLoaded ? "loaded" : "EMPTY"} ans=${answer.length}c${out.smuggle ? " smuggle=stripped" : ""}`);
      }
      res.json({ answer, helpLoaded: out.helpLoaded, saved });
    } catch (e) {
      audit(login, "sprocket_error", null, String((e && e.message) || e).slice(0, 200));
      res.status(502).json({ error: "Sprocket couldn't answer just now — please try again." });
    }
  });

  // GET /sprocket/requests — admin-only, READ-ONLY review of the captured feature requests, grouped
  // by status (open first), highest-voted first. The .jsonl/.md on the box stay the source of truth;
  // this is just a convenient on-screen view. No controls here (status/notes are edited in the files).
  app.get("/sprocket/requests", (req, res) => {
    if (req.user.role !== "admin") {
      audit(req.user.tailscale_login, "sprocket_requests_denied", null, null);
      return res.status(403).send(page("Forbidden", req.user, "<p>Admins only.</p>"));
    }
    const lang = req.user.lang;
    audit(req.user.tailscale_login, "view_sprocket_requests", null, null);
    const all = STORE.loadRequests();
    const order = STORE.STATUSES;
    const groups = order.map((st) => ({ st, rows: all.filter((r) => r.status === st).sort((a, b) => (b.votes || 1) - (a.votes || 1)) }))
      .filter((g) => g.rows.length);

    const field = (label, val) => val ? `<div class="sr-f"><span class="muted">${esc(label)}:</span> ${esc(val)}</div>` : "";
    const card = (r) => `<div class="box sr-card">
      <div class="sr-head"><b>${esc(r.id)}</b> — ${esc(r.goal || "(no goal)")} <span class="chip">${esc(String(r.votes || 1))} ${esc(t(lang, "sprocket_votes"))}</span></div>
      <div class="sr-meta muted">${esc(fmtDateTime(r.created, lang))} · ${esc(r.requester || "?")} · ${esc(r.language || "?")}</div>
      ${field(t(lang, "sprocket_f_today"), r.workaround_today)}
      ${field(t(lang, "sprocket_f_freq"), r.frequency)}
      ${field(t(lang, "sprocket_f_impact"), r.impact)}
      ${field(t(lang, "sprocket_f_example"), r.example)}
      ${r.also_requested_by && r.also_requested_by.length ? field(t(lang, "sprocket_f_also"), r.also_requested_by.join("; ")) : ""}
      ${r.original_question ? `<div class="sr-f muted">“${esc(r.original_question)}”</div>` : ""}
      ${r.notes ? field(t(lang, "sprocket_f_notes"), r.notes) : ""}
    </div>`;

    const body = groups.length
      ? groups.map((g) => `<h3>${esc(t(lang, "sprocket_status_" + g.st) || g.st)} <span class="muted">(${g.rows.length})</span></h3>${g.rows.map(card).join("")}`).join("")
      : `<p class="muted">${esc(t(lang, "sprocket_no_requests"))}</p>`;

    res.send(page(t(lang, "sprocket_requests_title"), req.user, `
      <h2>${esc(t(lang, "sprocket_requests_title"))}</h2>
      <p class="muted">${esc(t(lang, "sprocket_requests_hint"))}</p>
      ${body}`));
  });

};
