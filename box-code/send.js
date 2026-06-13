// send.js - the ONLY module in Axle that sends email. Kept separate from the read-only
// connectors so the read/write split stays clear. Uses Mail.Send only (no Mail.ReadWrite):
// it sends via Graph sendMail with our verbatim HTML body, the recipient hard-locked by the
// caller (send-guard), and proper threading via In-Reply-To / References Internet headers
// set as MAPI extended properties (PidTagInReplyToId 0x1042, PidTagInternetReferences
// 0x1039) copied from the original message's internetMessageId. No draft is created or
// modified in the mailbox, so Mail.Send is sufficient.
require("dotenv").config({ path: "C:\\Axle\\secrets\\.env", quiet: true });

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

// RFC Message-ID of the email we're replying to (for threading). Read-only; best effort.
async function internetMessageId(tok, mailbox, msgId) {
  try {
    const r = await fetch(`${GRAPH}${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(msgId)}?$select=internetMessageId`,
      { headers: { Authorization: `Bearer ${tok}` } });
    const d = await r.json();
    return d && d.internetMessageId ? d.internetMessageId : null;
  } catch { return null; }
}

// Best-effort capture of the sent message's Graph id from Sent Items (for the audit log).
async function findSentId(tok, mailbox, subject, to) {
  try {
    const r = await fetch(`${GRAPH}${encodeURIComponent(mailbox)}/mailFolders/sentitems/messages?$top=5&$orderby=sentDateTime desc&$select=id,subject,toRecipients,sentDateTime`,
      { headers: { Authorization: `Bearer ${tok}` } });
    const d = await r.json();
    const hit = (d.value || []).find((m) =>
      (m.subject || "") === subject &&
      (m.toRecipients || []).some((t) => t.emailAddress && String(t.emailAddress.address || "").toLowerCase() === to));
    return hit ? hit.id : null;
  } catch { return null; }
}

// Send the reply. `to` is already locked to the customer by send-guard; we set it as the
// sole recipient and send no CC/BCC. `html` is the safe HTML from send-guard (verbatim).
// `attachments` (optional) is [{name, contentType, contentBytes(base64)}] - sent as Graph
// fileAttachments inline (no upload session, so keep the total well under ~3 MB).
async function sendReply({ mailbox, originalMessageId, to, subject, html, attachments }) {
  if (!mailbox) throw new Error("send: no mailbox");
  if (!to) throw new Error("send: no recipient");
  const tok = await token();
  const imid = originalMessageId ? await internetMessageId(tok, mailbox, originalMessageId) : null;

  const message = {
    subject,
    body: { contentType: "HTML", content: html },
    toRecipients: [{ emailAddress: { address: to } }],
    ccRecipients: [],
    bccRecipients: [],
  };
  if (Array.isArray(attachments) && attachments.length) {
    // An attachment with a contentId (set by the caller from send-guard's validated inline
    // tokens) is sent as an INLINE cid attachment referenced by an <img> in the HTML body;
    // all others remain regular attachments. Both kinds count toward the same size budget.
    message.attachments = attachments.map((a) => {
      const entry = {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: a.name,
        contentType: a.contentType || "application/octet-stream",
        contentBytes: a.contentBytes,
      };
      if (a.contentId) { entry.isInline = true; entry.contentId = a.contentId; }
      return entry;
    });
  }
  if (imid) {
    message.singleValueExtendedProperties = [
      { id: "String 0x1042", value: imid },   // In-Reply-To
      { id: "String 0x1039", value: imid },   // References
    ];
  }

  const r = await fetch(`${GRAPH}${encodeURIComponent(mailbox)}/sendMail`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  if (r.status !== 202) {
    let detail = "";
    try { detail = JSON.stringify(await r.json()).slice(0, 300); } catch {}
    throw new Error(`sendMail failed: HTTP ${r.status} ${detail}`);
  }
  const sentId = await findSentId(tok, mailbox, subject, to);
  return { ok: true, threaded: Boolean(imid), sentId };
}

// Mark an inbound message read in the shared mailbox. Requires Mail.ReadWrite (scoped) -
// there is no granular "mark read" permission. Returns {ok:false,reason} (never throws) so
// callers degrade gracefully when the permission isn't granted.
async function markRead(mailbox, messageId) {
  if (!mailbox || !messageId) return { ok: false, reason: "missing mailbox/messageId" };
  try {
    const tok = await token();
    const r = await fetch(`${GRAPH}${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ isRead: true }),
    });
    if (r.status >= 200 && r.status < 300) return { ok: true };
    let detail = "";
    try { detail = JSON.stringify(await r.json()).slice(0, 200); } catch {}
    return { ok: false, reason: `HTTP ${r.status} ${detail}` };
  } catch (e) {
    return { ok: false, reason: e.message.slice(0, 150) };
  }
}

module.exports = { sendReply, markRead };
