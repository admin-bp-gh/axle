// print-attachments.js - the print PDF (A4, 26 Oct 2026; print round 2 the same day). GET
// /item/:id/print always answers one PDF: the email or thread (print-view.js) rendered by the
// headless Edge in claim-statement.js, page numbers stamped with pdf-lib. With "Include attachments"
// (atts=1) each message's pictures follow it (two to a row when small or upright), then every PDF
// attachment is appended in message order, each from a new page with a small label naming the file.
// Anything else (Word, Excel, zip...) is listed by name as not printable here, and so is a PDF that
// is damaged or encrypted: one bad file never fails the whole print. Inline photos of a message
// print in place whether or not attachments are included.
"use strict";
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const PV = require("./print-view.js");
const { esc, t } = require("./views/ui.js");

const IMG = /^image\/(png|jpeg|gif|webp)$/;

// Pixel size of a PNG, GIF or JPEG (webp and anything odd: null).
function imageSize(b) {
  if (!b || b.length < 24) return null;
  if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b[0] === 0x47 && b[1] === 0x49) return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) { i++; continue; }
    const mk = b[i + 1], len = b.readUInt16BE(i + 2);
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  return null;
}

// The pictures of the printed messages: { [attId]: { dataUri, bytes, w, h } }.
async function loadMedia(msgs, readFile) {
  const media = {};
  for (const m of msgs) {
    for (const a of m.attachments || []) {
      if (!IMG.test(a.contentType || "")) continue;
      let buf = null;
      try { buf = await readFile(a); } catch (e) { buf = null; }
      if (buf && buf.length) media[a.id] = { dataUri: `data:${a.contentType};base64,${Buffer.from(buf).toString("base64")}`, bytes: buf.length, ...(imageSize(buf) || {}) };
    }
  }
  return media;
}

// Per message: { pdfs: [{name, doc}], notPrintable: [{name, why}] }; pictures come from media.
// The same file sent again later in the thread (name and size) is printed once.
const fileKey = (a) => `${a.name}|${a.size}`;
async function sortAttachments(msgs, readFile, media = {}) {
  const out = [], seen = new Set();
  for (const m of msgs) {
    const r = { pdfs: [], notPrintable: [] };
    for (const a of m.attachments || []) {
      if (IMG.test(a.contentType || "")) { if (!media[a.id]) r.notPrintable.push({ name: a.name, why: "pr_att_unreadable" }); continue; }
      if (a.contentType !== "application/pdf") { r.notPrintable.push({ name: a.name, why: "pr_att_noprint" }); continue; }
      if (seen.has(fileKey(a))) { r.notPrintable.push({ name: a.name, why: "pr_att_dup" }); continue; }
      let buf = null;
      try { buf = await readFile(a); } catch (e) { buf = null; }
      if (!buf || !buf.length) { r.notPrintable.push({ name: a.name, why: "pr_att_unreadable" }); continue; }
      // load throws on an encrypted file; a damaged one can load with no pages at all.
      let doc = null;
      try { doc = await PDFDocument.load(buf); if (!(doc.getPageCount() > 0)) doc = null; } catch (e) { doc = null; }
      if (doc) { r.pdfs.push({ name: a.name, doc }); seen.add(fileKey(a)); }
      else r.notPrintable.push({ name: a.name, why: "pr_att_broken" });
    }
    out.push(r);
  }
  return out;
}

// Half a row: a small picture (1200 px or less) or an upright one.
const half = (md) => md.w && md.h && (Math.max(md.w, md.h) <= 1200 || md.h > md.w);

// The block printed under one message: its pictures not already placed in the text (logos never),
// then the list of PDFs (appended at the end) and files that cannot be printed.
// seen: the pictures already printed higher up (name and size), shared across the messages.
function attachmentsHtml(m, r, media, lang, seen = new Set()) {
  const L = (k) => esc(t(lang, k));
  const used = m.used || new Set();
  (m.attachments || []).filter((a) => used.has(a.id)).forEach((a) => seen.add(fileKey(a)));
  const imgs = (m.attachments || []).filter((a) => media[a.id] && !used.has(a.id) && !PV.isLogo(a, media[a.id]) && !seen.has(fileKey(a)) && seen.add(fileKey(a)))
    .map((a) => `<figure${half(media[a.id]) ? ' class="half"' : ""}><img src="${media[a.id].dataUri}" alt="${esc(a.name)}"><figcaption>${esc(a.name)}</figcaption></figure>`).join("");
  const rows = r.pdfs.map((p) => `<li>${esc(p.name)}: ${L("pr_att_pdf")}</li>`)
    .concat(r.notPrintable.map((n) => `<li>${esc(n.name)}: ${L(n.why)}</li>`)).join("");
  return imgs || rows ? `<div class="atts"><h4>${L("pr_atts")}</h4>${imgs ? `<div class="grid">${imgs}</div>` : ""}${rows ? `<ul>${rows}</ul>` : ""}</div>` : "";
}

// Helvetica speaks WinAnsi only: anything else becomes "?".
const ansi = (s) => String(s).replace(/[^\x20-\x7e\xa0-\xff]/g, "?");

// htmlToPdf: claim-statement.js's helper (or a stub in tests) -> { ok, buffer, error }.
// atts: include the attachments (the tick). Answers { ok, buffer } or { ok: false, error }.
async function buildPrintPdf(w, thread, { scope, lang, refs, readFile, htmlToPdf, atts = true }) {
  const msgs = PV.messagesFor(w, thread, scope === "thread" ? "thread" : "one");
  const media = await loadMedia(msgs, readFile);
  const sorted = atts ? await sortAttachments(msgs, readFile, media) : [], seen = new Set();
  const html = PV.render(w, thread, { scope, lang, refs, media, msgs, autoPrint: false, shrink: true, extra: atts ? (m, i) => attachmentsHtml(m, sorted[i], media, lang, seen) : null });
  const main = await htmlToPdf(html, { virtualTimeMs: 15000 });
  if (!main.ok) return { ok: false, error: main.error };
  const out = await PDFDocument.create();
  const font = await out.embedFont(StandardFonts.Helvetica);
  const grey = rgb(0.45, 0.45, 0.45);
  const add = async (doc) => (await out.copyPages(doc, doc.getPageIndices())).map((p) => out.addPage(p));
  const own = await add(await PDFDocument.load(main.buffer));
  for (const r of sorted) {
    for (const p of r.pdfs) {
      let pages = [];
      try { pages = await add(p.doc); } catch (e) { continue; /* loaded but would not copy: skipped */ }
      const first = pages[0];
      try { first.drawText(ansi(t(lang, "pr_att_label", { name: p.name })), { x: 14, y: first.getHeight() - 11, size: 7, font, color: grey }); } catch (e) { /* label is a nicety */ }
    }
  }
  const total = out.getPageCount();
  own.forEach((pg, i) => {
    const s = ansi(t(lang, "pr_page", { n: i + 1, total }));
    pg.drawText(s, { x: pg.getWidth() - 45 - font.widthOfTextAtSize(s, 8), y: 24, size: 8, font, color: grey });
  });
  return { ok: true, buffer: Buffer.from(await out.save()) };
}

module.exports = { buildPrintPdf, sortAttachments, attachmentsHtml, loadMedia, imageSize };
