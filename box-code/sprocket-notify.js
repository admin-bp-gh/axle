// sprocket-notify.js — emails Brad when Sprocket logs a new feature request (or an existing one
// gains a cross-user +1). Opt-in and least-privilege: OFF unless AXLE_SPROCKET_NOTIFY=on; the
// recipient is a fixed, code-held address (never derived from the request text); the mail is sent
// through Axle's existing Graph sender (send.js) from an authorised mailbox. Best-effort: the
// caller fires it async after replying, so a mail hiccup never affects the Sprocket chat.
//
// Safety: every request field is HTML-escaped into the body (so a request that contains markup or
// a link can't render as anything but text) and the subject is newline-stripped + length-capped.
const SEND = require("./send.js");

const NOTIFY_ON = () => process.env.AXLE_SPROCKET_NOTIFY === "on";
const RECIPIENT = () => (process.env.AXLE_SPROCKET_NOTIFY_TO || "admin@budget-parts.nl").trim();
const BASE_URL = () => (process.env.AXLE_BASE_URL || "https://axle-box.tail58a804.ts.net");

const clean = (s) => String(s == null ? "" : s);
const esc = (s) => clean(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const subjLine = (s) => clean(s).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);

// Pure: build the {subject, html} for a notification. kind = 'new' | 'vote'.
function buildNotificationEmail(kind, record, opts = {}) {
  const r = record || {};
  const link = (opts.baseUrl || BASE_URL()).replace(/\/+$/, "") + "/sprocket/requests";
  const isVote = kind === "vote";
  const goal = subjLine(r.goal) || "(no goal)";
  const subject = subjLine(isVote
    ? `Axle: feature request gaining traction — ${goal}`
    : `Axle: new feature request — ${goal}`);

  const row = (label, val) => val ? `<tr><td style="padding:2px 12px 2px 0;color:#616161;vertical-align:top;white-space:nowrap">${esc(label)}</td><td style="padding:2px 0">${esc(val)}</td></tr>` : "";
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;font-size:14px;line-height:1.5;color:#303030">` +
    `<p>${isVote
      ? "Someone else has asked for an existing request, so it's gaining traction:"
      : "Sprocket just logged a new feature request from the team:"}</p>` +
    `<table style="border-collapse:collapse;margin:8px 0">` +
    row("Request", `${r.id || "?"} — ${clean(r.goal)}`) +
    row("From", r.requester) +
    (isVote ? row("Votes", String(r.votes || 1)) : "") +
    row("Today", r.workaround_today) +
    row("Frequency", r.frequency) +
    row("Impact", r.impact) +
    row("Example", r.example) +
    row("Their words", r.original_question) +
    `</table>` +
    `<p><a href="${esc(link)}">Review all requests in Axle</a></p>` +
    `<p style="color:#8a8a8a;font-size:12px">You're getting this because Sprocket notifications are on (AXLE_SPROCKET_NOTIFY).</p>` +
    `</div>`;
  return { subject, html };
}

// Side-effecting: send the notification (no-op when disabled). Returns a small result object;
// throws on a hard send failure so the caller can audit it. Never call this on a self-dupe.
async function sendNotification(kind, record, opts = {}) {
  if (!NOTIFY_ON()) return { skipped: true, reason: "disabled" };
  const from = opts.fromMailbox;
  if (!from) return { skipped: true, reason: "no from mailbox" };
  const to = RECIPIENT();
  const { subject, html } = buildNotificationEmail(kind, record, opts);
  await SEND.sendReply({ mailbox: from, originalMessageId: null, to, subject, html });
  return { sent: true, to, subject };
}

module.exports = { buildNotificationEmail, sendNotification, NOTIFY_ON, RECIPIENT, BASE_URL };
