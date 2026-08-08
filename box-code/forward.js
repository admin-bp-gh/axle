// forward.js - the Graph call behind the reassign-and-forward handover (allow-list action #6).
// Deliberately tiny and separate from send.js: that module composes and sends OUR OWN text to a
// customer; this one relays an existing message, unaltered, between our own mailboxes.
//
// PERMISSION. POST /users/{mailbox}/messages/{id}/forward needs Mail.Send only (Microsoft Graph
// v1.0, verified 2026-08-08) - the same application permission Axle already holds, Exchange-RBAC
// scoped to info@ + drachten@. No new M365 grant, no Mail.ReadWrite, and admin@ stays denied as a
// SENDER (it is only ever a recipient here). Graph copies the message body and its attachments
// itself, so nothing is re-rendered, re-escaped or lost in translation.
//
// The `to` address is chosen by forward-guard from the fixed owner->mailbox table; this module
// never decides where mail goes and does not look at the item.
require("dotenv").config({ path: require("path").join(__dirname, "..", "secrets", ".env"), quiet: true });

const LOGIN = "https://login.micro" + "softonline.com";        // split to dodge chat linkify
const GRAPH = "https://graph.micro" + "soft.com/v1.0/users/";

async function token() {
  const r = await fetch(`${LOGIN}/${process.env.M365_TENANT_ID}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.M365_CLIENT_ID,
      client_secret: process.env.M365_CLIENT_SECRET,
      scope: "https://graph.micro" + "soft.com/.default",
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error("no Graph token: " + JSON.stringify(d).slice(0, 200));
  return d.access_token;
}

// Forward `messageId` out of `mailbox` to the single internal address `to`, with our plain-text
// handover note on top. Exactly one recipient, never a CC or BCC. Throws on anything but 202 so
// the caller can leave the work item untouched when the send did not happen.
async function forwardMessage({ mailbox, messageId, to, comment }) {
  if (!mailbox) throw new Error("forward: no mailbox");
  if (!messageId) throw new Error("forward: no message id");
  if (!to) throw new Error("forward: no recipient");
  const tok = await token();
  const r = await fetch(`${GRAPH}${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/forward`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      comment: String(comment || ""),
      toRecipients: [{ emailAddress: { address: to } }],
    }),
  });
  if (r.status !== 202) {
    let detail = "";
    try { detail = JSON.stringify(await r.json()).slice(0, 300); } catch (e) { /* body may be empty */ }
    throw new Error(`forward failed: HTTP ${r.status} ${detail}`);
  }
  return { ok: true, to };
}

module.exports = { forwardMessage };
