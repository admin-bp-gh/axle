// print-attachments.test.js - A4: print with attachments builds one PDF in the right order.
// Run: node print-attachments.test.js
"use strict";
const assert = require("assert");
const { PDFDocument } = require("pdf-lib");
const PA = require("./print-attachments.js");

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log("  ok  " + name); };
// A fixture PDF of n pages, each page width marking where it came from.
const pdf = async (n, width) => { const d = await PDFDocument.create(); for (let i = 0; i < n; i++) d.addPage([width, 800]); return Buffer.from(await d.save({ useObjectStreams: false })); };
// A 1 px PNG padded past the logo threshold (a picture under 20 KB is a logo and never printed).
const PNG = Buffer.concat([Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"), Buffer.alloc(25000)]);
const LOGO = PNG.subarray(0, 70);

const w = { id: 7, subject: "Claim", sender_name: "Jan", sender_email: "jan@example.nl", email_received: "2026-10-26T09:00:00Z", email_text: "x", latest_message_id: "g2" };
const att = (id, name, contentType) => ({ id, name, contentType });
const thread = [
  { graphId: "g1", from: { address: "jan@example.nl" }, to: [], cc: [], received: "2026-10-25T08:00:00Z", body: "First",
    attachments: [att(1, "invoice.pdf", "application/pdf"), att(2, "photo1.png", "image/png"), att(3, "list.xlsx", "application/vnd.ms-excel")] },
  { graphId: "g2", from: { address: "jan@example.nl" }, to: [], cc: [], received: "2026-10-26T09:00:00Z", body: "Second",
    attachments: [att(4, "label.pdf", "application/pdf"), att(5, "broken.pdf", "application/pdf"), att(6, "photo2.png", "image/png")] },
];
let files;
const readFile = async (a) => files[a.id] || null;
let lastHtml;
const htmlToPdf = async (html) => { lastHtml = html; return { ok: true, buffer: await pdf(2, 100) }; };

(async () => {
  // An encrypted PDF: pdf-lib refuses it, the print lists it.
  const enc = Buffer.from((await pdf(1, 300)).toString("latin1").replace("trailer\n<<", "trailer\n<<\n/Encrypt 3 0 R"), "latin1");
  thread[1].attachments.push(att(8, "locked.pdf", "application/pdf"));
  files = { 8: enc, 1: await pdf(3, 201), 2: PNG, 4: await pdf(1, 202), 5: Buffer.from("%PDF-1.4 not really a pdf"), 6: PNG };
  console.log("print-attachments");
  await test("thread: email pages first, then each PDF attachment in message order", async () => {
    const r = await PA.buildPrintPdf(w, thread, { scope: "thread", lang: "en", refs: {}, readFile, htmlToPdf });
    assert.ok(r.ok);
    const d = await PDFDocument.load(r.buffer);
    assert.deepStrictEqual(d.getPages().map((p) => p.getWidth()), [100, 100, 201, 201, 201, 202]);
  });
  await test("the email is printed with a photo shrink script and a time budget for it", async () => {
    let opts, h;
    await PA.buildPrintPdf(w, thread, { scope: "one", lang: "en", refs: {}, readFile, htmlToPdf: async (x, o) => { opts = o; h = x; return { ok: true, buffer: await pdf(1, 100) }; } });
    assert.ok(opts.virtualTimeMs > 0 && h.includes("toDataURL"));
  });
  await test("images sit under their own message, oldest first", async () => {
    const h = lastHtml;
    const a1 = h.indexOf("photo1.png"), a2 = h.indexOf("photo2.png");
    assert.ok(h.indexOf("First") < a1 && a1 < h.indexOf("Second") && h.indexOf("Second") < a2);
    assert.strictEqual((h.match(/<img src="data:image\/png;base64,/g) || []).length, 2);
    assert.ok(!h.includes("print();"), "the rendered page does not open a print dialog");
  });
  await test("other types listed as not printable; broken PDF listed, not fatal", async () => {
    assert.ok(lastHtml.includes("list.xlsx: cannot be printed here"));
    assert.ok(lastHtml.includes("broken.pdf: damaged or protected PDF, cannot be printed here"));
    assert.ok(lastHtml.includes("locked.pdf: damaged or protected PDF, cannot be printed here"));
    assert.ok(lastHtml.includes("invoice.pdf: added at the end"));
  });
  await test("one: only the newest message and its attachments, NL text", async () => {
    const r = await PA.buildPrintPdf(w, thread, { scope: "one", lang: "nl", refs: {}, readFile, htmlToPdf });
    const d = await PDFDocument.load(r.buffer);
    assert.deepStrictEqual(d.getPages().map((p) => p.getWidth()), [100, 100, 202]);
    assert.ok(!lastHtml.includes("photo1.png") && lastHtml.includes("photo2.png") && lastHtml.includes("Bijlagen"));
    assert.ok(lastHtml.includes("beschadigde of beveiligde PDF"));
  });
  await test("a file that cannot be fetched is listed, the print still succeeds", async () => {
    files[4] = null;
    const r = await PA.buildPrintPdf(w, thread, { scope: "one", lang: "en", refs: {}, readFile, htmlToPdf });
    assert.ok(r.ok && lastHtml.includes("label.pdf: could not be fetched, not printed"));
  });
  await test("without the tick: still one PDF, no attachment pages, no attachments block", async () => {
    const r = await PA.buildPrintPdf(w, thread, { scope: "thread", lang: "en", refs: {}, readFile, htmlToPdf, atts: false });
    const d = await PDFDocument.load(r.buffer);
    assert.deepStrictEqual(d.getPages().map((p) => p.getWidth()), [100, 100]);
    assert.ok(!lastHtml.includes("Attachments") && !lastHtml.includes("photo1.png"));
  });
  await test("inline photo in place, logo never, the same file later in the thread printed once", async () => {
    const big = (id, name) => ({ id, name, contentType: "image/png", size: 25070, inline: true });
    const th = [
      { graphId: "a", from: { address: "c@x.nl" }, to: [], cc: [], received: "2026-10-22T11:00:00Z", body: "Look:\n\n[cid:shot.png@01AB]\n\nBroken weld here", attachments: [big(21, "shot.png"), { id: 22, name: "logo.png", contentType: "image/png", size: 70, inline: true }, { id: 23, name: "inv.pdf", contentType: "application/pdf", size: 5 }] },
      { graphId: "b", from: { address: "c@x.nl" }, to: [], cc: [], received: "2026-10-26T08:00:00Z", body: "Reminder please", attachments: [big(24, "shot.png"), { id: 25, name: "inv.pdf", contentType: "application/pdf", size: 5 }] },
    ];
    files = { ...files, 21: PNG, 22: LOGO, 23: await pdf(1, 301), 24: PNG, 25: await pdf(1, 301) };
    const r = await PA.buildPrintPdf({ ...w, latest_message_id: "b" }, th, { scope: "thread", lang: "en", refs: {}, readFile, htmlToPdf });
    const d = await PDFDocument.load(r.buffer);
    assert.deepStrictEqual(d.getPages().map((p) => p.getWidth()), [100, 100, 301], "the repeated PDF is appended once");
    const h = lastHtml;
    assert.ok(h.indexOf('class="inl"') > h.indexOf("Look:") && h.indexOf('class="inl"') < h.indexOf("Broken weld"), "photo where the marker was");
    assert.strictEqual((h.match(/<img /g) || []).length, 1, "logo and the resent photo not printed");
    assert.ok(h.includes("inv.pdf: already printed above"));
  });
  await test("imageSize reads PNG and JPEG headers", async () => {
    assert.deepStrictEqual(PA.imageSize(PNG), { w: 1, h: 1 });
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 30, 0, 40, 3, 0, 0, 0, 0, 0, 0]);
    assert.deepStrictEqual(PA.imageSize(jpg), { w: 40, h: 30 });
  });
  await test("render failure is reported, not thrown", async () => {
    const r = await PA.buildPrintPdf(w, thread, { scope: "one", lang: "en", refs: {}, readFile, htmlToPdf: async () => ({ ok: false, error: "no Edge" }) });
    assert.deepStrictEqual(r, { ok: false, error: "no Edge" });
  });
  console.log(`${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
