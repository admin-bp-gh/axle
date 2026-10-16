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

(async () => {
  console.log("agent-client");
  for (const [name, fn] of tests) { await fn(); pass++; console.log("  ok  " + name); }
  console.log(`\n${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
