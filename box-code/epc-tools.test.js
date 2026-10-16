// epc-tools.test.js - the JLR EPC lookups in Axle (AI parity Step A): offered only through the Workbench
// agent, run through POST /api/agent/tool with the token, the reply rules that use them (SYSTEM_EPC), the
// VIN claim gate standing down once a VIN was decoded, and the EPC physical check skipped once a part was
// checked against the VIN. No network: a fake fetch.
// Run: node epc-tools.test.js
const assert = require("assert");
process.env.AXLE_DB = ":memory:";   // agenticDraft reads the Teach entries: never the live database
const AC = require("./agent-client.js");
const T = require("./agent-tools.js");
const E = require("./engine.js");

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const VIN = "SALLPAMW8WA388595";

const reply = (status, body) => ({ status, text: async () => JSON.stringify(body) });
function fakeFetch(answer) {
  const f = async (url, init) => { f.calls.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return answer(url, JSON.parse(init.body)); };
  f.calls = [];
  return f;
}
const client = (fetchImpl) => AC.createAgentClient({ baseUrl: "http://127.0.0.1:8485", token: "s3cret", fetchImpl, busyWaitMs: 5 });

test("tool defs: EPC tools only through the agent", () => {
  const names = (l) => l.map((t) => t.name);
  assert.deepStrictEqual(names(T.toolDefsFor(false)), names(T.toolDefs));
  assert.deepStrictEqual(names(T.toolDefsFor(true)).slice(-3), ["epc_vin_decode", "epc_part_lookup", "epc_supersession"]);
  assert.ok(T.epcToolDefs.every((t) => t.input_schema.required.includes("purpose")));
});

test("runTool: an EPC tool goes to /api/agent/tool with the token, purpose stripped", async () => {
  const f = fakeFetch(() => reply(200, { result: { found: true, vin: VIN, engine: "M51 2.5 Diesel" } }));
  const out = await T.runTool("epc_vin_decode", { vin: VIN, purpose: "engine" }, { agent: client(f) });
  assert.strictEqual(out.engine, "M51 2.5 Diesel");
  assert.strictEqual(f.calls[0].url, "http://127.0.0.1:8485/api/agent/tool");
  assert.strictEqual(f.calls[0].headers["X-Agent-Token"], "s3cret");
  assert.deepStrictEqual(f.calls[0].body, { name: "epc_vin_decode", input: { vin: VIN } });
});

test("runTool: a refused tool call throws, no agent throws", async () => {
  const f = fakeFetch(() => reply(401, { error: "bad_token" }));
  await assert.rejects(T.runTool("epc_part_lookup", { code: "ERR5205" }, { agent: client(f) }), /agent tool 401 bad_token/);
  await assert.rejects(T.runTool("epc_part_lookup", { code: "ERR5205" }, {}), /Workbench agent/);
});

test("SYSTEM_EPC: the VIN rule replaced, the not-stocked rule added, everything else the same", () => {
  assert.ok(E.SYSTEM.includes("VIN: you CANNOT decode a VIN."));
  assert.ok(!E.SYSTEM_EPC.includes("you CANNOT decode a VIN"));
  assert.ok(E.SYSTEM_EPC.includes("call epc_vin_decode FIRST"));
  assert.ok(E.SYSTEM_EPC.includes("PART NOT IN OUR CATALOGUE"));
  assert.ok(E.SYSTEM_EPC.includes("unless epc_part_lookup with the customer's VIN returned applicableToVin=true"));
  const a = E.SYSTEM.split("\n"), b = E.SYSTEM_EPC.split("\n");
  assert.strictEqual(b.length, a.length + 1);
  const differ = b.filter((l) => !a.includes(l));
  assert.strictEqual(differ.length, 3, "VIN rule, confidence gate line, not-stocked rule");
  assert.ok(!/[\u2013\u2014]/.test(differ.join("")), "no dashes in the new rules");
});

test("claim gate: a decode allows what the VIN shows, a fit claim needs EPC's part check; sourcing always held", () => {
  const ready = (draft) => ({ status: "ready", draft, interim_draft: "", questions_for_salesperson: [], physical_checks: [], confidence: "high" });
  const shows = "Your VIN shows the M51 2.5 diesel with the 5-speed manual gearbox.";
  const fits = "The ERR5205 flywheel fits your VIN.";
  const decoded = { epcVins: new Set([VIN]), epcPartVins: new Set() };
  assert.strictEqual(E.applyClaimGate(ready(shows)).status, "awaiting_input");
  assert.strictEqual(E.applyClaimGate(ready(shows), decoded).status, "ready");
  assert.strictEqual(E.applyClaimGate(ready(fits), decoded).status, "awaiting_input", "decode alone does not prove a part");
  assert.strictEqual(E.applyClaimGate(ready("De ERR5205 past bij uw chassisnummer."), decoded).status, "awaiting_input");
  assert.strictEqual(E.applyClaimGate(ready(fits), { ...decoded, epcPartVins: new Set([VIN]) }).status, "ready");
  assert.strictEqual(E.applyClaimGate(ready("It ships directly from our supplier."), { ...decoded, epcPartVins: new Set([VIN]) }).status, "awaiting_input");
});

test("VIN check: skipped once a part was checked against that VIN in EPC", () => {
  const r = () => ({ status: "ready", draft: "Dear Carlos, ...", physical_checks: [], questions_for_salesperson: [] });
  assert.strictEqual(E.applyVinCheck(r(), `my VIN is ${VIN}`).physical_checks.length, 1);
  assert.strictEqual(E.applyVinCheck(r(), `my VIN is ${VIN}`, new Set([VIN])).physical_checks.length, 0);
  assert.strictEqual(E.applyVinCheck(r(), `my VIN is ${VIN}`, new Set(["SALLAAAG4BA594737"])).physical_checks.length, 1);
});

test("agenticDraft: a part EPC does not apply to the VIN keeps the EPC check; compose gets no EPC tools", async () => {
  const FINAL = JSON.stringify({ language: "en", status: "ready", draft: "Dear Carlos,\n\nThe flywheel is ERR5205.\n\nKind regards", interim_draft: "",
    questions_for_salesperson: [], physical_checks: [], injection_suspected: false, confidence: "high" });
  let step = 0;
  const f = fakeFetch((url) => {
    if (url.endsWith("/api/agent/tool")) return reply(200, { result: { code: "ERR5205", vin: VIN, results: [{ part: "ERR5205", applicableToVin: false }] } });
    step++;
    if (step === 1) return reply(200, { content: [{ type: "tool_use", id: "t1", name: "epc_part_lookup", input: { code: "ERR5205", vin: VIN, purpose: "fit" } }], stop_reason: "tool_use", usage: {}, model: "m", policy: {} });
    return reply(200, { content: [{ type: "text", text: FINAL }], stop_reason: "end_turn", usage: {}, model: "m", policy: {} });
  });
  const email = { from: { name: "Carlos", address: "carlos@example.com" }, subject: "Flywheel", received: "2026-10-16T09:00:00Z", text: `Flywheel please, VIN ${VIN}` };
  const { result } = await E.agenticDraft(client(f), email, [], {}, "info@budget-parts.nl");
  assert.strictEqual(result.physical_checks.length, 1, "EPC check kept: the part was not confirmed for the VIN");

  const g = fakeFetch(() => reply(200, { content: [{ type: "text", text: FINAL }], stop_reason: "end_turn", usage: {}, model: "m", policy: {} }));
  await E.agenticDraft(client(g), null, [], {}, "info@budget-parts.nl", { system: "COMPOSE RULES", userContent: "compose", senderAddr: "carlos@example.com" });
  assert.ok(!g.calls[0].body.tools.some((t) => t.name.startsWith("epc_")), "compose: no EPC tools");
});

test("agenticDraft through the agent: EPC tools offered, results feed the gates", async () => {
  const FINAL = JSON.stringify({ language: "en", status: "ready", draft: "Dear Carlos,\n\nYour VIN shows the M51 2.5 diesel, so the flywheel is ERR5205.\n\nKind regards", interim_draft: "",
    questions_for_salesperson: [], physical_checks: [], injection_suspected: false, confidence: "high", fitment_confirmed: true });
  let step = 0;
  const f = fakeFetch((url, body) => {
    if (url.endsWith("/api/agent/tool")) {
      return reply(200, { result: body.name === "epc_vin_decode" ? { found: true, vin: VIN, engine: "M51 2.5 Diesel" } : { code: "ERR5205", vin: VIN, results: [{ part: "ERR5205", applicableToVin: true }] } });
    }
    step++;
    if (step === 1) return reply(200, { content: [
      { type: "tool_use", id: "t1", name: "epc_vin_decode", input: { vin: VIN, purpose: "engine" } },
      { type: "tool_use", id: "t2", name: "epc_part_lookup", input: { code: "ERR5205", vin: VIN, purpose: "fit" } },
    ], stop_reason: "tool_use", usage: {}, model: "m", policy: {} });
    return reply(200, { content: [{ type: "text", text: FINAL }], stop_reason: "end_turn", usage: {}, model: "m", policy: {} });
  });
  const email = { from: { name: "Carlos", address: "carlos@example.com" }, subject: "Flywheel", received: "2026-10-16T09:00:00Z", text: `Flywheel for my P38, VIN ${VIN}` };
  const { result, toolLog } = await E.agenticDraft(client(f), email, [], {}, "info@budget-parts.nl");
  const stepCalls = f.calls.filter((c) => c.url.endsWith("/api/agent/step"));
  assert.ok(stepCalls[0].body.tools.some((t) => t.name === "epc_vin_decode"));
  assert.strictEqual(stepCalls[0].body.systemPrompt, E.SYSTEM_EPC);
  assert.deepStrictEqual(toolLog.map((t) => [t.tool, t.ok, t.input]), [["epc_vin_decode", true, VIN], ["epc_part_lookup", true, `ERR5205 ${VIN}`]]);
  assert.strictEqual(result.status, "ready", "VIN claim allowed after the decode");
  assert.strictEqual(result.physical_checks.length, 0, "no EPC check asked: the part was checked against the VIN");
});

(async () => {
  console.log("epc-tools");
  for (const [name, fn] of tests) { await fn(); pass++; console.log("  ok  " + name); }
  console.log(`\n${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
