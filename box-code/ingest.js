// ingest.js - pipeline: mailbox emails -> rules + classification -> agentic
// drafts -> work items in the Axle DB. READ-ONLY against all business systems;
// the only thing written is Axle's own SQLite database.
// Re-run safe: unchanged conversations are skipped; a new inbound email on an
// existing item re-opens it (new draft version, answered questions preserved).
//
// Watermark model: each run reads every email that arrived since the last sync
// (receivedDateTime >= the stored per-mailbox watermark, minus a small overlap buffer
// to absorb mail-rule/move lag), across the mailbox's configured folders, then advances
// the watermark to the newest message seen. No "unread" filter -- "new since last sync",
// not "unread", is what's processed. The thread-level dedup makes the overlap free.
//
// Usage: node ingest.js [info|drachten|all] [unread]
//   default is info@ only (the live mailbox). 'all' processes both mailboxes in one
//   process. A cross-process lock (sync_state) means the scheduled run and the manual
//   "Sync now" button never overlap.
//   The optional 'unread' flag is a ONE-TIME seed mode: it ingests only the mailbox's
//   currently-unread messages (ignoring the watermark/date), then sets the watermark to
//   "now" so the normal "new since last sync" run takes over cleanly afterwards. Used to
//   populate a newly-onboarded mailbox's queue (e.g. drachten@) with just the open mail.
require("dotenv").config({ path: "C:\\Axle\\secrets\\.env", quiet: true });
const Anthropic = require("@anthropic-ai/sdk");
const rulesets = require("./rules.js");
const C = require("./connectors.js");
const E = require("./engine.js");
const CF = require("./contact-form.js");
const DS = require("./doc-suggest.js");
const { db, audit, acquireSync, releaseSync, getWatermark, setWatermark, isBlockedSender } = require("./db.js");

const arg0 = process.argv[2];
const BOXES = arg0 === "all" ? ["info", "drachten"] : arg0 === "drachten" ? ["drachten"] : ["info"];
const SEED_UNREAD = process.argv.includes("unread");   // one-time unread-only seed mode (see header)
const BUFFER_MIN = 10;          // overlap window subtracted from the watermark (absorbs move/clock lag)
const MAX_PAGES = 10;           // per-folder pagination cap (50/page -> up to 500 msgs/folder/run)
const PRIO = { high: 1, normal: 2, low: 3 };

// The "since" timestamp for a mailbox: its watermark minus the overlap buffer. When no watermark
// is set yet (fresh DB or just after a wipe), default to "now" so we never mass-backfill the
// 14k-message inbox -- only genuinely new mail flows in from here.
function sinceFor(box) {
  const wm = getWatermark(box);
  const baseMs = wm ? Date.parse(wm) : Date.now();
  return new Date(baseMs - BUFFER_MIN * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function briefMd(seed, toolLog) {
  return [
    `## Investigation (${toolLog.length} tool calls)`,
    toolLog.map((t) => `- ${t.ok ? "OK" : "FAIL"} ${t.tool} - ${t.purpose}\n  ${t.input.replace(/\s+/g, " ").slice(0, 160)}` + (t.result ? `\n  → ${String(t.result).replace(/\s+/g, " ").slice(0, 200)}` : "")).join("\n") || "- none",
    "",
    "## Seed context",
    "```json",
    JSON.stringify(seed, null, 2),
    "```",
  ].join("\n");
}

// Auto-attach (Step 4): compute the read-only "suggested documents" for an inbound item at ingest
// and cache them on the item for instant render on the detail page. Skipped for contact-form items
// (the sender is Shopify's mailer, not the customer) and for injection-flagged items (surface
// nothing automatically). READ-ONLY; a failure here must never block the item.
async function storeSuggestions(itemId, senderEmail, scanText, isContactForm, injectionSuspected, modelRefs) {
  if (isContactForm || injectionSuspected) {
    db.prepare("UPDATE work_items SET doc_suggestions_json = NULL WHERE id = ?").run(itemId);
    return;
  }
  try {
    const sugg = await DS.suggestForEmail(senderEmail, scanText, { extraRefs: modelRefs || [] });
    db.prepare("UPDATE work_items SET doc_suggestions_json = ? WHERE id = ?").run(JSON.stringify(sugg), itemId);
    if (sugg.length) {
      audit("system", "doc_suggestions", itemId,
        sugg.map((s) => `${s.status}:${(s.docs[0] && s.docs[0].docNum) || "?"}`).join(" ").slice(0, 150));
    }
  } catch (e) {
    audit("system", "suggest_error", itemId, e.message.slice(0, 150));
  }
}

// The text to scan for document references: the newest message PLUS the whole quoted thread, so a
// follow-up ("any news?") still surfaces the order/invoice number the customer gave earlier. Every
// candidate is still resolved + customer-scope-checked, so widening the text can't cross the
// customer boundary - it only finds more of THIS customer's own references.
function threadScanText(email, history) {
  return [email.text].concat((history || []).map((h) => h.text || "")).filter(Boolean).join("\n\n");
}

async function processThread(anthropic, key, msgs, ctx) {
  const { boxName, ruleset, MAILBOX } = ctx;
  const email = msgs[0];                       // newest
  const history = msgs.slice(1).reverse();     // oldest first
  // Team-managed blocklist (the "Block sender" action) - checked BEFORE the static rules,
  // so a blocked sender never becomes (or updates) a work item. Audited for visibility.
  if (isBlockedSender(email.from.address)) {
    audit("system", "sender_block_hit", null, String(email.from.address).toLowerCase());
    return { skip: "blocked" };
  }

  const rule = rulesets.matchRule(email, ruleset.rules);
  if (!rule || rule.action === "archive" || rule.action === "junk") return { skip: "noise" };

  const existing = db
    .prepare("SELECT id, latest_message_id FROM work_items WHERE mailbox = ? AND conversation_key = ?")
    .get(boxName, key);
  if (existing && existing.latest_message_id === email.id) return { skip: "unchanged" };

  const cls = await E.classify(anthropic, email, history);

  // Voicemail caller match: look up the number in the body against SAP business partners.
  let callerInfo = null;
  if ((email.from.address || "").toLowerCase() === "voicemail@hipservice.nl") {
    try {
      const nums = C.extractPhoneNumbers(email.text);
      const hit = await C.findCustomerByPhone(nums);
      if (hit) callerInfo = `Caller: ${hit.CardName} (${hit.CardCode})${hit.Phone1 ? " — " + hit.Phone1 : ""}`;
      else if (nums.length) callerInfo = `Caller number ${nums[0]} — no SAP match`;
    } catch (e) { audit("system", "voicemail_lookup_error", existing ? existing.id : null, e.message.slice(0, 150)); }
  }

  // Attachment metadata for the newest inbound email (failure here never blocks the item).
  let atts = [];
  if (email.hasAttachments) {
    try { atts = await C.listAttachments(MAILBOX, email.id); }
    catch (e) { audit("system", "attachments_error", existing ? existing.id : null, e.message.slice(0, 150)); }
  }

  let itemId;
  if (existing) {
    itemId = existing.id;
    audit("system", "item_reopened", itemId, `new inbound ${email.id.slice(0, 24)}`);
  } else {
    itemId = db.prepare(
      "INSERT INTO work_items (mailbox, conversation_key, sender_email, sender_name, subject, email_text, email_received) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(boxName, key, email.from.address, email.from.name, email.subject, email.text, email.received).lastInsertRowid;
    audit("system", "item_created", itemId, `rule=${rule.id}`);
  }

  db.prepare(
    `UPDATE work_items SET subject = ?, language = ?, intent = ?, priority = ?, summary = ?,
     injection_flag = ?, latest_message_id = ?, rule_id = ?, owner = ?,
     email_text = ?, email_received = ?, attachments_json = ?, status = 'new',
     suggest_close = 0, updated_at = datetime('now') WHERE id = ?`
  ).run(
    email.subject, cls.language, cls.intent, PRIO[cls.priority] || 2, cls.summary,
    cls.injection_suspected ? 1 : 0, email.id, rule.id, rule.owner || null,
    email.text, email.received, JSON.stringify(atts), itemId
  );
  if (callerInfo) db.prepare("UPDATE work_items SET caller_info = ? WHERE id = ?").run(callerInfo, itemId);

  // Contact-form enrichment (Step 2): parse the structured body deterministically and resolve
  // the customer on the trusted side, storing the result for the confirmed-To UI + send path.
  // READ-ONLY; this never sets w.recipient (that is the human-confirm step) and never sends.
  // A failure here must never block the item from being created/drafted.
  const isContactForm = rule.id === "shopify_form" || (email.from.address || "").toLowerCase() === "mailer@shopify.com";
  if (isContactForm) {
    try {
      const cf = await CF.buildContactForm(email, MAILBOX);
      // Enrichment stores the parsed/resolved record but must NOT set the outbound language:
      // that follows the customer's actual message language (classify + the draft step), never
      // the country map. cf.language is kept inside the JSON for reference only.
      db.prepare("UPDATE work_items SET contact_form_json = ? WHERE id = ?")
        .run(JSON.stringify(cf), itemId);
      audit("system", "contactform_enriched", itemId,
        `matched=${cf.resolved.matched} via=${cf.resolved.matched_via} cands=${cf.candidateAddresses.length} order=${cf.parsed.orderRef || "-"} src=${cf.source}`);
    } catch (e) {
      audit("system", "contactform_enrich_error", itemId, e.message.slice(0, 150));
    }
  }

  if (!rule.draft) {
    await storeSuggestions(itemId, email.from.address, threadScanText(email, history), isContactForm, cls.injection_suspected);
    return { itemId, status: "new", drafted: false, threadLen: msgs.length };
  }

  // Agentic investigation + draft (same engine as drafts2).
  const seed = await E.gatherSeed(email, history);
  if (callerInfo) seed.caller_match = callerInfo;
  const { result, toolLog } = await E.agenticDraft(anthropic, email, history, seed, MAILBOX);

  // no_reply NEVER auto-closes (threat-model T13; and "no email reply" can still mean work,
  // e.g. an internal "please call X"). The item lands OPEN with a suggestion flag; a human
  // confirms via the existing Done control.
  const status = result.status === "ready" ? "ready"
    : result.status === "no_reply" ? "new"
    : "awaiting_input";
  const suggestClose = result.status === "no_reply" ? 1 : 0;
  const injection = cls.injection_suspected || result.injection_suspected ? 1 : 0;
  // The DETECTED customer language (classifier) is authoritative — it drives the translation
  // panel and is de/fr/es-aware. The draft step only emits nl|en, so never let it downgrade a
  // confident foreign-language detection; fall back to the draft's language only when the
  // classifier was unsure ('other').
  const detectedLang = cls.language && cls.language !== "other" ? cls.language : (result.language || "en");
  db.prepare(
    `UPDATE work_items SET status = ?, suggest_close = ?, language = ?, confidence = ?, injection_flag = ?,
     brief_md = ?, draft_edit = NULL, updated_at = datetime('now') WHERE id = ?`
  ).run(status, suggestClose, detectedLang, result.confidence, injection, briefMd(seed, toolLog), itemId);

  const ver = (db.prepare("SELECT MAX(version) AS v FROM drafts WHERE work_item_id = ?").get(itemId).v || 0) + 1;
  if (result.draft) {
    db.prepare("INSERT INTO drafts (work_item_id, version, is_interim, body) VALUES (?, ?, 0, ?)").run(itemId, ver, result.draft);
  }
  if (result.interim_draft) {
    db.prepare("INSERT INTO drafts (work_item_id, version, is_interim, body) VALUES (?, ?, 1, ?)").run(itemId, ver, result.interim_draft);
  }

  // Replace unanswered questions with the new set; answered ones are history worth keeping.
  // Consolidated-questions round (2026-06-11): dedupe by normalised text within the batch
  // AND against surviving (answered) questions - the same question is never stored twice.
  db.prepare("DELETE FROM questions WHERE work_item_id = ? AND answer IS NULL").run(itemId);
  const normQ = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const seenQ = new Set(db.prepare("SELECT question FROM questions WHERE work_item_id = ?").all(itemId).map((r) => normQ(r.question)));
  const insQ = db.prepare("INSERT INTO questions (work_item_id, kind, question) VALUES (?, ?, ?)");
  const addQ = (kind, q) => { const n = normQ(q); if (!n || seenQ.has(n)) return; seenQ.add(n); insQ.run(itemId, kind, String(q)); };
  for (const q of result.questions_for_salesperson || []) addQ("blocking", q);
  for (const q of result.physical_checks || []) addQ("physical", q);

  await storeSuggestions(itemId, email.from.address, threadScanText(email, history), isContactForm, !!injection, result.referenced_documents);

  audit("system", "item_drafted", itemId, `status=${status}${suggestClose ? " suggest_close" : ""} v=${ver} tools=${toolLog.length} inj=${injection}`);
  return { itemId, status, drafted: Boolean(result.draft || result.interim_draft), threadLen: msgs.length, tools: toolLog.length };
}

async function runBox(anthropic, boxName, opts = {}) {
  const unreadSeed = !!opts.unreadSeed;
  const ruleset = rulesets[boxName];
  const MAILBOX = process.env[ruleset.mailboxEnv];
  const folders = ruleset.folders || ["inbox"];
  const sinceIso = sinceFor(boxName);
  if (unreadSeed) {
    console.log(`Seed ${boxName} (UNREAD-ONLY, one-time; read-only on business systems): folders [${folders.join(", ")}] in ${MAILBOX}\n`);
  } else {
    console.log(`Ingest ${boxName} (read-only on business systems): folders [${folders.join(", ")}] since ${sinceIso} in ${MAILBOX}\n`);
  }
  const emails = unreadSeed
    ? await C.getMessages(MAILBOX, { unreadOnly: true, folders, maxPages: MAX_PAGES })
    : await C.getMessages(MAILBOX, { sinceIso, folders, maxPages: MAX_PAGES });
  // Newest fetched receivedDateTime -> the new watermark (advanced after processing).
  const maxRecv = emails.reduce((m, e) => (e.received && e.received > m ? e.received : m), "");
  const threads = E.threadGroup(emails);
  const summary = [];
  for (const [key, msgs] of threads) {
    const email = msgs[0];
    try {
      const r = await processThread(anthropic, key, msgs, { boxName, ruleset, MAILBOX });
      summary.push({
        from: email.from.address.slice(0, 28), subject: email.subject.slice(0, 30),
        result: r.skip || r.status, item: r.itemId || "-", msgs: msgs.length, tools: r.tools || 0,
      });
      process.stdout.write(".");
    } catch (e) {
      audit("system", "ingest_error", null, `${key.slice(0, 60)}: ${e.message.slice(0, 200)}`);
      summary.push({ from: email.from.address.slice(0, 28), subject: email.subject.slice(0, 30), result: "ERROR: " + e.message.slice(0, 40), item: "-", msgs: msgs.length, tools: 0 });
    }
  }
  console.log("\n");
  console.table(summary);
  const items = db.prepare("SELECT status, COUNT(*) AS n FROM work_items WHERE mailbox = ? GROUP BY status").all(boxName);
  console.log(`Work items in DB for ${boxName}:`, items.map((r) => `${r.status}=${r.n}`).join(" "));

  if (unreadSeed) {
    // Seed mode: hand over to the normal "new since last sync" run by setting the watermark to
    // NOW. The 10-min buffer on the next run catches anything that lands during the seed; the
    // thread-level dedup means already-seeded items are never reprocessed.
    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    setWatermark(boxName, nowIso);
    console.log(`Watermark ${boxName} -> ${nowIso} (seeded from unread; normal sync takes over)`);
    return;
  }
  // Advance the watermark to the newest message we fetched (only forward). Next run reads from
  // here minus the buffer, so we never reprocess old mail but never miss new mail either.
  if (maxRecv) {
    const prev = getWatermark(boxName);
    if (!prev || maxRecv > prev) {
      setWatermark(boxName, maxRecv);
      console.log(`Watermark ${boxName} -> ${maxRecv}`);
    }
  }
}

// Run one or more mailboxes. The caller owns the sync lock (the CLI block below for the
// scheduled task; the server's in-process manual Sync otherwise), so this just does the work.
async function runBoxes(boxes, opts = {}) {
  const anthropic = opts.anthropic || new Anthropic();
  for (const boxName of boxes) await runBox(anthropic, boxName, { unreadSeed: !!opts.unreadSeed });
}

module.exports = { runBoxes };

// CLI / scheduled-task entry: take the lock, run, release. Only when invoked directly
// (node ingest.js ...), never when required by the server.
if (require.main === module) {
  (async () => {
    if (!acquireSync(`ingest:${BOXES.join("+")}${SEED_UNREAD ? ":unread-seed" : ""}`)) {
      console.log("Another sync is already in progress — skipping this run.");
      return;
    }
    try {
      await runBoxes(BOXES, { unreadSeed: SEED_UNREAD });
    } catch (e) {
      audit("system", "ingest_error", null, e.message.slice(0, 200));
      console.error("ERROR:", e.message);
    } finally {
      releaseSync();
      await C.closePool();   // release the shared SQL pool so this CLI process can exit cleanly
    }
  })();
}
