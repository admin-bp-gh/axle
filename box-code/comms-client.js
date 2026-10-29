"use strict";
// comms-client.js - the Email app's side of Workbench customer comms wave 3 (2026-10-25).
//
// unsubscribe(e, t) and interest(body) call Workbench POST /api/comms/unsubscribe and POST /api/comms/interest
// on loopback (AGENT_URL, default http://127.0.0.1:8485) with the shared AGENT_TOKEN, cut at 3 s. Each returns
// { status, data }; an unreachable Workbench, a timeout or a missing token gives { status: 0, data: {} }.
//
// handleUnsubscribeMail(email) is the triage rule for the mailto fallback: a subject "Unsubscribe <token>"
// (rules.unsubscribeToken) is forwarded with the sender's address; on { ok: true } the mail is marked read and
// ingest skips it, otherwise it is left for a human. Audited as comms_unsubscribe with a hash of the token.
//
// notifyStock({ sku, email, lang, workItemId, user }) is the "Notify when back in stock" quick action: it
// records the customer's interest with source 'axle' and answers "recorded", "already" or "failed".
//
// guard(req) and replies(since, emails) serve GET /api/replies for Workbench's nightly outcomes pass: loopback
// only, no Tailscale Serve header, X-Agent-Token compared in constant time against AGENT_TOKEN.
const crypto = require("crypto");
const rules = require("./rules.js");
const { db, audit } = require("./db.js");

const DEFAULT_URL = "http://127.0.0.1:8485";   // Workbench's WORKBENCH_BIND:WORKBENCH_PORT default
const TIMEOUT_MS = 3000;
const LANGS = ["en", "nl", "de", "fr"];
const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 12);

async function post(path, body, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  if (!env.AGENT_TOKEN) return { status: 0, data: {} };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(String(env.AGENT_URL || DEFAULT_URL).replace(/\/+$/, "") + path, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Agent-Token": env.AGENT_TOKEN },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    let data = {};
    try { data = JSON.parse(await res.text()) || {}; } catch (e) { /* not JSON: treated as a failure */ }
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: {} };
  } finally {
    clearTimeout(timer);
  }
}

const unsubscribe = (e, t, o) => post("/api/comms/unsubscribe", { e, t }, o);
const interest = (body, o) => post("/api/comms/interest", body, o);

// true when the mail was handled (Workbench recorded the unsubscribe and the mail was marked read).
async function handleUnsubscribeMail(email, { mailbox, markRead, o } = {}) {
  const token = rules.unsubscribeToken(email.subject);
  if (!token) return false;
  const from = String((email.from && email.from.address) || "").trim().toLowerCase();
  const r = await unsubscribe(from, token, o);
  const ok = r.status === 200 && r.data.ok === true;
  let read = false;
  if (ok && markRead) read = !!(await markRead(mailbox, email.id)).ok;
  audit("system", "comms_unsubscribe", null, `${ok ? "ok" : "left " + (r.data.error || r.status)} ${from} token#${hash(token)}${read ? ", marked read" : ""}`);
  return ok;
}

async function notifyStock({ sku, email, lang, workItemId, user }, o) {
  const body = { sku: String(sku || "").trim().toUpperCase().slice(0, 50), email: String(email || "").trim().toLowerCase(),
    lang: LANGS.includes(lang) ? lang : "en", source: "axle" };
  const r = body.sku && body.email ? await interest(body, o) : { status: 400, data: { error: "bad_input" } };
  const result = r.status === 200 && r.data.ok ? (r.data.already ? "already" : "recorded") : "failed";
  audit(user, "comms_interest", workItemId, `${result} ${body.sku} ${body.email}${result === "failed" ? " " + (r.data.error || r.status) : ""}`);
  return { result, error: r.data.error || null };
}

function guard(req, env = process.env) {
  const ip = String((req.socket && req.socket.remoteAddress) || "");
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip)) return false;
  if (req.headers["tailscale-user-login"] || req.headers["tailscale-user-name"]) return false;
  const want = Buffer.from(String(env.AGENT_TOKEN || "")), got = Buffer.from(String(req.headers["x-agent-token"] || ""));
  return want.length > 0 && want.length === got.length && crypto.timingSafeEqual(want, got);
}

// The first inbound message per address after `since`, from the stored thread messages. Our own mailboxes
// are never in the list Workbench sends, so a message from one of the addresses is the customer's own.
function replies(since, emails) {
  const at = new Date(since);
  if (isNaN(at)) return null;
  const sinceIso = at.toISOString().slice(0, 19) + "Z";
  const list = [...new Set(String(emails || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))].slice(0, 500);
  const out = [];
  for (let i = 0; i < list.length; i += 100) {
    const chunk = list.slice(i, i + 100);
    out.push(...db.prepare(`SELECT lower(from_addr) AS email, MIN(received) AS at FROM messages
      WHERE lower(from_addr) IN (${chunk.map(() => "?").join(",")}) AND received > ? GROUP BY lower(from_addr)`).all(...chunk, sinceIso));
  }
  return out;
}

module.exports = { unsubscribe, interest, handleUnsubscribeMail, notifyStock, guard, replies, DEFAULT_URL, TIMEOUT_MS };
