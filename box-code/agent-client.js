"use strict";
// agent-client.js - Axle's drafting model calls through Workbench's shared agent (AI parity piece 2a).
//
// createAgentClient() returns an object with messages.create(params) shaped like the Anthropic SDK's,
// so engine.agenticDraft keeps its own loop, tools and gates and only the transport changes: each call
// is one POST /api/agent/step on the local Workbench (channel axle-draft), which picks the model,
// effort and max_tokens from its channel profile and puts its knowledge pack in front of the prompt.
//   params.system          -> systemPrompt (Axle's own rules, the last system block, uncached)
//   params.extra_knowledge -> extraKnowledge (K.block(): business knowledge + Teach entries, cached)
//   params.messages/tools  -> passed through as they are (media blocks included)
//   round                  -> 1 + the assistant turns already in params.messages (stateless)
// The reply comes back as an SDK Message: content, stop_reason, model and usage with the SDK's names.
// Errors carry .status: 429 max_rounds, 502 timeout or model_error (a model refusal of 400 or 413
// keeps that status, so the media fallback in agenticDraft still applies), 503 busy is retried once
// after 2 s. Each call is cut at 130 s (Workbench cuts the step itself at 120 s).
//
// runTool(name, input) runs one of Workbench's shared tools (the JLR EPC lookups, AI parity Step A) through
// POST /api/agent/tool with the same token, cut at 30 s; a refused or failed call throws, a failed lookup
// comes back as its { error } result.
//
// draftingClient(sdk) is the one switch: AXLE_AGENT=step with AGENT_TOKEN set gives the agent client,
// anything else gives back the SDK client unchanged. Haiku calls (classify, translate) never use it.

const DEFAULT_URL = "http://127.0.0.1:8485";   // Workbench's WORKBENCH_BIND:WORKBENCH_PORT default
const CHANNEL = "axle-draft";
const CALL_TIMEOUT_MS = 130000;
const TOOL_TIMEOUT_MS = 30000;
const BUSY_WAIT_MS = 2000;

const roundOf = (messages) => 1 + (messages || []).filter((m) => m && m.role === "assistant").length;

function stepError(message, status, code) {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
}

function createAgentClient({ baseUrl = DEFAULT_URL, token, channel = CHANNEL, fetchImpl = globalThis.fetch,
  timeoutMs = CALL_TIMEOUT_MS, busyWaitMs = BUSY_WAIT_MS } = {}) {
  const base = String(baseUrl).replace(/\/+$/, "");
  const url = base + "/api/agent/step";
  const toolUrl = base + "/api/agent/tool";

  async function post(body, target = url, limitMs = timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), limitMs);
    try {
      const res = await fetchImpl(target, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Agent-Token": token },
        body,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch (e) { /* an HTML error page, e.g. a 413 from the body parser */ }
      return { status: res.status, data: data || {}, text };
    } catch (e) {
      if (ctrl.signal.aborted) throw stepError(`agent call timed out after ${Math.round(limitMs / 1000)} s`, undefined, "timeout");
      throw stepError(`agent unreachable at ${target}: ${e.message}`, undefined, "unreachable");
    } finally {
      clearTimeout(timer);
    }
  }

  async function create(params) {
    const body = JSON.stringify({
      channel,
      systemPrompt: params.system,
      ...(params.extra_knowledge ? { extraKnowledge: params.extra_knowledge } : {}),
      messages: params.messages,
      tools: params.tools || [],
      round: roundOf(params.messages),
    });
    let r = await post(body);
    if (r.status === 503 && r.data.error === "busy") {
      await new Promise((ok) => setTimeout(ok, busyWaitMs));
      r = await post(body);
    }
    if (r.status !== 200) {
      const what = r.data.error || r.text.slice(0, 120).replace(/\s+/g, " ");
      const detail = r.data.detail ? `: ${r.data.detail}` : "";
      // Workbench reports a model error as 502 with the SDK's message, which starts with the API status.
      const upstream = r.status === 502 && /^(400|413)\b/.exec(String(r.data.detail || ""));
      throw stepError(`agent step ${r.status} ${what}${detail}`, upstream ? Number(upstream[1]) : r.status, r.data.error);
    }
    const u = r.data.usage || {};
    return {
      type: "message", role: "assistant",
      content: r.data.content || [],
      stop_reason: r.data.stop_reason || null,
      model: r.data.model,
      usage: {
        input_tokens: u.input || 0, output_tokens: u.output || 0,
        cache_read_input_tokens: u.cacheRead || 0, cache_creation_input_tokens: u.cacheWrite || 0,
      },
      policy: r.data.policy,
    };
  }

  async function runTool(name, input) {
    const r = await post(JSON.stringify({ name, input }), toolUrl, TOOL_TIMEOUT_MS);
    if (r.status !== 200) throw stepError(`agent tool ${r.status} ${r.data.error || r.text.slice(0, 120)}`, r.status, r.data.error);
    return r.data.result;
  }

  return { isAgentStep: true, channel, url, messages: { create }, runTool };
}

let announced = false;
function draftingClient(sdk, env = process.env, log = console.log) {
  const step = env.AXLE_AGENT === "step";
  const client = step && env.AGENT_TOKEN
    ? createAgentClient({ baseUrl: env.AGENT_URL || DEFAULT_URL, token: env.AGENT_TOKEN })
    : sdk;
  if (!announced) {
    announced = true;
    log(client.isAgentStep ? `[axle] drafting through the Workbench shared agent (${client.url}, channel ${CHANNEL})`
      : step ? "[axle] AXLE_AGENT=step but AGENT_TOKEN is not set: drafting directly through the Anthropic API"
      : "[axle] drafting directly through the Anthropic API");
  }
  return client;
}

module.exports = { createAgentClient, draftingClient, roundOf, DEFAULT_URL, CHANNEL, CALL_TIMEOUT_MS, TOOL_TIMEOUT_MS };
