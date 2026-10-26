// print-view.js - the print view of an email (A4, 26 Oct 2026; print round 2 the same day).
// GET /item/:id/print?scope=one|thread[&atts=1] always answers a PDF (print-attachments.js renders
// this page with the headless Edge), so the printout has no browser date or URL lines and looks the
// same on a Mac and on Windows. This file builds the page: a slim branded header, per message a
// header block (from, to, cc, full date, subject, customer and SAP documents) and the body cleaned
// for paper: link targets and image alt text dropped, our own and the sender's signature, footer and
// disclaimer reduced to one quiet line, inline photos placed where the message has them.
// render() with autoPrint is also the fallback page when the PDF cannot be made.
"use strict";
const { esc, t, parseTS, TZ, splitQuoted, segmentQuoted, foldFooter } = require("./views/ui.js");

const addr = (p) => p && (p.name && p.address ? `${p.name} <${p.address}>` : p.address || p.name || "");
const list = (a) => (a || []).map(addr).filter(Boolean).join(", ");
const mailboxAddr = (mb) => !mb ? "" : mb.includes("@") ? mb : `${mb}@budget-parts.nl`;

// "Thursday 23 October 2026, 07:46" / "donderdag 23 oktober 2026 om 07:46", Dutch time.
function fullDate(iso, lang) {
  const d = parseTS(iso);
  if (!iso || isNaN(d)) return String(iso || "");
  return new Intl.DateTimeFormat(lang === "nl" ? "nl-NL" : "en-GB", { timeZone: TZ, weekday: "long", day: "numeric",
    month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

// --- Body cleaning -------------------------------------------------------------------------------
// Image markers a text body carries: Outlook's [cid:name@id] and Apple Mail's <IMG_1234.jpeg> line.
const IMG_MARK = /\[cid:([^\]\s]+)\]|^[ \t]*<([^<>\n]+\.(?:jpe?g|png|gif|webp))>[ \t]*$/gim;
// Alt text Outlook writes for a picture it cannot show ("[A green and black sign Description
// automatically generated]"), EN and NL.
const ALT_TEXT = /\[[^\]\n]*(Description automatically generated|Beschrijving automatisch gegenereerd)[^\]\n]*\](<[^<>\s]*>)?/gi;
// The lines of our own signature block (both warehouses, KvK, BTW).
const OUR_SIG = /^(Gouda|Drachten)$|Kampenringweg|Het Gangboord|^(2803 PE|9206 BJ)\b|^[\w.+-]+@budget-parts\.nl$|^(KvK|BTW|VAT)\s*:/i;

// Text kept, noise dropped: "text<https://...>" (no space: Outlook's link target) keeps "text", "<mailto:a@b>" keeps the address,
// alt text and Outlook's ____ separator go.
function cleanText(text) {
  return String(text || "").replace(/\r\n?/g, "\n").replace(/﻿/g, "")
    .replace(ALT_TEXT, "")
    .replace(/(\S)<(?:https?:\/\/|mailto:)[^<>\s]*>/gi, "$1")
    .replace(/<mailto:([^<>\s]+)>/gi, "$1")
    .replace(/<(https?:\/\/[^<>\s]+)>/gi, "$1")
    .replace(/^[ \t]*_{8,}[ \t]*$/gm, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n").trim();
}

// The signature fold, as the item view does it (ui.js foldFooter: from the first disclaimer line
// down) plus our own address block at the end of a message. { text, folded }.
function stripSignature(text) {
  const { main, footer } = foldFooter(text);
  const lines = main.split("\n");
  let end = lines.length, cut = false;
  while (end > 0 && (!lines[end - 1].trim() || OUR_SIG.test(lines[end - 1].trim()))) { if (lines[end - 1].trim()) cut = true; end--; }
  return { text: lines.slice(0, end).join("\n").trim(), folded: !!footer || cut };
}

// Comparable text: no quote marks, image markers or spacing, lower case.
const flat = (s) => String(s).replace(IMG_MARK, "").replace(/^[ \t]*>+ ?/gm, "").replace(/\s+/g, " ").trim().toLowerCase();
// A message's own words (no quoted part, no signature), the key its quoted copies are found by.
const ownKey = (body) => flat(stripSignature(splitQuoted(cleanText(body)).top).text).slice(0, 60);

// A quoted block's header lines (From, Sent, To, Cc, Subject in EN, NL, DE) or its one marker line.
const HDR = { from: /^(From|Van|Von|Fra|Från)$/i, date: /^(Sent|Date|Verzonden|Datum|Gesendet)$/i, to: /^(To|Aan|An)$/i, cc: /^Cc$/i, subject: /^(Subject|Onderwerp|Betreff)$/i };
function parseQuoted(seg) {
  const lines = seg.replace(/^[ \t]*>+ ?/gm, "").split("\n");
  const head = {};
  let i = 0, caption = "";
  while (i < lines.length && !lines[i].trim()) i++;
  if (/^\s*-{2,}.+-{2,}\s*$/.test(lines[i] || "")) caption = lines[i++].replace(/-{2,}/g, "").trim();
  else if (/\b(wrote|schrieb|schreef)\s*:?\s*$/i.test(lines[i] || "")) caption = lines[i++].trim();
  for (; i < lines.length; i++) {
    const m = /^\s*([A-Za-z]+)\s*:\s*(.*)$/.exec(lines[i]);
    const k = m && Object.keys(HDR).find((x) => HDR[x].test(m[1]));
    if (!k || head[k]) break;
    head[k] = m[2].trim();
  }
  return { caption, head, text: lines.slice(i).join("\n").trim() };
}

// The blocks of one message: its own text, then each quoted part kept (keep(flatText) decides).
function blocksOf(body, keep) {
  const { top, quoted } = splitQuoted(cleanText(body));
  const own = stripSignature(top);
  const out = [{ quoted: false, text: own.text, folded: own.folded }];
  for (const seg of quoted ? segmentQuoted(quoted) : []) {
    if (!keep(flat(seg))) continue;
    const q = parseQuoted(seg), s = stripSignature(q.text);
    out.push({ quoted: true, caption: q.caption, head: q.head, text: s.text, folded: s.folded });
  }
  return out;
}

// The messages to print. scope 'one': the item's newest message with everything it quotes. scope
// 'thread': every stored message oldest first; a quoted part is left out only when the message it
// copies is itself printed in the thread, so a forward or a quoted original that is not a message
// of the thread is always kept. An email from before the message store prints from the item.
function messagesFor(w, thread, scope) {
  const subject = w.subject || "";
  if (!thread.length) {
    return [{ from: { name: w.sender_name, address: w.sender_email }, to: [], cc: [], received: w.email_received, subject, attachments: [], blocks: blocksOf(w.email_text || "", () => true) }];
  }
  const pick = scope === "thread" ? thread : [thread.find((m) => m.graphId === w.latest_message_id) || thread[thread.length - 1]];
  const keys = pick.map((m) => ownKey(m.body));
  return pick.map((m, i) => {
    const others = keys.filter((k, j) => j !== i && k.length >= 12);
    return { ...m, subject, blocks: blocksOf(m.body || "", (f) => !others.some((k) => f.includes(k))) };
  });
}

// --- Images ----------------------------------------------------------------------------------------
// A picture under 20 KB is a logo or a signature icon, never printed.
const LOGO_BYTES = 20000;
const isLogo = (a, md) => (md && md.bytes != null ? md.bytes : a.size || 0) < LOGO_BYTES;
// The figure for an image marker in a message's text, or "" (no such picture, a logo, not loaded).
// [cid:name@id] and <name> match by file name; Outlook's [cid:uuid@...] takes the message's next
// inline picture not yet placed, in attachment order.
function placeImage(m, media, cid, name) {
  const imgs = (m.attachments || []).filter((a) => /^image\//i.test(a.contentType || "") && media[a.id] && !isLogo(a, media[a.id]));
  const want = String(name || (cid || "").split("@")[0]).toLowerCase();
  let a = imgs.find((x) => !m.used.has(x.id) && String(x.name).toLowerCase() === want);
  if (!a && cid && !imgs.some((x) => String(x.name).toLowerCase() === want)) a = imgs.find((x) => x.inline && !m.used.has(x.id));
  if (!a) return "";
  m.used.add(a.id);
  return `<figure class="inl"><img src="${media[a.id].dataUri}" alt="${esc(a.name)}"></figure>`;
}

// Text as paragraphs (line breaks kept), image markers as figures in place.
function textHtml(text, img) {
  return String(text || "").split(/\n[ \t]*\n/).filter((p) => p.trim()).map((p) => {
    let out = "", last = 0, figs = "";
    p.replace(IMG_MARK, (all, cid, name, at) => { out += esc(p.slice(last, at)); figs += img(cid, name); last = at + all.length; return all; });
    out = (out + esc(p.slice(last))).trim();
    return (out ? `<p>${out}</p>` : "") + figs;
  }).join("");
}

// refs: { customer: "C12345 Name" | "", docs: ["Order 232416", ...] }. media: { [attId]: { dataUri,
// bytes } } for the printed messages' pictures. msgs: messagesFor's result when the caller has it.
// extra(m, i): the block under message i (print-attachments.js: its attachments).
// shrink: photos redrawn at most 1600 px as JPEG before printing (the headless Edge otherwise
// stores a phone photo it has to turn upright uncompressed, 20 MB a page); needs htmlToPdf's
// virtualTimeMs so the script finishes first.
const SHRINK = `<script>addEventListener("load", function () { Array.from(document.images).forEach(function (i) { try {
  const k = Math.min(1, 1600 / Math.max(i.naturalWidth, i.naturalHeight)), c = document.createElement("canvas");
  c.width = Math.round(i.naturalWidth * k); c.height = Math.round(i.naturalHeight * k);
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(i, 0, 0, c.width, c.height);
  i.src = c.toDataURL("image/jpeg", 0.85); } catch (e) { /* printed as it is */ } }); });</script>`;
function render(w, thread, { scope, lang, refs, media = {}, msgs, extra, autoPrint = true, shrink = false }) {
  const L = (k) => esc(t(lang, k));
  msgs = msgs || messagesFor(w, thread, scope === "thread" ? "thread" : "one");
  const row = (k, v) => v ? `<tr><th>${L(k)}</th><td>${esc(v)}</td></tr>` : "";
  const head = (m) => `<table class="h">${row("pr_from", addr(m.from))}${row("pr_to", list(m.to))}${row("pr_cc", list(m.cc))}
    ${row("pr_date", fullDate(m.received, lang))}${row("pr_subject", m.subject)}
    ${row("pr_customer", refs && refs.customer)}${row("pr_docs", refs && refs.docs && refs.docs.join(", "))}</table>`;
  const qhead = (b) => {
    const r = [["pr_from", b.head.from], ["pr_date", b.head.date], ["pr_to", b.head.to], ["pr_cc", b.head.cc], ["pr_subject", b.head.subject]].map(([k, v]) => row(k, v)).join("");
    return `<div class="qh">${b.caption ? `<p class="cap">${esc(b.caption)}</p>` : ""}${r ? `<table class="h">${r}</table>` : ""}</div>`;
  };
  const folded = `<p class="fold">${L("pr_footer_omitted")}</p>`;
  const body = msgs.map((m, i) => {
    m.used = m.used || new Set();
    const img = (cid, name) => placeImage(m, media, cid, name);
    const blocks = m.blocks.map((b) => b.quoted
      ? `<blockquote>${qhead(b)}<div class="b">${textHtml(b.text, img)}</div>${b.folded ? folded : ""}</blockquote>`
      : `<div class="b">${textHtml(b.text, img)}</div>${b.folded ? folded : ""}`).join("");
    return `<article><div class="mh">${head(m)}</div>${blocks}${extra ? extra(m, i) : ""}</article>`;
  }).join("");
  const mb = esc(mailboxAddr(w.mailbox));
  return `<!doctype html><html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(w.subject || "Email")}</title>
<style>
  @page { size: A4; margin: 16mm 16mm 18mm; @top-left { content: "Budget Parts B.V.  \\00B7  ${mb}"; font: 8pt Arial, sans-serif; color: #777; } }
  @page :first { @top-left { content: none; } }
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font: 10.5pt/1.5 "Segoe UI", -apple-system, Roboto, Arial, sans-serif; color: #1a1a1a; background: #fff; }
  .brand { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #1f5f3f; padding-bottom: 6px; margin-bottom: 14px; }
  .brand b { font-size: 13pt; color: #1f5f3f; letter-spacing: .2px; }
  .brand span { font-size: 9pt; color: #555; }
  article + article { margin-top: 10mm; padding-top: 6mm; border-top: 1px solid #ccc; }
  .mh { background: #f4f6f5; border: 1px solid #e0e4e2; border-radius: 4px; padding: 8px 10px; margin-bottom: 12px; break-inside: avoid; }
  .h { border-collapse: collapse; width: 100%; font-size: 9.5pt; }
  .h th { text-align: left; vertical-align: top; padding: 1px 12px 1px 0; width: 82px; color: #5a5a5a; font-weight: 600; white-space: nowrap; }
  .h td { padding: 1px 0; word-break: break-word; }
  .b p { margin: 0 0 8px; white-space: pre-wrap; word-break: break-word; orphans: 2; widows: 2; }
  .fold { margin: 2px 0 10px; font-size: 8.5pt; font-style: italic; color: #888; }
  blockquote { margin: 12px 0 0; padding: 0 0 0 10px; border-left: 3px solid #cfd6d2; }
  .qh { margin-bottom: 8px; color: #555; }
  .qh .h { font-size: 8.5pt; }
  .qh .cap { margin: 0 0 4px; font-size: 8.5pt; font-style: italic; }
  figure { margin: 6px 0 10px; break-inside: avoid; }
  figure.inl { display: inline-block; vertical-align: top; margin: 4px 3mm 8px 0; max-width: 100%; }
  figure img { display: block; max-width: 100%; max-height: 95mm; object-fit: contain; }
  .atts { margin-top: 12px; }
  .atts h4 { margin: 0 0 6px; font-size: 9pt; text-transform: uppercase; letter-spacing: .4px; color: #5a5a5a; }
  .grid { display: flex; flex-wrap: wrap; gap: 4mm; }
  .grid figure { margin: 0; width: 100%; }
  .grid figure.half { width: calc(50% - 2mm); }
  .grid img { width: 100%; max-height: 115mm; object-fit: contain; object-position: left top; }
  .grid figure.half img { max-height: 95mm; }
  figcaption, .atts ul { font-size: 8.5pt; color: #666; }
  .atts ul { margin: 6px 0 0; padding-left: 16px; }
  @media screen { body { max-width: 760px; margin: 0 auto; padding: 16px; } }
</style></head><body><header class="brand"><b>Budget Parts B.V.</b><span>${mb}</span></header>${body}
${shrink ? SHRINK : ""}${autoPrint ? `<script>addEventListener("load", function () { setTimeout(function () { print(); }, 50); });</script>` : ""}
</body></html>`;
}

module.exports = { render, messagesFor, cleanText, stripSignature, blocksOf, fullDate, isLogo, LOGO_BYTES };
