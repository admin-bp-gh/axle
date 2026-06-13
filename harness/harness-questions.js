// harness-questions.js - consolidated-questions round (2026-06-11).
// Runs the REAL db.js/routes/server (step0 stub kit; only network/model stubbed):
//   UI:   ONE numbered questions list, NO per-question answer boxes, ONE response
//         textarea (the feedback field); physical checks keep their marker, other
//         kinds are flat; legacy per-question answers render read-only; NL texts.
//   Save: /work persists feedback; posted answer_<id> fields are IGNORED.
//   Redraft (inbound): seed carries axle_open_questions + salesperson_feedback.
//   Redraft (compose): taskPrompt folds the numbered open questions + the reply.
//   persistResult: dedupes by normalised text, within the batch AND vs answered.
//   Prompts: engine.js + compose.js carry the QUESTIONS STYLE rule.
// Run: AXLE_MIRROR=<box-code> AXLE_STEP0=<harness/step0> node harness-questions.js
"use strict";
const path = require("path");
const fs = require("fs");

const MIRROR = process.env.AXLE_MIRROR || "/sessions/wonderful-kind-cray/mnt/Axle/box-code";
const STEP0 = process.env.AXLE_STEP0 || "/sessions/wonderful-kind-cray/mnt/Axle/harness/step0";
process.env.AXLE_MIRROR = MIRROR;
process.env.AXLE_DB = path.join(require("os").tmpdir(), "axle-q-" + process.pid + ".db");
fs.rmSync(process.env.AXLE_DB, { force: true });
process.env.MAILBOX_INFO = "info@budget-parts.nl";
process.env.MAILBOX_DRACHTEN = "drachten@budget-parts.nl";
process.env.ANTHROPIC_API_KEY = "harness-stub-key";

let n = 0, fails = 0;
const ok = (cond, name, detail) => {
  n++;
  if (!cond) { fails++; console.log(`FAIL ${n}: ${name}${detail ? " - " + detail : ""}`); }
  else console.log(`ok ${n}: ${name}`);
};
const count = (s, re) => (s.match(re) || []).length;

// ---- static asserts -----------------------------------------------------------------
const engSrc = fs.readFileSync(path.join(MIRROR, "engine.js"), "utf8");
const compSrc = fs.readFileSync(path.join(MIRROR, "compose.js"), "utf8");
const uiSrc = fs.readFileSync(path.join(MIRROR, "views", "ui.js"), "utf8");
const itemSrc = fs.readFileSync(path.join(MIRROR, "routes", "item.js"), "utf8");
ok(engSrc.includes("QUESTIONS STYLE:"), "engine.js carries the QUESTIONS STYLE rule");
ok(compSrc.includes("QUESTIONS STYLE:"), "compose.js carries the QUESTIONS STYLE rule");
ok(!uiSrc.includes("answer_ph"), "ui.js: answer_ph key removed");
ok(!itemSrc.includes('name="answer_'), "item.js: no per-question answer fields in the template");
// i18n parity: every t() key present in EN must exist in NL and vice versa
ok(count(uiSrc, /your_feedback:/g) === 2 && count(uiSrc, /feedback_ph:/g) === 2, "i18n: new texts present in both EN and NL");

require(path.join(STEP0, "stubs.js"));
const { db } = require(path.join(MIRROR, "db.js"));

// seed: user + an inbound awaiting_input item with 3 open questions (1 physical) and
// 1 legacy answered question + a compose item with 1 open question
db.prepare("INSERT INTO users (tailscale_login, display_name, role, owner_label) VALUES (?,?,?,?)")
  .run("admin@budget-parts.nl", "Brad", "admin", null);
const WI = `INSERT INTO work_items (id, mailbox, conversation_key, sender_email, sender_name, subject,
  language, intent, priority, status, injection_flag, summary, email_text, email_received,
  created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
const T = "2026-06-11 10:00:00";
db.prepare(WI).run(1, "info", "c1", "a@b.nl", "A", "Bracket query", "en", "stock_price_enquiry", 2, "awaiting_input", 0, "s", "Hello, bracket?", T, T, T);
db.prepare(WI).run(2, "info", "compose:t-1", "", "", "New email", "nl", null, 2, "awaiting_input", 0, "s", "", T, T, T);
db.prepare("UPDATE work_items SET origin='compose', compose_instruction='Tell the customer the ETA', compose_customer=?, recipient='laurens@yvesmichiels.be' WHERE id=2")
  .run(JSON.stringify({ cardCode: "K127177", name: "BV Newcraft", matched_via: "card" }));
const insQ = db.prepare("INSERT INTO questions (work_item_id, kind, question) VALUES (?,?,?)");
insQ.run(1, "blocking", "Confirm part ABC123 fits a 2004 Discovery 2?");
insQ.run(1, "blocking", "Quote with or without shipping?");
insQ.run(1, "physical", "Check shelf stock of ABC123.");
db.prepare("INSERT INTO questions (work_item_id, kind, question, answer, answered_by, answered_at) VALUES (?,?,?,?,?,datetime('now'))")
  .run(1, "blocking", "Is the bracket OK?", "Yes, verified.", "admin@budget-parts.nl");
insQ.run(2, "blocking", "Confirm the ETA window with Tom?");

// boot the real server on an ephemeral port
const express = require(path.join(MIRROR, "node_modules", "express"));
const origListen = express.application.listen;
let port;
const ready = new Promise((resolve) => {
  express.application.listen = function (...args) {
    const srv = origListen.call(this, 0, "127.0.0.1", () => { port = srv.address().port; resolve(); });
    return srv;
  };
});
require(path.join(MIRROR, "server.js"));

(async () => {
  await ready;
  const get = async (p, opts) => {
    const headers = { "Tailscale-User-Login": "admin@budget-parts.nl", ...(opts && opts.headers) };
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers });
    return { status: r.status, text: await r.text() };
  };
  const post = async (p, form, opts) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, {
      method: "POST", redirect: "manual",
      headers: { "Tailscale-User-Login": "admin@budget-parts.nl", "content-type": "application/x-www-form-urlencoded", ...(opts && opts.headers) },
      body: new URLSearchParams(form).toString(),
    });
    return { status: r.status, text: await r.text() };
  };

  // ---- UI: the consolidated questions card -------------------------------------------
  let r = await get("/item/1");
  ok(r.status === 200, "GET /item/1 200");
  ok(count(r.text, /name="feedback"/g) === 1, "exactly ONE response textarea (feedback)");
  ok(!/name="answer_/.test(r.text), "no per-question answer boxes");
  ok(/<li>1\. /.test(r.text) && /<li>2\. /.test(r.text) && /<li>3\. /.test(r.text) && /<li>4\. /.test(r.text), "questions are numbered 1..4");
  ok(count(r.text, /chip k-physical/g) === 1, "exactly one physical-check marker");
  ok(!/chip k-blocking/.test(r.text), "non-physical questions are flat (no kind chip)");
  ok(r.text.includes("Yes, verified."), "legacy answered question renders read-only");
  ok(!r.text.includes("unanswered"), "no 'unanswered' filler");
  ok(r.text.indexOf("Questions for you") < r.text.indexOf("Reply"), "awaiting_input: questions card leads");
  ok(r.text.includes("one reply covers it all"), "EN single-box placeholder");
  r = await get("/item/1", { headers: { Cookie: "axle_lang=nl" } });
  ok(r.text.includes("Jouw antwoord &amp; feedback") || r.text.includes("Jouw antwoord & feedback"), "NL label");
  ok(r.text.includes("alles in &#233;&#233;n reactie") || r.text.includes("alles in één reactie"), "NL placeholder");

  // ---- Save: feedback persists, answer_<id> fields are ignored ------------------------
  r = await post("/item/1/work", { feedback: "1: yes fits. 2: incl shipping. 3: 4 on the shelf.", answer_1: "sneaky per-question answer", reply: "draft text" });
  ok(r.status >= 200 && r.status < 400, "POST /item/1/work accepted", String(r.status));
  const w1 = db.prepare("SELECT feedback, draft_edit FROM work_items WHERE id=1").get();
  ok(w1.feedback === "1: yes fits. 2: incl shipping. 3: 4 on the shelf.", "feedback stored");
  ok(w1.draft_edit === "draft text", "reply edit stored");
  const q1 = db.prepare("SELECT answer FROM questions WHERE work_item_id=1 AND question LIKE 'Confirm part%'").get();
  ok(q1.answer === null, "posted answer_<id> is ignored (no per-question write)");
  ok(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='answer_question'").get().c === 0, "no answer_question audit");
  ok(db.prepare("SELECT COUNT(*) c FROM audit_log WHERE action='save_feedback'").get().c === 1, "save_feedback audited");

  // ---- Redraft folding (inbound): seed carries open questions + the single reply ------
  const SHARED = require(path.join(MIRROR, "routes", "shared.js"));
  // NB: the stub interceptor only matches RELATIVE requires - "./engine.js" returns the
  // same stub object shared.js holds, so patching its properties is visible there.
  const E = require("./engine.js");   // stub object; patch to capture
  let capturedSeed = null;
  const origDraft = E.agenticDraft;
  E.agenticDraft = async (an, email, hist, seed, mbx) => { capturedSeed = seed; return origDraft(an, email, hist, seed, mbx); };
  await SHARED.runRedraft(1, "admin@budget-parts.nl");
  E.agenticDraft = origDraft;
  ok(capturedSeed && capturedSeed.axle_open_questions && capturedSeed.axle_open_questions.questions.length === 3, "seed.axle_open_questions = the 3 open questions");
  ok(capturedSeed.axle_open_questions.questions[2] === "Check shelf stock of ABC123.", "open questions in id order");
  ok(capturedSeed.salesperson_feedback && capturedSeed.salesperson_feedback.text.includes("4 on the shelf"), "seed.salesperson_feedback = the single reply");
  ok(capturedSeed.salesperson_answers.answers.length === 1, "legacy answered pair still folded");
  // stub result asked "Stub question?" -> open set replaced, answered survives
  const after = db.prepare("SELECT question, answer FROM questions WHERE work_item_id=1 ORDER BY id").all();
  ok(after.length === 2 && after[0].answer !== null && after[1].question === "Stub question?", "redraft replaced open questions, kept the answered one");

  // ---- persistResult dedupe ------------------------------------------------------------
  SHARED.persistResult(1, {
    status: "awaiting_input", confidence: "low", draft: "", interim_draft: "",
    questions_for_salesperson: ["Check shelf stock of XYZ?", "check shelf stock of xyz", "Is the bracket ok?"],
    physical_checks: ["Check shelf stock of XYZ!", "Photograph the bracket."],
  }, [], {});
  const dedup = db.prepare("SELECT kind, question FROM questions WHERE work_item_id=1 AND answer IS NULL ORDER BY id").all();
  ok(dedup.length === 2, "dedupe: 5 candidates -> 2 stored", JSON.stringify(dedup));
  ok(dedup[0].question === "Check shelf stock of XYZ?" && dedup[1].question === "Photograph the bracket.", "first occurrence wins; answered question not re-added");
  ok(dedup[1].kind === "physical", "physical kind preserved");

  // ---- Redraft folding (compose): numbered questions + reply in the TRUSTED prompt ----
  db.prepare("UPDATE work_items SET feedback='Tom says ETA 9-16 June.' WHERE id=2").run();
  const COMPOSE = require("./compose.js");   // stub object; patch to capture
  let capturedOpts = null;
  const origCompose = COMPOSE.composeDraft;
  COMPOSE.composeDraft = async (an, opts) => { capturedOpts = opts; return origCompose(an, opts); };
  await SHARED.runRedraft(2, "admin@budget-parts.nl");
  COMPOSE.composeDraft = origCompose;
  ok(capturedOpts && capturedOpts.taskPrompt.includes("1. Confirm the ETA window with Tom?"), "compose prompt: numbered open question folded");
  ok(capturedOpts.taskPrompt.includes("The salesperson's reply") && capturedOpts.taskPrompt.includes("ETA 9-16 June"), "compose prompt: single reply folded as trusted");
  ok(capturedOpts.recipient === "laurens@yvesmichiels.be", "recipient stays code-held");

  console.log(fails ? `\n${fails}/${n} FAILED` : `\nALL ${n} PASS`);
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
