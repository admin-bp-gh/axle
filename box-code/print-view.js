// print-view.js - the print view of an email (A4, 26 Oct 2026). GET /item/:id/print?scope=one|thread
// renders a bare page (no app chrome) in a new top-level window and opens the print dialog, so the
// printout is the email, never the Workbench shell that frames Axle. Per message a clean header:
// from, to, cc, date, subject, and the customer and SAP documents Axle already shows for the item.
"use strict";
const { esc, t, fmtDateTime, splitQuoted, paras } = require("./views/ui.js");

const addr = (p) => p && (p.name && p.address ? `${p.name} <${p.address}>` : p.address || p.name || "");
const list = (a) => (a || []).map(addr).filter(Boolean).join(", ");

// The messages to print. scope 'one': the item's newest message, whole. scope 'thread': every
// stored message oldest first, each with its own text only (the quoted copies would repeat).
// An email from before the message store prints from the item itself.
function messagesFor(w, thread, scope) {
  if (!thread.length) {
    return [{ from: { name: w.sender_name, address: w.sender_email }, to: [], cc: [], received: w.email_received, body: w.email_text || "" }];
  }
  if (scope === "thread") return thread.map((m) => ({ ...m, body: splitQuoted(m.body).top || m.body }));
  const newest = thread.find((m) => m.graphId === w.latest_message_id) || thread[thread.length - 1];
  return [newest];
}

// refs: { customer: "C12345 Name" | "", docs: ["Order 232416", ...] }
function render(w, thread, { scope, lang, refs }) {
  const L = (k) => esc(t(lang, k));
  const msgs = messagesFor(w, thread, scope === "thread" ? "thread" : "one");
  const row = (k, v) => v ? `<tr><th>${L(k)}</th><td>${esc(v)}</td></tr>` : "";
  const head = (m) => `<table class="h">${row("pr_from", addr(m.from))}${row("pr_to", list(m.to))}${row("pr_cc", list(m.cc))}
    ${row("pr_date", fmtDateTime(m.received, lang))}${row("pr_subject", w.subject || "")}
    ${row("pr_customer", refs && refs.customer)}${row("pr_docs", refs && refs.docs && refs.docs.join(", "))}</table>`;
  const body = msgs.map((m) => `<article>${head(m)}<div class="b">${paras(m.body || "")}</div></article>`).join("");
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(w.subject || "Email")}</title>
<style>
  body { margin: 0; padding: 16px; font: 14px/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111; background: #fff; }
  article { max-width: 760px; margin: 0 auto 28px; }
  article + article { border-top: 1px solid #bbb; padding-top: 20px; }
  .h { border-collapse: collapse; margin-bottom: 12px; width: 100%; }
  .h th { text-align: left; vertical-align: top; padding: 2px 12px 2px 0; width: 90px; color: #555; font-weight: 600; }
  .h td { padding: 2px 0; word-break: break-word; }
  .b p { margin: 0 0 8px; white-space: pre-wrap; word-break: break-word; }
  .b a { color: inherit; }
  @media print { body { padding: 0; } article { break-inside: auto; } article + article { break-before: auto; } }
</style></head><body>${body}
<script>addEventListener("load", function () { setTimeout(function () { print(); }, 50); });</script>
</body></html>`;
}

module.exports = { render, messagesFor };
