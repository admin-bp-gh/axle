// send.js - the ONLY module in Axle that sends email. Kept separate from the read-only
// connectors so the read/write split stays clear. A reply is sent in two steps: the message is
// created in the mailbox's Drafts with our verbatim HTML body, the recipient hard-locked by the
// caller (send-guard), and proper threading via In-Reply-To / References Internet headers set as
// MAPI extended properties (PidTagInReplyToId 0x1042, PidTagInternetReferences 0x1039) copied from
// the original message's internetMessageId; then that draft is sent. Every call uses Graph
// immutable ids (Prefer: IdType="ImmutableId"), so the id we get back stays the same when Exchange
// moves the message to Sent Items. That id is what send-verify.js checks afterwards.
//
// Why two steps and not sendMail (15 Oct 2026): sendMail answers 202 the moment Exchange accepts
// the job, before it is sent. Now and then Exchange accepts it and never sends it: the message sits
// in Drafts and no error ever reaches us (the reply to Pere Garriga, item 2709). With the draft's
// own id in hand, send-verify.js can see that, send it again, and tell the user.
// Needs Mail.ReadWrite (already granted for markRead) as well as Mail.Send.
require("dotenv").config({ path: require("path").join(__dirname, "..", "secrets", ".env"), quiet: true });

const LOGIN = "https://login.micro" + "softonline.com";        // split to dodge chat linkify
const GRAPH = "https://graph.micro" + "soft.com/v1.0/users/";
const IMMUTABLE = { Prefer: 'IdType="ImmutableId"' };

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

// Send the reply. `to` is already locked to the customer by send-guard; we set it as the
// sole To. `cc` is the item's Cc as send-guard screened it (round 2); never any BCC. `html` is the safe HTML from send-guard (verbatim).
// `attachments` (optional) is [{name, contentType, contentBytes(base64)}] - sent as Graph
// fileAttachments inline (no upload session, so keep the total well under ~3 MB).
async function sendReply({ mailbox, originalMessageId, to, cc, subject, html, attachments }) {
  if (!mailbox) throw new Error("send: no mailbox");
  if (!to) throw new Error("send: no recipient");
  const tok = await token();
  const imid = originalMessageId ? await internetMessageId(tok, mailbox, originalMessageId) : null;

  const message = {
    subject,
    body: { contentType: "HTML", content: html },
    toRecipients: [{ emailAddress: { address: to } }],
    ccRecipients: (cc || []).map((address) => ({ emailAddress: { address } })),
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

  const base = `${GRAPH}${encodeURIComponent(mailbox)}/messages`;
  const c = await fetch(base, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json", ...IMMUTABLE },
    body: JSON.stringify(message),
  });
  const draft = await c.json().catch(() => null);
  if (c.status !== 201 || !draft || !draft.id) {
    throw new Error(`create draft failed: HTTP ${c.status} ${JSON.stringify((draft && draft.error) || {}).slice(0, 300)}`);
  }
  try {
    await sendDraft(mailbox, draft.id, tok);
  } catch (e) {
    // Nothing went out: remove our draft so a retry from Axle starts clean. Best effort.
    await fetch(`${base}/${encodeURIComponent(draft.id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${tok}`, ...IMMUTABLE } }).catch(() => {});
    throw e;
  }
  return { ok: true, threaded: Boolean(imid), messageId: draft.id };
}

// Send a draft that already exists (the second step of sendReply, and send-verify's retry of a
// message Exchange left in Drafts). Throws on anything but 202; e.status carries the HTTP status.
async function sendDraft(mailbox, messageId, tok) {
  tok = tok || await token();
  const r = await fetch(`${GRAPH}${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/send`, {
    method: "POST",
    headers: { Authorization: `Bearer ${tok}`, ...IMMUTABLE },
  });
  if (r.status !== 202) {
    let detail = "";
    try { detail = JSON.stringify(await r.json()).slice(0, 300); } catch {}
    const e = new Error(`send failed: HTTP ${r.status} ${detail}`);
    e.status = r.status;
    throw e;
  }
}

// Where a message we sent is now: { sent: true } once it has left Drafts as a sent message,
// { inDrafts: true } while Exchange still holds it there unsent, { gone: true } when it was deleted
// or moved out of Drafts unsent. Throws on a Graph fault, so the caller just tries again next run.
const draftsFolderId = new Map();   // mailbox -> the Drafts folder's immutable id
async function messageState(mailbox, messageId) {
  const tok = await token();
  const h = { Authorization: `Bearer ${tok}`, ...IMMUTABLE };
  const mb = encodeURIComponent(mailbox);
  if (!draftsFolderId.has(mailbox)) {
    const f = await fetch(`${GRAPH}${mb}/mailFolders/drafts?$select=id`, { headers: h });
    const fd = await f.json().catch(() => null);
    if (!f.ok || !fd || !fd.id) throw new Error(`drafts folder lookup failed: HTTP ${f.status}`);
    draftsFolderId.set(mailbox, fd.id);
  }
  const r = await fetch(`${GRAPH}${mb}/messages/${encodeURIComponent(messageId)}?$select=isDraft,parentFolderId`, { headers: h });
  if (r.status === 404) return { gone: true };
  const d = await r.json().catch(() => null);
  if (!r.ok || !d) throw new Error(`message lookup failed: HTTP ${r.status}`);
  if (!d.isDraft) return { sent: true };
  return d.parentFolderId === draftsFolderId.get(mailbox) ? { inDrafts: true } : { gone: true };
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

// Every message in an inbound message's Outlook conversation. Read-only, and it exists for one
// caller: markReadSafe, so closing an item can mark the WHOLE thread read rather than only its
// newest mail (item #1308). It lives here rather than in connectors.js because it is part of the
// mark-read write path and shares its permission (Mail.ReadWrite) and its degrade-gracefully
// contract - returns {ok:false, reason}, never throws.
//
// Two calls: the conversationId of the message we know, then the conversation. The isRead filter
// is applied CLIENT-side - a $filter combining conversationId and isRead is the kind of mixed
// filter Graph is fussy about, and the payload is tiny either way ($select of five scalars,
// capped at MAX_CONVERSATION). Not folder-scoped: a thread member sitting unread in Archive or
// Deleted Items is still part of a handled conversation, and our own sent replies are read
// already, so they never reach the caller.
const MAX_CONVERSATION = 50;

async function conversationMessages(mailbox, messageId, opts = {}) {
  if (!mailbox || !messageId) return { ok: false, reason: "missing mailbox/messageId" };
  try {
    const tok = await token();
    const head = await fetch(
      `${GRAPH}${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}?$select=conversationId`,
      { headers: { Authorization: `Bearer ${tok}` } });
    const h = await head.json().catch(() => null);
    if (!h || !h.conversationId) return { ok: false, reason: `no conversationId (HTTP ${head.status})` };

    const cid = String(h.conversationId).replace(/'/g, "''");   // OData string escape
    const filter = encodeURIComponent(`conversationId eq '${cid}'`);
    const r = await fetch(
      `${GRAPH}${encodeURIComponent(mailbox)}/messages?$filter=${filter}` +
      `&$select=id,conversationId,subject,from,isRead&$top=${MAX_CONVERSATION}`,
      { headers: { Authorization: `Bearer ${tok}` } });
    const d = await r.json().catch(() => null);
    if (!r.ok || !d || !Array.isArray(d.value)) {
      return { ok: false, reason: `HTTP ${r.status} ${JSON.stringify((d && d.error) || {}).slice(0, 200)}` };
    }
    const messages = d.value
      .filter((m) => (opts.unreadOnly ? m.isRead === false : true))
      .map((m) => ({
        id: m.id,
        conversationId: m.conversationId,
        subject: m.subject || "",
        from: (m.from && m.from.emailAddress) || { address: "unknown", name: "unknown" },
        isRead: Boolean(m.isRead),
      }));
    return { ok: true, messages };
  } catch (e) {
    return { ok: false, reason: e.message.slice(0, 150) };
  }
}

module.exports = { sendReply, sendDraft, messageState, markRead, conversationMessages };
