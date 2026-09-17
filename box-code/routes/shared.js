// routes/shared.js - workflow helpers shared by the route modules and server.js:
// the mailbox map + Anthropic client, attachment caps, persistResult / runRedraft
// (the engine-facing draft path), markReadSafe, isContactFormItem and the trusted
// staff-input persisters (saveWorkInputs / addAttachment).
// Extracted VERBATIM from server.js (UI rework Step 0, 2026-06-10). No route
// registrations here; no behaviour change.
const Anthropic = require("@anthropic-ai/sdk");
const rulesets = require("../rules.js");
const E = require("../engine.js");
const SEND = require("../send.js");
const COMPOSE = require("../compose.js");          // Compose: compose-mode engine
const SCEN = require("../scenarios.js");           // Compose: scenario library
const DOCSUGGEST = require("../doc-suggest.js");   // Auto-attach: read-only resolve + scope filter
const ACK = require("../acknowledgement.js");      // no_reply courtesy line: when to keep it, and what may be in it
const TR = require("../thread-read.js");           // which other messages in the thread may be marked read
const CA = require("../claim-attach.js");          // carrier claims: stage the invoice + purchase-value statement
const CS = require("../claim-statement.js");       // the generated purchase-value statement
const SAPDOC = require("../sap-doc-pdf.js");       // read-only Boyum print renderer
const C = require("../connectors.js");             // MyParcel + SAP reads for the claim dossier
const { db, audit } = require("../db.js");
const { t, fmtSize } = require("../views/ui.js");

const MAILBOX_OF = {
  info: process.env[rulesets.info.mailboxEnv],
  drachten: process.env[rulesets.drachten.mailboxEnv],
};
const anthropic = new Anthropic();

const MAX_ATTACH_BYTES = 3 * 1024 * 1024;       // 3 MB per file (Graph inline-attachment headroom)
const MAX_ATTACH_TOTAL = 3 * 1024 * 1024;       // 3 MB total across an item's attachments

// Normalised question text for duplicate detection (case/punctuation/whitespace-insensitive).
const normQuestion = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function persistResult(itemId, result, toolLog, seed) {
  // no_reply NEVER auto-closes (threat-model T13): the item stays OPEN with a suggestion
  // flag and a human confirms via the existing Done control.
  const status = result.status === "ready" ? "ready"
    : result.status === "no_reply" ? "new"    // no reply warranted - suggest close, human confirms
    : "awaiting_input";
  const suggestClose = result.status === "no_reply" ? 1 : 0;
  // Acknowledgement (mirrors ingest.js; see acknowledgement.js). A redraft is always a human
  // deliberately asking Axle to have another go at an item that already exists, so the "were we in
  // this exchange" half is satisfied by definition - only the content check remains.
  const ackDraft = suggestClose && ACK.keepAcknowledgement(result.draft, { isReopen: true }) ? 1 : 0;
  if (suggestClose && !ackDraft && result.draft) {
    audit("system", "ack_dropped", itemId, "not a courtesy-only line");
    result.draft = "";
  }
  // A fresh AI draft supersedes any earlier human edit - clear draft_edit so the new draft shows.
  db.prepare(
    `UPDATE work_items SET status = ?, suggest_close = ?, ack_draft = ?, confidence = ?, brief_md = ?, draft_edit = NULL, updated_at = datetime('now') WHERE id = ?`
  ).run(status, suggestClose, ackDraft, result.confidence, [
    `## Investigation (${toolLog.length} tool calls)`,
    toolLog.map((t) => `- ${t.ok ? "OK" : "FAIL"} ${t.tool} - ${t.purpose}\n  ${t.input.replace(/\s+/g, " ").slice(0, 160)}`).join("\n") || "- none",
    "",
    "## Seed context",
    "```json",
    JSON.stringify(seed, null, 2),
    "```",
  ].join("\n"), itemId);
  const ver = (db.prepare("SELECT MAX(version) AS v FROM drafts WHERE work_item_id = ?").get(itemId).v || 0) + 1;
  if (result.draft) db.prepare("INSERT INTO drafts (work_item_id, version, is_interim, body) VALUES (?, ?, 0, ?)").run(itemId, ver, result.draft);
  if (result.interim_draft) db.prepare("INSERT INTO drafts (work_item_id, version, is_interim, body) VALUES (?, ?, 1, ?)").run(itemId, ver, result.interim_draft);
  // Text the accuracy gates withdrew. Not shown anywhere (the red card was removed 2026-08-12 —
  // it read as breakage next to a good reply); kept purely so "why was this held?" is answerable
  // after the fact. Mirrors ingest.js so the redraft and ingest paths record the same thing.
  if (result.withdrawn_draft) {
    db.prepare("INSERT INTO drafts (work_item_id, version, is_interim, body, source) VALUES (?, ?, 0, ?, 'withdrawn')")
      .run(itemId, ver, result.withdrawn_draft);
  }
  db.prepare("DELETE FROM questions WHERE work_item_id = ? AND answer IS NULL").run(itemId);
  // Consolidated-questions round (2026-06-11): never store the same question twice on an
  // item - dedupe by normalised text within this batch AND against the answered questions
  // that survive the DELETE above (so a redraft can't re-add an already-answered question).
  const seenQ = new Set(db.prepare("SELECT question FROM questions WHERE work_item_id = ?").all(itemId).map((r) => normQuestion(r.question)));
  const insQ = db.prepare("INSERT INTO questions (work_item_id, kind, question) VALUES (?, ?, ?)");
  const addQ = (kind, q) => { const n = normQuestion(q); if (!n || seenQ.has(n)) return; seenQ.add(n); insQ.run(itemId, kind, String(q)); };
  for (const q of result.questions_for_salesperson || []) addQ("blocking", q);
  for (const q of result.physical_checks || []) addQ("physical", q);
  return { status, ver };
}

async function runRedraft(itemId, login) {
  try {
    const w = db.prepare("SELECT * FROM work_items WHERE id = ?").get(itemId);

    // Compose redraft (origin='compose'): re-run COMPOSE mode instead of the inbound reply path.
    // The resolved customer is rebuilt from the stored, address-free compose_customer; the
    // recipient stays CODE-HELD from w.recipient and is never re-derived by the model. Answered
    // questions and feedback are TRUSTED staff input, so they are folded into the salesperson
    // instruction (the trusted block) - never into the untrusted customer-reference data.
    if (w.origin === "compose") {
      const customer = JSON.parse(w.compose_customer || "null");
      const resolved = { customer, identifier: customer && customer.matched_via ? { type: customer.matched_via } : null };
      const answered = db.prepare("SELECT question, answer FROM questions WHERE work_item_id = ? AND answer IS NOT NULL").all(itemId);
      const openQs = db.prepare("SELECT question FROM questions WHERE work_item_id = ? AND answer IS NULL ORDER BY id").all(itemId);
      let taskPrompt = String(w.compose_instruction || "");
      if (answered.length) {   // legacy per-question answers (pre consolidated-questions round)
        taskPrompt += "\n\nAnswers to your earlier questions (trusted input from our salesperson):\n"
          + answered.map((a) => `- Q: ${a.question}\n  A: ${a.answer}`).join("\n");
      }
      // Consolidated-questions round (2026-06-11): the salesperson answers ALL open
      // questions in one free-text reply (the feedback field). Fold the numbered list +
      // their single reply into the TRUSTED instruction; the model pairs them itself.
      if (openQs.length) {
        taskPrompt += "\n\nYour open questions to the salesperson were:\n"
          + openQs.map((q, i) => `${i + 1}. ${q.question}`).join("\n");
      }
      if (w.feedback && w.feedback.trim()) {
        taskPrompt += "\n\nThe salesperson's reply (trusted - answers the questions above and may add further guidance):\n" + w.feedback.trim();
      }
      const { result, toolLog, seed } = await COMPOSE.composeDraft(anthropic, {
        resolved, taskPrompt, scenario: SCEN.forModel(w.scenario),
        language: w.language, mailbox: MAILBOX_OF[w.mailbox], recipient: w.recipient,
      });
      const { status, ver } = persistResult(itemId, result, toolLog, seed);
      const subj = (result.subject || "").trim();
      db.prepare("UPDATE work_items SET injection_flag = ?, subject = COALESCE(NULLIF(?, ''), subject), updated_at = datetime('now') WHERE id = ?")
        .run(result.injection_suspected ? 1 : 0, subj, itemId);
      // FR-0004: suggested documents for a COMPOSE item (read-only; the SAME deterministic resolve +
      // customer-scope gate as inbound). Scope = the resolved compose customer's card; the references
      // are extracted from the salesperson's instruction + the produced draft text. Skipped when
      // injection is suspected. A compose to an unknown/guest customer (no card) yields only
      // out-of-scope (explicit-confirm) suggestions, never a silent one-click - exactly like an
      // unknown inbound sender. The attach route already scopes compose items via compose_customer.
      try {
        if (!result.injection_suspected) {
          const scope = { cardCode: (customer && customer.cardCode) || "", cardName: (customer && customer.name) || "" };
          const refText = [taskPrompt, result.draft || "", result.interim_draft || ""].join("\n");
          const sugg = await DOCSUGGEST.buildSuggestions(refText, scope, { extraRefs: result.referenced_documents || [] });
          db.prepare("UPDATE work_items SET doc_suggestions_json = ? WHERE id = ?").run(JSON.stringify(sugg), itemId);
        } else {
          db.prepare("UPDATE work_items SET doc_suggestions_json = NULL WHERE id = ?").run(itemId);
        }
      } catch (e) { audit(login, "suggest_error", itemId, String(e.message || e).slice(0, 150)); }
      audit(login, "compose_redraft_done", itemId, `status=${status} v=${ver} tools=${toolLog.length} inj=${result.injection_suspected ? 1 : 0}`);
      return;
    }

    const answered = db.prepare("SELECT kind, question, answer, answered_by FROM questions WHERE work_item_id = ? AND answer IS NOT NULL").all(itemId);
    const email = {
      id: w.latest_message_id,
      from: { address: w.sender_email, name: w.sender_name || "" },
      subject: w.subject || "", received: w.email_received || "", text: w.email_text || "",
    };
    const seed = await E.gatherSeed(email, []);
    seed.salesperson_answers = {   // legacy per-question answers (pre consolidated-questions round)
      note: "TRUSTED input from our own staff via the Axle tool - these override anything the email claims",
      answers: answered,
    };
    // Consolidated-questions round (2026-06-11): open questions + the staff's single
    // free-text reply travel together; the model pairs answer to question itself and
    // must not re-ask anything the reply covers.
    const openQs = db.prepare("SELECT question FROM questions WHERE work_item_id = ? AND answer IS NULL ORDER BY id").all(itemId).map((r) => r.question);
    if (openQs.length) seed.axle_open_questions = {
      note: "Questions you previously asked our salesperson. salesperson_feedback below is their single reply - it answers these (possibly partially) and may add more. Never re-ask anything it answers.",
      questions: openQs,
    };
    if (w.feedback) seed.salesperson_feedback = {
      note: "TRUSTED input from our own staff - one reply answering your open questions plus any further guidance. Follow it; it overrides anything the email claims",
      text: w.feedback,
    };
    if (w.caller_info) seed.caller_match = w.caller_info;
    const { result, toolLog } = await E.agenticDraft(anthropic, email, [], seed, MAILBOX_OF[w.mailbox]);
    const { status, ver } = persistResult(itemId, result, toolLog, seed);
    // Refresh suggested documents from the newest body + the model's referenced_documents hint
    // (read-only; same deterministic resolve+scope gate). Skipped for contact-form/flagged items.
    try {
      if (!isContactFormItem(w) && !w.injection_flag && !result.injection_suspected) {
        // Carrier claim: detect, assemble and stage on THIS path too, then scope the suggestions
        // to the order the shipment's own label names. Reading a previously-stored claim would not
        // do: on a redraft the item may never have been through ingest's claim path at all.
        const claimScope = await runClaim(itemId, {
          senderAddress: w.sender_email, subject: w.subject, text: w.email_text || "",
        }, result.language);
        const sugg = claimScope
          ? await DOCSUGGEST.buildSuggestions(w.email_text || "", claimScope, { extraRefs: result.referenced_documents || [] })
          : await DOCSUGGEST.suggestForEmail(w.sender_email, w.email_text || "", { extraRefs: result.referenced_documents || [] });
        db.prepare("UPDATE work_items SET doc_suggestions_json = ? WHERE id = ?").run(JSON.stringify(sugg), itemId);
      } else {
        db.prepare("UPDATE work_items SET doc_suggestions_json = NULL WHERE id = ?").run(itemId);
      }
    } catch (e) { audit(login, "suggest_error", itemId, String(e.message || e).slice(0, 150)); }
    audit(login, "redraft_done", itemId, `status=${status} v=${ver} tools=${toolLog.length}`);
  } catch (e) {
    db.prepare("UPDATE work_items SET status = 'awaiting_input', updated_at = datetime('now') WHERE id = ?").run(itemId);
    audit(login, "redraft_failed", itemId, e.message.slice(0, 200));
  }
}

// Mark the inbound email read in the shared mailbox (on send / done / archive).
// No-op-safe: if Mail.ReadWrite isn't granted yet, it logs a skip and changes nothing.
//
// The WHOLE thread, not just the newest message (item #1308, 2026-08-15). A customer who writes
// twice before we answer leaves two unread mails behind one work item; marking only
// latest_message_id read left the earlier one unread in Outlook after the reply went out, and the
// outlook-close reopen mirror ("any unread message in the thread => live") could then reopen the
// item Brad had just finished. Which siblings are eligible is decided by thread-read.js.
async function markReadSafe(login, w) {
  const mailbox = MAILBOX_OF[w.mailbox];
  const r = await SEND.markRead(mailbox, w.latest_message_id);
  audit(login, "mark_read", w.id, r.ok ? "ok" : "skipped: " + r.reason);
  if (r.ok) recordReadMark(w, w.latest_message_id);
  // Only chase the rest of the thread once the newest message actually marked: if the permission
  // or the message id is the problem, every sibling would fail identically and noisily.
  if (r.ok) await markThreadReadSafe(login, w, mailbox);
}

// Remember that AXLE marked this message read, not a human. The reopen mirror reads this ledger:
// a message on it that is unread again was deliberately un-read, which is the one signal Exchange
// gives us — it does not move lastModifiedDateTime on a read-state change (see db.js read_marks).
// Never allowed to break a close: a ledger write failing costs a future reopen, nothing more.
function recordReadMark(w, messageId) {
  if (!messageId) return;
  try {
    db.prepare(
      `INSERT INTO read_marks (mailbox, message_id, work_item_id, marked_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT (mailbox, message_id)
       DO UPDATE SET work_item_id = excluded.work_item_id, marked_at = excluded.marked_at`
    ).run(w.mailbox, messageId, w.id);
  } catch (e) {
    audit("system", "read_mark_failed", w.id, String(e.message || e).slice(0, 150));
  }
}

// Best-effort second half of markReadSafe. Never throws and never blocks the close: a Graph
// hiccup here leaves the old behaviour (newest message read, siblings untouched) and an audit row.
async function markThreadReadSafe(login, w, mailbox) {
  try {
    const found = await SEND.conversationMessages(mailbox, w.latest_message_id, { unreadOnly: true });
    if (!found.ok) { audit(login, "mark_read_thread", w.id, "skipped: " + found.reason); return; }

    // Same grouping ingest uses, so the key we look up is the key it stored.
    const keyOf = new Map();
    for (const [key, msgs] of E.threadGroup(found.messages)) for (const m of msgs) keyOf.set(m.id, key);
    const byKey = db.prepare("SELECT id, status FROM work_items WHERE mailbox = ? AND conversation_key = ?");
    const plan = TR.planThreadRead(
      w,
      found.messages.map((m) => ({ id: m.id, key: keyOf.get(m.id) })),
      (key) => byKey.get(w.mailbox, key)
    );
    if (!plan.mark.length && !plan.skip.length) return;

    let marked = 0, failed = 0;
    for (const id of plan.mark) {
      const r = await SEND.markRead(mailbox, id);
      if (r.ok) { marked++; recordReadMark(w, id); } else failed++;
    }
    audit(login, "mark_read_thread", w.id,
      `${marked} earlier message(s) in the thread marked read` +
      (failed ? `, ${failed} failed` : "") +
      (plan.skip.length ? `, ${plan.skip.length} left unread (${plan.skip.map((s) => s.why).join("; ").slice(0, 80)})` : ""));
  } catch (e) {
    audit(login, "mark_read_thread", w.id, "skipped: " + String(e.message || e).slice(0, 150));
  }
}

// --- Compose ("New email") helpers ---------------------------------------------
// Default send-from mailbox follows the composer's location: Drachten staff -> drachten@,
// everyone else -> info@. Always overridable in the modal; admin@ is never an option.
function defaultMailbox(user) {
  return String(user.owner_label || "").toLowerCase() === "drachten" ? "drachten" : "info";
}

// A webshop contact-form message (filed in info@'s "Shopify Contact Form" folder). The thread
// sender is Shopify's mailer, not the customer, so in-thread Send must stay disabled for these.
function isContactFormItem(w) {
  return w.rule_id === "shopify_form" || (w.sender_email || "").toLowerCase() === "mailer@shopify.com";
}

// A Shopify self-service "Return items" notification ("Return requested for order #S..."). Like
// the contact form, the thread sender is our own info@ mailer, NOT the customer — so a reply is a
// NEW outbound to the code-held, resolver-produced customer address, never an in-thread reply to
// info@. Detection is on the dedicated rule id set at ingest.
function isReturnNotificationItem(w) {
  return w.rule_id === "shopify_return_request";
}

// The item's kind, as recipient-set.js understands it. Defined ONCE here because the recipient
// route, the item page and the send path must all classify an item identically — a compose item
// that looked like a "reply" to one of them would get the wrong address set.
function itemKind(w) {
  if (w.origin === "compose") return "compose";
  if (isContactFormItem(w)) return "contactform";
  if (isReturnNotificationItem(w)) return "return";
  return "reply";
}

// Persist the editable inputs shared by /work and /send: feedback (the ONE consolidated
// response box - answers to Axle's questions plus any guidance) and the edited reply
// (draft_edit). TRUSTED staff input. Per-question answer_<id> fields were removed in the
// consolidated-questions round (2026-06-11); old answers stay in the DB as history.
function saveWorkInputs(w, body, login) {
  if ("feedback" in body) {
    const fb = String(body.feedback || "").trim();
    db.prepare("UPDATE work_items SET feedback = ? WHERE id = ?").run(fb || null, w.id);
    if (fb) audit(login, "save_feedback", w.id, fb.slice(0, 100));
  }
  if ("reply" in body) {
    db.prepare("UPDATE work_items SET draft_edit = ? WHERE id = ?").run(String(body.reply || ""), w.id);
  }
}

// Add an outbound attachment (base64 from the browser, no multipart). Enforces per-file and
// per-item size caps. Returns { error, id }: error is a localised string (id null) on
// failure; on success error is null and id is the new draft_attachments id - the browser
// uses it to build an [image:id] inline token. An empty body.data is a pure form-save
// no-op (error null, id null), used by the paste flow to persist the token-edited reply.
function addAttachment(w, body, login, lang) {
  const b64 = String(body.data || "");
  if (!b64) return { error: null, id: null };
  const size = Math.floor((b64.length * 3) / 4); // approx decoded byte length
  if (size > MAX_ATTACH_BYTES) return { error: t(lang, "file_too_big"), id: null };
  const total = db.prepare("SELECT COALESCE(SUM(size), 0) AS s FROM draft_attachments WHERE work_item_id = ?").get(w.id).s;
  if (total + size > MAX_ATTACH_TOTAL) return { error: t(lang, "attach_total"), id: null };
  const name = String(body.name || "attachment").replace(/[\r\n]/g, " ").slice(0, 200);
  const ctype = String(body.ctype || "application/octet-stream").slice(0, 100);
  const id = db.prepare("INSERT INTO draft_attachments (work_item_id, name, content_type, size, content_b64, added_by) VALUES (?, ?, ?, ?, ?, ?)")
    .run(w.id, name, ctype, size, b64, login).lastInsertRowid;
  audit(login, "attachment_added", w.id, `${name} (${fmtSize(size)})`);
  return { error: null, id };
}

// ---------------------------------------------------------------- carrier claims
// ONE implementation, called by BOTH the ingest path and the redraft path.
//
// It started as ingest-only, and that was wrong in a way the unit tests could not see: a claim
// item already exists by the time anyone looks at it, so ingest does not run again unless a new
// email arrives on the thread. The button a salesperson actually presses is "Save & redraft",
// which goes through runRedraft - so the documents would never have been staged from the UI, at
// any gate setting. Found on the live dry run of item 1316, 2026-08-15.
function claimDeps() {
  return {
    claimDeps: { myparcelSearch: C.myparcelSearch },
    claimDossier: (barcode) => C.claimDossier(barcode),
    buildDocumentPdf: (type, num) => SAPDOC.buildDocumentPdf(type, num),
    buildStatementPdf: (dossier, o) => CS.buildStatementPdf(dossier, o),
    // 'system' is the actor: this staging is automatic, unlike a human pressing Attach.
    addAttachment: (item, body) => addAttachment(item, body, "system", "en"),
    existingNames: async (itemId) =>
      db.prepare("SELECT name FROM draft_attachments WHERE work_item_id = ?").all(itemId).map((r) => r.name),
    audit,
  };
}

// Detect, assemble and stage for one item. Returns the claim scope ({cardCode, cardName} of the
// customer on the shipment's own order) so the caller can scope its document suggestions to it,
// or null when this is not a claim. Never throws: a claim failure must not cost us the item.
async function runClaim(itemId, email, lang) {
  const item = db.prepare("SELECT * FROM work_items WHERE id = ?").get(itemId);
  if (!item) return null;
  const res = await CA.handleInboundClaim(item, email, claimDeps(), { lang: lang === "en" ? "en" : "nl" });
  if (!res.claim || !res.claim.is_claim) return null;
  db.prepare("UPDATE work_items SET claim_json = ? WHERE id = ?")
    .run(JSON.stringify({ claim: res.claim, dossier: res.dossier, staged: res.report }), itemId);
  audit("system", "claim_detected", itemId,
    `barcode=${res.claim.barcodes[0]} order=${(res.claim.sap_order_numbers || []).join(",") || "-"} ` +
    `staged=${(res.report && res.report.staged.length) || 0} mode=${(res.report && res.report.mode) || "off"}`);
  const ord = res.dossier && (res.dossier.orders || [])[0];
  return ord && ord.card_code ? { cardCode: ord.card_code, cardName: ord.card_name } : null;
}

module.exports = {
  MAILBOX_OF, anthropic, MAX_ATTACH_BYTES, MAX_ATTACH_TOTAL,
  persistResult, runRedraft, markReadSafe, defaultMailbox,
  isContactFormItem, isReturnNotificationItem, itemKind, saveWorkInputs, addAttachment,
  claimDeps, runClaim,
};
