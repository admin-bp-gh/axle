// compose-test.js - Gate B harness for compose mode (Step 2). READ-ONLY: resolves a customer,
// runs compose mode through the real engine (live read-only tools), prints the draft and logs it.
// Nothing is sent. Safe to run on the box.
//
// Usage:
//   node compose-test.js                 run the built-in turret case (SO 226108)
//   node compose-test.js 226108 "Tell the customer ..."  [nl|en|de|fr|es]
require("dotenv").config({ path: "C:\\Axle\\secrets\\.env", quiet: true });
const fs = require("fs");
const Anthropic = require("@anthropic-ai/sdk");
const rulesets = require("./rules.js");
const { resolveCustomer } = require("./resolve-customer.js");
const { composeDraft } = require("./compose.js");

const anthropic = new Anthropic();
const MAILBOX = process.env[rulesets.info.mailboxEnv]; // Gouda info@ (send-from + mailbox_search ctx)
const LOG_DIR = "C:\\Axle\\logs\\compose";

const TURRET_PROMPT =
  "Tell the customer we haven't received payment for order 226108 (TF534). We've already ordered " +
  "the stock from our supplier - check the ETA. We normally wait for payment before ordering. Ask " +
  "him to pay at his earliest convenience and we'll send the turrets as soon as they arrive.";

function logResult(label, identifier, resolved, out) {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const f = `${LOG_DIR}\\compose-${ts}.md`;
  const r = out.result;
  const md = [
    `# Compose log - ${label}`, "",
    `Identifier(s): ${identifier}`,
    `Resolved: ${resolved.resolved} via ${resolved.matched_via}`,
    `Recipient (code-held, not shown to model): ${out.recipient || "(none)"}`,
    `Customer: ${resolved.customer ? resolved.customer.name + " [" + resolved.customer.cardCode + "]" : "-"}`,
    "", `## Result`,
    `language: ${r.language}   status: ${r.status}   confidence: ${r.confidence}   injection_suspected: ${r.injection_suspected}`,
    `subject: ${r.subject || "(none)"}`,
    "", `### draft`, r.draft || "(empty)",
    "", `### interim_draft`, r.interim_draft || "(empty)",
    "", `### questions_for_salesperson`, ...(r.questions_for_salesperson || []).map((q) => "- " + q),
    "", `### physical_checks`, ...(r.physical_checks || []).map((q) => "- " + q),
    "", `## Tool calls (${out.toolLog.length})`,
    ...out.toolLog.map((t) => `- ${t.ok ? "ok " : "ERR"} ${t.tool}: ${t.purpose} | ${String(t.input).slice(0, 120)}`),
  ].join("\n");
  fs.writeFileSync(f, md, "utf8");
  return f;
}

function printResult(out, resolved) {
  const r = out.result;
  console.log(`  recipient (code-held): ${out.recipient || "(none)"}   [model never sees this]`);
  console.log(`  status: ${r.status}   language: ${r.language}   confidence: ${r.confidence}   injection: ${r.injection_suspected}`);
  console.log(`  subject: ${r.subject || "(none)"}`);
  console.log("  --- draft ---\n" + (r.draft ? r.draft.split("\n").map((l) => "  " + l).join("\n") : "  (empty)"));
  if (r.interim_draft) console.log("  --- interim ---\n" + r.interim_draft.split("\n").map((l) => "  " + l).join("\n"));
  if ((r.questions_for_salesperson || []).length) { console.log("  questions:"); r.questions_for_salesperson.forEach((q) => console.log("   - " + q)); }
  if ((r.physical_checks || []).length) { console.log("  physical checks:"); r.physical_checks.forEach((q) => console.log("   - " + q)); }
  console.log(`  tool calls: ${out.toolLog.length}  (${out.toolLog.map((t) => t.tool).join(", ")})`);
}

async function runOne(label, identifier, prompt, lang) {
  console.log("\n" + "=".repeat(78) + "\n" + label + "\nINSTRUCTION: " + prompt + "\n" + "-".repeat(78));
  const resolved = await resolveCustomer(identifier);
  if (!resolved.resolved) {
    console.log(`  NOT a single confirmed recipient (via ${resolved.matched_via}): ${resolved.message}`);
    if (resolved.candidates.length) resolved.candidates.slice(0, 8).forEach((c) => console.log(`   - ${c.name} [${c.cardCode}] ${c.email || "(no email)"}`));
    console.log("  -> in the tool the salesperson picks one before drafting; skipping compose here.");
    return;
  }
  if (resolved.needsAddressPick) console.log(`  NOTE: ${resolved.customer.sendableAddresses.length} addresses on file; harness uses the first. The UI will force a pick.`);
  const out = await composeDraft(anthropic, { resolved, taskPrompt: prompt, language: lang, mailbox: MAILBOX });
  printResult(out, resolved);
  console.log("  logged: " + logResult(label, String(identifier), resolved, out));
}

(async () => {
  const [id, prompt, lang] = process.argv.slice(2);
  if (id && prompt) { await runOne("Ad-hoc compose", id, prompt, lang); return; }
  await runOne("Turret case - SO 226108 (awaiting payment + supplier ETA)", "226108", TURRET_PROMPT, "nl");
})().catch((e) => { console.error("ERROR:", e.message); process.exit(2); });
