// attachments.test.js - which Graph attachments Axle shows under an inbound email.
// Exists because of #2506 (6 Oct 2026): a customer's phone photo arrived inline (cid:) and never
// appeared, because inline attachments were filtered out wholesale.
const test = require("node:test");
const assert = require("node:assert");
const { pickAttachments } = require("./connectors.js");

const FILE = "#microsoft.graph.fileAttachment";
const att = (o) => ({ "@odata.type": FILE, id: "x", name: "a", contentType: "image/jpeg", size: 200000, isInline: false, ...o });

test("an inline customer photo is shown", () => {
  const r = pickAttachments([att({ isInline: true })]);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].inline, true);
});

test("small inline images (signature logos, pixels) are skipped", () => {
  assert.strictEqual(pickAttachments([att({ isInline: true, size: 4000 })]).length, 0);
});

test("inline non-images are skipped, real file attachments always kept", () => {
  assert.strictEqual(pickAttachments([att({ isInline: true, contentType: "application/pdf" })]).length, 0);
  assert.strictEqual(pickAttachments([att({ contentType: "application/pdf", size: 10 })]).length, 1);
});

test("item and reference attachments are skipped", () => {
  assert.strictEqual(pickAttachments([att({ "@odata.type": "#microsoft.graph.itemAttachment" })]).length, 0);
});
