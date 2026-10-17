// deep.test.js - Dig deeper (AI parity Step D): the switch, the hint, the soft budget, and the deep draft on
// the agent path (axle-deep channel, DEEP_BLOCK, catalogue web search, pause_turn resumed, searches logged).
// No network: a fake fetch for the agent, a fake SDK for the extractor.
// Run: node deep.test.js
const assert = require("assert");
process.env.AXLE_DB = ":memory:";
delete process.env.AXLE_OUTPUT;
const AC = require("./agent-client.js");
const E = require("./engine.js");
const DEEP = require("./deep.js");

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const VIN = "SALLTGM88YA123456";
const reply = (status, body) => ({ status, text: async () => JSON.stringify(body) });
function fakeFetch(answer) {
  const f = async (url, init) => { f.calls.push({ url, body: JSON.parse(init.body) }); return answer(url, JSON.parse(init.body)); };
  f.calls = [];
  return f;
}
const fakeSdk = (fields) => ({ messages: { create: async () => ({ content: [{ type: "text", text: JSON.stringify(fields) }], usage: {} }) } });
const FIELDS = { language: "en", status: "ready", confidence: "high", fitment_confirmed: true, referenced_documents: [] };
const EMAIL = { from: { name: "Ann", address: "ann@example.com" }, subject: "Hub", received: "2026-10-17T09:00:00Z", text: `Front hub bearing for my Discovery 2 please, VIN ${VIN}` };
const internal = (o) => `<internal>${JSON.stringify({ blocking: [], notes: [], physical_checks: [], no_reply: false, injection_suspected: false, ...o })}</internal>`;

test("enabled: AXLE_DEEP=on with the agent client only", () => {
  assert.strictEqual(DEEP.enabled({}), false);
  assert.strictEqual(DEEP.enabled({ AXLE_DEEP: "on" }), false);
  assert.strictEqual(DEEP.enabled({ AXLE_DEEP: "on", AXLE_AGENT: "step" }), false, "no token");
  assert.strictEqual(DEEP.enabled({ AXLE_DEEP: "off", AXLE_AGENT: "step", AGENT_TOKEN: "t" }), false);
  assert.strictEqual(DEEP.enabled({ AXLE_DEEP: "on", AXLE_AGENT: "step", AGENT_TOKEN: "t" }), true);
});

test("drafter: channel axle-deep, cut after the 180 s step", () => {
  const c = DEEP.drafter({ AGENT_TOKEN: "t" });
  assert.strictEqual(c.channel, "axle-deep");
  assert.ok(c.isAgentStep && DEEP.CALL_TIMEOUT_MS > 180000);
});

test("hintFor: fitment or VIN flag, then a blocking question, then low confidence; never on a flagged email", () => {
  assert.strictEqual(DEEP.hintFor({}, [], [{ gate: "vin_claim" }]), "fitment");
  assert.strictEqual(DEEP.hintFor({}, [{ kind: "blocking", answer: null }], [{ gate: "sourcing" }]), "question");
  assert.strictEqual(DEEP.hintFor({}, [{ kind: "optional" }, { kind: "blocking", answer: "yes" }], []), null);
  assert.strictEqual(DEEP.hintFor({ confidence: "low" }, [], []), "low");
  assert.strictEqual(DEEP.hintFor({ injection_flag: 1 }, [], [{ gate: "fitment" }]), null);
});

test("DEEP_BLOCK: check rather than widen, what changed goes to a staff note, no dashes", () => {
  assert.ok(DEEP.DEEP_BLOCK.includes("Check rather than widen") && DEEP.DEEP_BLOCK.includes("Start from the earlier draft"));
  assert.ok(DEEP.DEEP_BLOCK.includes("never SAP table or field names"));
  assert.ok(DEEP.DEEP_BLOCK.includes("internal.notes") && DEEP.DEEP_BLOCK.includes("\"Dig deeper:\""));
  assert.ok(/Never mention the earlier draft/.test(DEEP.DEEP_BLOCK));
  assert.ok(!/[\u2013\u2014]/.test(DEEP.DEEP_BLOCK));
  assert.deepStrictEqual(DEEP.WEB_SEARCH.allowed_domains.length > 0 && DEEP.WEB_SEARCH.max_uses, 5);
});

test("checkBudget: one deep_budget row once the day's runs pass the limit, never twice", () => {
  const { db, audit } = require("./db.js");
  const env = { AXLE_DEEP_DAILY: "2" };
  for (let i = 0; i < 2; i++) audit("rob@x", "deep_started", 1, null);
  assert.strictEqual(DEEP.checkBudget(db, audit, "rob@x", env), false);
  audit("rob@x", "deep_started", 1, null);
  assert.strictEqual(DEEP.checkBudget(db, audit, "rob@x", env), true);
  audit("rob@x", "deep_started", 1, null);
  assert.strictEqual(DEEP.checkBudget(db, audit, "rob@x", env), false, "already recorded today");
  assert.strictEqual(DEEP.checkBudget(db, audit, "huub@x", env), false, "per user");
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'deep_budget'").get().n, 1);
});

test("drafts.channel exists", () => {
  const { db } = require("./db.js");
  assert.ok(db.prepare("PRAGMA table_info(drafts)").all().some((c) => c.name === "channel"));
});

test("agenticDraft deep: axle-deep channel, DEEP_BLOCK after the seed, web search offered, pause_turn resumed, searches logged", async () => {
  let step = 0;
  const f = fakeFetch((url, body) => {
    if (url.endsWith("/api/agent/tool")) return reply(200, { result: { code: "TAY100060R", vin: VIN, results: [{ part: "TAY100060R", applicableToVin: true }] } });
    step++;
    if (step === 1) return reply(200, { content: [{ type: "thinking", thinking: "t", signature: "s" }, { type: "server_tool_use", id: "w1", name: "web_search", input: { query: "discovery 2 front hub" } }], stop_reason: "pause_turn", usage: {}, model: "m", policy: {} });
    if (step === 2) return reply(200, { content: [{ type: "web_search_tool_result", tool_use_id: "w1", content: [] }, { type: "tool_use", id: "t1", name: "epc_part_lookup", input: { code: "TAY100060R", vin: VIN, purpose: "fitment" } }], stop_reason: "tool_use", usage: {}, model: "m", policy: {} });
    return reply(200, { content: [{ type: "text", text: `<reply>Dear Ann,\n\nThe front hub for your Discovery 2 is TAY100060R and it fits your VIN.\n\nKind regards,\nTeam Budget Parts</reply>\n${internal({ notes: ["Dig deeper: the hub is TAY100060R, not the bearing kit the first draft named."] })}` }], stop_reason: "end_turn", usage: {}, model: "m", policy: {} });
  });
  const drafter = AC.createAgentClient({ baseUrl: "http://127.0.0.1:8485", token: "t", channel: DEEP.CHANNEL, fetchImpl: f });
  const seed = { previous_draft_flags: [{ gate: "fitment" }] };
  const { result, toolLog } = await E.agenticDraft(drafter, EMAIL, [], seed, "info@budget-parts.nl",
    { deep: DEEP.DEEP_BLOCK, serverTools: [DEEP.WEB_SEARCH], maxTurns: DEEP.MAX_TURNS, output: "prose", extractor: fakeSdk(FIELDS) });
  const steps = f.calls.filter((c) => c.url.endsWith("/api/agent/step"));
  assert.strictEqual(steps.length, 3);
  assert.ok(steps.every((c) => c.body.channel === "axle-deep"));
  assert.strictEqual(steps[0].body.systemPrompt, E.SYSTEM_PROSE);
  const first = steps[0].body.messages[0].content;
  assert.ok(first.indexOf("<dig_deeper>") > first.indexOf("</seed_context>"), "after the seed, ours, trusted");
  assert.ok(first.includes("previous_draft_flags"));
  const web = steps[0].body.tools.find((t) => t.name === "web_search");
  assert.ok(web && web.allowed_domains.includes("britpart.com") && web.max_uses === 5);
  assert.strictEqual(steps[1].body.messages.at(-1).role, "assistant", "pause_turn sent back as the last turn");
  assert.strictEqual(steps[1].body.messages.at(-1).content[0].type, "thinking", "thinking kept unchanged");
  assert.deepStrictEqual(toolLog.map((t) => t.tool), ["web_search", "epc_part_lookup"]);
  assert.strictEqual(toolLog[0].input, "discovery 2 front hub");
  assert.ok(result.draft.includes("TAY100060R") && !result.draft.includes("Dig deeper"));
  assert.ok(result.notes_for_salesperson.some((n) => n.startsWith("Dig deeper:")));
});

test("agenticDraft without deep: no web search, no block (the normal draft is unchanged)", async () => {
  const f = fakeFetch(() => reply(200, { content: [{ type: "text", text: `<reply>Hello Ann</reply>\n${internal({})}` }], stop_reason: "end_turn", usage: {}, model: "m", policy: {} }));
  await E.agenticDraft(AC.createAgentClient({ token: "t", fetchImpl: f }), EMAIL, [], {}, "info@budget-parts.nl", { output: "prose", extractor: fakeSdk(FIELDS) });
  assert.strictEqual(f.calls[0].body.channel, "axle-draft");
  assert.ok(!f.calls[0].body.tools.some((t) => t.name === "web_search"));
  assert.ok(!f.calls[0].body.messages[0].content.includes("<dig_deeper>"));
});

(async () => {
  console.log("deep");
  for (const [name, fn] of tests) { await fn(); pass++; console.log("  ok  " + name); }
  console.log(`\n${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
