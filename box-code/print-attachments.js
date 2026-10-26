// print-attachments.js - print with attachments (A4, 26 Oct 2026). GET /item/:id/print?atts=1 builds
// one PDF: the email or thread (print-view.js) rendered by the headless Edge in claim-statement.js,
// each message's images placed under that message, then every PDF attachment appended in message
// order with pdf-lib. Anything else (Word, Excel, zip...) is listed by name as not printable here,
// and so is a PDF that is damaged or encrypted: one bad file never fails the whole print.
"use strict";
const { PDFDocument } = require("pdf-lib");
const PV = require("./print-view.js");
const { esc, t } = require("./views/ui.js");

const IMG = /^image\/(png|jpeg|gif|webp)$/;

// Per message: { images: [{name, dataUri}], pdfs: [{name, doc}], notPrintable: [{name, why}] }.
// readFile(att) resolves to the file's bytes, or null when it cannot be had.
async function sortAttachments(msgs, readFile) {
  const out = [];
  for (const m of msgs) {
    const r = { images: [], pdfs: [], notPrintable: [] };
    for (const a of m.attachments || []) {
      const isImg = IMG.test(a.contentType || ""), isPdf = a.contentType === "application/pdf";
      if (!isImg && !isPdf) { r.notPrintable.push({ name: a.name, why: "pr_att_noprint" }); continue; }
      let buf = null;
      try { buf = await readFile(a); } catch (e) { buf = null; }
      if (!buf || !buf.length) { r.notPrintable.push({ name: a.name, why: "pr_att_unreadable" }); continue; }
      if (isImg) { r.images.push({ name: a.name, dataUri: `data:${a.contentType};base64,${Buffer.from(buf).toString("base64")}` }); continue; }
      // load throws on an encrypted file; a damaged one can load with no pages at all.
      let doc = null;
      try { doc = await PDFDocument.load(buf); if (!(doc.getPageCount() > 0)) doc = null; } catch (e) { doc = null; }
      if (doc) r.pdfs.push({ name: a.name, doc });
      else r.notPrintable.push({ name: a.name, why: "pr_att_broken" });
    }
    out.push(r);
  }
  return out;
}

// The block printed under one message.
function attachmentsHtml(r, lang) {
  const L = (k) => esc(t(lang, k));
  const imgs = r.images.map((i) => `<figure><img src="${i.dataUri}" alt="${esc(i.name)}"><figcaption>${esc(i.name)}</figcaption></figure>`).join("");
  const rows = r.pdfs.map((p) => `<li>${esc(p.name)}: ${L("pr_att_pdf")}</li>`)
    .concat(r.notPrintable.map((n) => `<li>${esc(n.name)}: ${L(n.why)}</li>`)).join("");
  return imgs || rows ? `<div class="atts"><h4>${L("pr_atts")}</h4>${imgs}${rows ? `<ul>${rows}</ul>` : ""}</div>` : "";
}

// htmlToPdf: claim-statement.js's helper (or a stub in tests) -> { ok, buffer, error }.
async function buildPrintPdf(w, thread, { scope, lang, refs, readFile, htmlToPdf }) {
  const msgs = PV.messagesFor(w, thread, scope === "thread" ? "thread" : "one");
  const sorted = await sortAttachments(msgs, readFile);
  const html = PV.render(w, thread, { scope, lang, refs, autoPrint: false, extra: (m, i) => attachmentsHtml(sorted[i], lang) });
  const main = await htmlToPdf(html);
  if (!main.ok) return { ok: false, error: main.error };
  const out = await PDFDocument.create();
  const add = async (doc) => (await out.copyPages(doc, doc.getPageIndices())).forEach((p) => out.addPage(p));
  await add(await PDFDocument.load(main.buffer));
  for (const r of sorted) {
    for (const p of r.pdfs) {
      try { await add(p.doc); } catch (e) { /* loaded but would not copy: already listed as appended, skipped */ }
    }
  }
  return { ok: true, buffer: Buffer.from(await out.save()) };
}

module.exports = { buildPrintPdf, sortAttachments, attachmentsHtml };
