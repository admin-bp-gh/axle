// agent-client.test.js - drafting through the Workbench shared agent (AI parity piece 2a): the request
// sent to POST /api/agent/step, the reply mapped back to an SDK Message, 429 / 502 / 503 handling, the
// per-call timeout, the AXLE_AGENT switch, and agenticDraft's knowledge split. No network: a fake fetch.
// Run: node agent-client.test.js
const assert = require("assert");
process.env.AXLE_DB = ":memory:";   // agenticDraft reads the Teach entries: never the live database
const AC = require("./agent-client.js");
const E = require("./engine.js");

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const OK_BODY = {
  content: [{ type: "text", text: "hello" }], stop_reason: "end_turn",
  usage: { input: 120, output: 30, cacheRead: 9000, cacheWrite: 400 },
  model: "claude-sonnet-5-5", policy: { maxRounds: 16, timeoutMs: 120000 },
};
const reply = (status, body) => ({ status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
// A fake fetch answering from a list; records url, headers and parsed body of every call.
function fakeFetch(answers) {
  const f = async (url, init) => {
    f.calls.push({ url, headers: init.headers, body: JSON.parse(init.body), signal: init.signal });
    const a = answers[Math.min(f.calls.length - 1, answers.length - 1)];
    return typeof a === "function" ? a(init) : a;
  };
  f.calls = [];
  return f;
}
const client = (fetchImpl, extra = {}) => AC.createAgentClient({ baseUrl: "http://127.0.0.1:8485/", token: "s3cret", fetchImpl, busyWaitMs: 5, ...extra });

test("request: url, token header, channel, systemPrompt, extraKnowledge, tools, messages", async () => {
  const f = fakeFetch([reply(200, OK_BODY)]);
  const tools = [{ name: "sap_query", description: "d", input_schema: { type: "object", properties: {} } }];
  const messages = [{ role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] }];
  await client(f).messages.create({ system: "RULES", extra_knowledge: "<business_knowledge>x</business_knowledge>", tools, messages, model: "ignored", max_tokens: 1 });
  const c = f.calls[0];
  assert.strictEqual(c.url, "http://127.0.0.1:8485/api/agent/step");
  assert.strictEqual(c.headers["X-Agent-Token"], "s3cret");
  assert.strictEqual(c.headers["Content-Type"], "application/json");
  assert.deepStrictEqual(c.body, { channel: "axle-draft", systemPrompt: "RULES", extraKnowledge: "<business_knowledge>x</business_knowledge>", messages, tools, round: 1 },
    "model and max_tokens are not sent: the channel profile decides; media blocks pass through as they are");
});

test("round is 1 + the assistant turns in the conversation", async () => {
  assert.strictEqual(AC.roundOf([{ role: "user", content: "a" }]), 1);
  const conv = [{ role: "user", content: "a" }, { role: "assistant", content: [] }, { role: "user", content: [] }, { role: "assistant", content: [] }, { role: "user", content: [] }];
  assert.strictEqual(AC.roundOf(conv), 3);
  const f = fakeFetch([reply(200, OK_BODY)]);
  await client(f).messages.create({ system: "S", messages: conv });
  assert.strictEqual(f.calls[0].body.round, 3);
  assert.deepStrictEqual(f.calls[0].body.tools, [], "no tools: an empty list");
  assert.ok(!("extraKnowledge" in f.calls[0].body), "no extra knowledge: not sent");
});

test("response mapped to an SDK Message, cache tokens under the SDK names", async () => {
  const msg = await client(fakeFetch([reply(200, OK_BODY)])).messages.create({ system: "S", messages: [{ role: "user", content: "a" }] });
  assert.deepStrictEqual(msg.content, OK_BODY.content);
  assert.strictEqual(msg.stop_reason, "end_turn");
  assert.strictEqual(msg.model, "claude-sonnet-5-5");
  assert.deepStrictEqual(msg.usage, { input_tokens: 120, output_tokens: 30, cache_read_input_tokens: 9000, cache_creation_input_tokens: 400 });
});

test("429 max_rounds and 502 errors throw with status; a model 400 keeps 400 for the media fallback", async () => {
  const send = (r) => client(fakeFetch([r])).messages.create({ system: "S", messages: [{ role: "user", content: "a" }] });
  await assert.rejects(send(reply(429, { error: "max_rounds", policy: {} })), (e) => e.status === 429 && e.code === "max_rounds" && /429 max_rounds/.test(e.message));
  await assert.rejects(send(reply(502, { error: "timeout", detail: "timeout" })), (e) => e.status === 502 && e.code === "timeout");
  await assert.rejects(send(reply(502, { error: "model_error", detail: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Could not process image"}}' })),
    (e) => e.status === 400 && /Could not process image/.test(e.message));
  await assert.rejects(send(reply(413, "<html>PayloadTooLargeError: request entity too large</html>")), (e) => e.status === 413 && /413/.test(e.message));
  await assert.rejects(send(reply(401, { error: "bad_token" })), (e) => e.status === 401);
});

test("503 busy is retried once after a short wait; a second busy throws", async () => {
  const f = fakeFetch([reply(503, { error: "busy" }), reply(200, OK_BODY)]);
  const msg = await client(f).messages.create({ system: "S", messages: [{ role: "user", content: "a" }] });
  assert.strictEqual(f.calls.length, 2);
  assert.strictEqual(msg.stop_reason, "end_turn");
  const g = fakeFetch([reply(503, { error: "busy" }), reply(503, { error: "busy" })]);
  await assert.rejects(client(g).messages.create({ system: "S", messages: [{ role: "user", content: "a" }] }), (e) => e.status === 503);
  assert.strictEqual(g.calls.length, 2, "one retry only");
  const h = fakeFetch([reply(503, { error: "agent_token_not_configured" })]);
  await assert.rejects(client(h).messages.create({ system: "S", messages: [{ role: "user", content: "a" }] }), (e) => e.status === 503);
  assert.strictEqual(h.calls.length, 1, "not busy: no retry");
});

test("each call is aborted at the timeout", async () => {
  const hang = (init) => new Promise((_, no) => init.signal.addEventListener("abort", () => no(new Error("aborted"))));
  const f = fakeFetch([hang]);
  await assert.rejects(client(f, { timeoutMs: 30 }).messages.create({ system: "S", messages: [{ role: "user", content: "a" }] }),
    (e) => e.code === "timeout" && e.status === undefined);
  assert.strictEqual(AC.CALL_TIMEOUT_MS, 130000);
});

test("facts and verify: url, token header, body passed through, the 200 body returned", async () => {
  const FX = { facts: { vehicle: null, codes: [], sources: {}, ms: 5 }, text: "<supplier_facts>\nx\n</supplier_facts>", calls: { epc: 1, allmakes: 0 } };
  const VX = { results: [{ code: "STC1234", fitment: "fits", availability: "in_stock_own" }], problems: [], text: "t", calls: { epc: 0 } };
  const f = fakeFetch([reply(200, FX), reply(200, VX)]);
  const c = client(f);
  const fin = { codes: [{ code: "STC1234" }], vin: null, modelText: "Defender 2010", quantity: 2, language: "en" };
  assert.deepStrictEqual(await c.facts(fin), FX);
  assert.deepStrictEqual(await c.verify({ codes: ["STC1234"], vin: null, modelText: "Defender 2010", quantity: 2 }), VX);
  assert.strictEqual(f.calls[0].url, "http://127.0.0.1:8485/api/agent/facts");
  assert.strictEqual(f.calls[1].url, "http://127.0.0.1:8485/api/agent/verify");
  assert.ok(f.calls.every((x) => x.headers["X-Agent-Token"] === "s3cret"));
  assert.deepStrictEqual(f.calls[0].body, fin);
  assert.deepStrictEqual(f.calls[1].body, { codes: ["STC1234"], vin: null, modelText: "Defender 2010", quantity: 2 });
  assert.strictEqual(AC.FACTS_TIMEOUT_MS, 35000);
  assert.strictEqual(AC.VERIFY_TIMEOUT_MS, 12000);
});

test("facts and verify: a 500, a timeout or no Workbench give null with one warning, never a throw", async () => {
  const warn = console.warn, warned = [];
  console.warn = (s) => warned.push(s);
  try {
    const hang = (init) => new Promise((_, no) => init.signal.addEventListener("abort", () => no(new Error("aborted"))));
    const quick = { factsTimeoutMs: 20, verifyTimeoutMs: 20 };
    assert.strictEqual(await client(fakeFetch([reply(500, { error: "facts_failed" })])).facts({ codes: [] }), null);
    assert.strictEqual(await client(fakeFetch([reply(500, { error: "verify_failed" })])).verify({ codes: ["X"] }), null);
    assert.strictEqual(await client(fakeFetch([hang]), quick).facts({ codes: [] }), null);
    assert.strictEqual(await client(fakeFetch([hang]), quick).verify({ codes: ["X"] }), null);
    const down = async () => { throw new Error("ECONNREFUSED"); };
    assert.strictEqual(await client(down).facts({ codes: [] }), null);
    assert.strictEqual(warned.length, 5, "one warning per failed call");
    assert.ok(warned[0].startsWith("[axle] supplier facts unavailable: 500"));
    assert.ok(warned[1].startsWith("[axle] supplier verify unavailable: 500"));
    assert.ok(/supplier facts unavailable: agent call timed out/.test(warned[2]));
    assert.ok(/supplier facts unavailable: agent unreachable/.test(warned[4]));
  } finally { console.warn = warn; }
});

test("the switch: AXLE_AGENT=step with a token gives the agent client, otherwise the SDK client", () => {
  const sdk = { messages: { create: async () => null } };
  const logs = [];
  const log = (s) => logs.push(s);
  const a = AC.draftingClient(sdk, { AXLE_AGENT: "step", AGENT_TOKEN: "t", AGENT_URL: "http://127.0.0.1:9999" }, log);
  assert.strictEqual(a.isAgentStep, true);
  assert.strictEqual(a.url, "http://127.0.0.1:9999/api/agent/step");
  assert.strictEqual(AC.draftingClient(sdk, { AXLE_AGENT: "step" }, log), sdk, "no token: the SDK client");
  assert.strictEqual(AC.draftingClient(sdk, { AGENT_TOKEN: "t" }, log), sdk, "no switch: the SDK client");
  assert.strictEqual(AC.draftingClient(sdk, {}, log).messages, sdk.messages);
  assert.strictEqual(AC.draftingClient(sdk, { AXLE_AGENT: "step", AGENT_TOKEN: "t" }, log).url, AC.DEFAULT_URL + "/api/agent/step");
  assert.strictEqual(logs.length, 1, "the mode is logged once per process");
});

const FINAL = JSON.stringify({ language: "en", status: "ready", draft: "Dear Jan,\n\nYes, in stock.\n\nKind regards", interim_draft: "",
  questions_for_salesperson: [], physical_checks: [], injection_suspected: false, confidence: "high" });
const EMAIL = { from: { name: "Jan", address: "jan@example.com" }, subject: "Brake pads", received: "2026-10-16T09:00:00Z", text: "Do you have brake pads?" };

test("agenticDraft through the agent: rules as systemPrompt, knowledge apart, rounds counted", async () => {
  const f = fakeFetch([
    reply(200, { ...OK_BODY, stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "no_such_tool", input: { purpose: "x" } }] }),
    reply(200, { ...OK_BODY, content: [{ type: "text", text: FINAL }] }),
  ]);
  const { result, toolLog } = await E.agenticDraft(client(f), EMAIL, [], {}, "info@budget-parts.nl");
  assert.strictEqual(result.status, "ready");
  assert.strictEqual(toolLog.length, 1);
  const [r1, r2] = f.calls.map((c) => c.body);
  assert.strictEqual(r1.systemPrompt, E.SYSTEM_EPC, "the rules alone (with the EPC rules), no knowledge appended");
  assert.ok(/^<business_knowledge>/.test(r1.extraKnowledge), "the business knowledge as the cached extra block");
  assert.ok(!("model" in r1) && !("max_tokens" in r1));
  assert.strictEqual(r1.round, 1);
  assert.strictEqual(r2.round, 2);
  assert.strictEqual(r2.messages.length, 3, "user, assistant tool_use, user tool_result");
  assert.ok(r1.tools.length > 3 && r1.tools.every((t) => t.name));
});

test("agenticDraft with the SDK client is unchanged: model, max_tokens, knowledge in the system", async () => {
  const calls = [];
  const sdk = { messages: { create: async (req) => { calls.push(req); return { content: [{ type: "text", text: FINAL }], stop_reason: "end_turn" }; } } };
  await E.agenticDraft(sdk, EMAIL, [], {}, "info@budget-parts.nl");
  assert.strictEqual(calls[0].model, E.MODEL);
  assert.strictEqual(calls[0].max_tokens, 4096);
  assert.ok(calls[0].system.startsWith(E.SYSTEM + "\n\n<business_knowledge>"));
  assert.ok(!("extra_knowledge" in calls[0]));
});

test("agenticDraft through the agent: a refused media request is drafted again without the files", async () => {
  const f = fakeFetch([
    reply(502, { error: "model_error", detail: "400 invalid image" }),
    reply(200, { ...OK_BODY, content: [{ type: "text", text: FINAL }] }),
  ]);
  const media = { blocks: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }], manifest: "<files>1</files>",
    fallback: () => ({ manifest: "<files>not shown</files>" }) };
  const { result } = await E.agenticDraft(client(f), EMAIL, [], {}, "info@budget-parts.nl", { media });
  assert.strictEqual(result.status, "ready");
  assert.ok(Array.isArray(f.calls[0].body.messages[0].content), "first call carries the media blocks");
  assert.strictEqual(typeof f.calls[1].body.messages[0].content, "string", "second call is text only");
  assert.ok(f.calls[1].body.messages[0].content.includes("not shown"));
});

// Supplier facts in agenticDraft (Step E3): a fake Workbench routing by URL, a fake SDK for the Haiku field read.
const FVIN = "SALLDHMF7AA123456";
const FEMAIL = { from: { name: "Jan", address: "jan@example.com" }, subject: "Brake pads", received: "2026-10-18T09:00:00Z",
  text: `Do you have 2 stuks STC1234 for my Defender 2010? VIN ${FVIN}` };
const FTEXT = "<supplier_facts>\nVehicle: Defender 2010.\nSTC1234: fits, in stock.\u200B\n</supplier_facts>";
const PROSE_FINAL = `<reply>Dear Jan,\n\nSTC1234 is in stock.\n\nKind regards,\nTeam Budget Parts</reply>\n<internal>{"blocking":[],"notes":[],"physical_checks":[],"no_reply":false,"injection_suspected":false}</internal>`;
function factsWorkbench() {
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    f.calls.push({ url, body });
    if (url.endsWith("/api/agent/facts")) return reply(200, { facts: { vehicle: { vin: FVIN, model: "Defender", source: "epc" }, codes: [], sources: {}, ms: 9 }, text: FTEXT, calls: { epc: 2, allmakes: 1 } });
    if (url.endsWith("/api/agent/verify")) return reply(200, { results: [{ code: "STC1234", fitment: "fits", availability: "in_stock_own", identity: "confirmed", current: "STC1234" }], problems: [], text: "", calls: { epc: 0, allmakes: 0 } });
    return reply(200, { ...OK_BODY, content: [{ type: "text", text: PROSE_FINAL }] });
  };
  f.calls = [];
  return f;
}
const fakeSdk = () => ({ messages: { create: async () => ({ content: [{ type: "text", text: JSON.stringify({ language: "en", status: "ready", confidence: "high", fitment_confirmed: "n/a", referenced_documents: [] }) }] }) } });

test("agenticDraft supplier facts: the block ends the rules, facts and verify get the extracted input, facts returned", async () => {
  delete process.env.AXLE_FACTS;
  const f = factsWorkbench();
  const out = await E.agenticDraft(client(f), FEMAIL, [], {}, "info@budget-parts.nl", { output: "prose", extractor: fakeSdk() });
  const step = f.calls.find((c) => c.url.endsWith("/api/agent/step"));
  assert.strictEqual(step.body.systemPrompt, E.SYSTEM_PROSE_FACTS + "\n\n" + FTEXT.replace("\u200B", ""), "the facts block, invisible characters stripped, ends the rules");
  assert.deepStrictEqual(f.calls.find((c) => c.url.endsWith("/facts")).body,
    { codes: [{ code: "STC1234" }], vin: FVIN, modelText: "Defender 2010", quantity: 2, language: "en" });
  assert.deepStrictEqual(f.calls.find((c) => c.url.endsWith("/verify")).body, { codes: ["STC1234"], vin: FVIN, modelText: "Defender 2010", quantity: 2 });
  assert.ok(f.calls.findIndex((c) => c.url.endsWith("/facts")) < f.calls.findIndex((c) => c.url.endsWith("/step")), "facts before the first model call");
  assert.deepStrictEqual(out.toolLog.map((t) => t.tool), ["supplier_facts", "supplier_verify"]);
  assert.strictEqual(out.toolLog[0].purpose, "1 codes, VIN, Defender 2010");
  assert.deepStrictEqual(out.facts.calls, { epc: 2, allmakes: 1 });
  assert.strictEqual(out.facts.codes, 1);
  assert.strictEqual(out.facts.text, FTEXT);
  assert.deepStrictEqual(out.facts.verify.problems, []);
  assert.strictEqual(out.facts.verify.timedOut, false);
  assert.strictEqual(out.result.status, "ready", "a fitting, stocked code trips nothing");
  assert.deepStrictEqual(out.result.physical_checks, [], "the block decoded the VIN and the code fits: no EPC check asked");
});

test("agenticDraft supplier facts: AXLE_FACTS=off calls neither and sends the plain SYSTEM_PROSE", async () => {
  process.env.AXLE_FACTS = "off";
  try {
    const f = factsWorkbench();
    const out = await E.agenticDraft(client(f), FEMAIL, [], {}, "info@budget-parts.nl", { output: "prose", extractor: fakeSdk() });
    assert.ok(f.calls.every((c) => c.url.endsWith("/api/agent/step")), "no facts, no verify");
    assert.strictEqual(f.calls[0].body.systemPrompt, E.SYSTEM_PROSE);
    assert.strictEqual(out.facts, null);
    assert.deepStrictEqual(out.toolLog, []);
  } finally { delete process.env.AXLE_FACTS; }
});

(async () => {
  console.log("agent-client");
  for (const [name, fn] of tests) { await fn(); pass++; console.log("  ok  " + name); }
  console.log(`\n${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
