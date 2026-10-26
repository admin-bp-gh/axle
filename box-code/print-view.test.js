// print-view.test.js - A4: the print view prints the email with a clean header and no app chrome.
// Run: node print-view.test.js
"use strict";
const assert = require("assert");
const PV = require("./print-view.js");

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };
const w = { id: 7, subject: "Order 232416", sender_name: "Jan", sender_email: "jan@example.nl", email_received: "2026-10-26T09:00:00Z", email_text: "x", latest_message_id: "g2" };
const thread = [
  { graphId: "g1", from: { name: "Jan", address: "jan@example.nl" }, to: [{ name: "", address: "info@budget-parts.nl" }], cc: [], received: "2026-10-25T08:00:00Z", body: "First question" },
  { graphId: "g2", from: { name: "Jan", address: "jan@example.nl" }, to: [{ address: "info@budget-parts.nl" }], cc: [{ name: "Piet", address: "piet@example.nl" }], received: "2026-10-26T09:00:00Z", body: "Second <b>question</b>\n\nOp za 25 okt 2026 schreef Jan <jan@example.nl>:\n> First question\n>\n> Jan" },
];
const refs = { customer: "C10001 Jan BV", docs: ["Order 232416"] };

console.log("print-view");
test("one: only the newest message, with from, to, cc, date, subject and refs", () => {
  const h = PV.render(w, thread, { scope: "one", lang: "en", refs });
  assert.strictEqual((h.match(/<article>/g) || []).length, 1);
  assert.ok(h.includes("Jan &lt;jan@example.nl&gt;") && h.includes("info@budget-parts.nl") && h.includes("Piet &lt;piet@example.nl&gt;"));
  assert.ok(h.includes(">Subject<") && h.includes("Order 232416") && h.includes("C10001 Jan BV"));
  assert.ok(h.includes("Second &lt;b&gt;question&lt;/b&gt;"), "body escaped");
});
test("thread: every message oldest first, quoted copies left out", () => {
  const h = PV.render(w, thread, { scope: "thread", lang: "nl", refs });
  assert.strictEqual((h.match(/<article>/g) || []).length, 2);
  assert.ok(h.indexOf("First question") < h.indexOf("Second"));
  assert.strictEqual((h.match(/First question/g) || []).length, 1);
  assert.ok(h.includes(">Van<") && h.includes(">Onderwerp<"));
});
test("no app chrome and it prints itself", () => {
  const h = PV.render(w, thread, { scope: "one", lang: "en", refs });
  assert.ok(!/wb-shell|ax-app|axle\.css|axle\.js/.test(h));
  assert.ok(/print\(\)/.test(h));
});
test("an email from before the message store prints from the item", () => {
  const h = PV.render(w, [], { scope: "thread", lang: "en", refs: { customer: "", docs: [] } });
  assert.strictEqual((h.match(/<article>/g) || []).length, 1);
  assert.ok(h.includes("jan@example.nl") && !h.includes(">Customer<"));
});
console.log(`${pass} passed`);
