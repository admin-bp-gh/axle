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
test("cleaning: link targets, mailto, alt text and Outlook separator go, visible text stays", () => {
  const c = PV.cleanText("Kampenringweg 13<https://maps.app.goo.gl/x>\ninfo@budget-parts.nl<mailto:info@budget-parts.nl>\nSee <https://a.nl/b>\nmail <mailto:jan@x.nl>\n[A green and black sign Description automatically generated]<https://budget-parts.nl/pages/contact>\n________________________________\nEnd");
  assert.strictEqual(c, "Kampenringweg 13\ninfo@budget-parts.nl\nSee https://a.nl/b\nmail jan@x.nl\n\nEnd");
});
test("signature: our address block and a disclaimer fold to one line, the name stays", () => {
  const s = PV.stripSignature("Hello JP\n\nKind regards,\n\nBradley Sharnock\n\nGouda\n\nKampenringweg 13\n\n2803 PE Gouda\n\ninfo@budget-parts.nl\n\nKvK: 28064788\n\nBTW: NL817343118B01\n\nDisclaimer: Deze e-mail is vertrouwelijk.");
  assert.deepStrictEqual(s, { text: "Hello JP\n\nKind regards,\n\nBradley Sharnock", folded: true });
  const h = PV.render({ ...w, mailbox: "info" }, [{ ...thread[0], body: "Hi\n\nKvK: 28064788" }], { scope: "one", lang: "nl", refs });
  assert.ok(h.includes("Handtekening en voettekst weggelaten") && !h.includes("28064788"));
});
test("quoted rule: a forward whose original is not in the thread is printed, with its header", () => {
  const fw = [{ graphId: "f", from: { address: "admin@budget-parts.nl" }, to: [], cc: [], received: "2026-10-23T05:46:26Z",
    body: "Morning JP\n\nSee below.\n\nFrom: Marcel Fassl <marcel@x.at>\nSent: Thursday, October 22, 2026 1:11 PM\nTo: Budget Parts <info@budget-parts.nl>\nSubject: Quality issue\n\nThe welds are broken." }];
  for (const scope of ["thread", "one"]) {
    const h = PV.render({ ...w, latest_message_id: "f" }, fw, { scope, lang: "en", refs });
    assert.ok(h.includes("The welds are broken.") && h.includes("<blockquote>") && h.includes("Marcel Fassl &lt;marcel@x.at&gt;"), scope);
  }
});
test("quoted rule: a quoted copy of a message printed in the thread is dropped, scope one keeps it", () => {
  const th = [
    { graphId: "a", from: { address: "c@x.nl" }, to: [], cc: [], received: "2026-10-22T11:00:00Z", body: "[cid:abc@outlook]\nDear Team,\n\nthe side steps arrived damaged, please advise." },
    { graphId: "b", from: { address: "c@x.nl" }, to: [], cc: [], received: "2026-10-26T08:00:00Z", body: "Kind reminder.\n\nOn 22.10.2026, at 13:11, C <c@x.nl> wrote:\n\n<IMG_1.jpeg>\nDear Team,\n\nthe side steps arrived damaged, please advise." },
  ];
  const t2 = PV.render({ ...w, latest_message_id: "b" }, th, { scope: "thread", lang: "en", refs });
  assert.strictEqual((t2.match(/arrived damaged/g) || []).length, 1);
  assert.ok(!t2.includes("<blockquote>"));
  const t1 = PV.render({ ...w, latest_message_id: "b" }, th, { scope: "one", lang: "en", refs });
  assert.ok(t1.includes("Kind reminder.") && t1.includes("arrived damaged") && t1.includes("<blockquote>"));
});
test("full date and the branded header with the mailbox", () => {
  assert.ok(/^Friday,? 23 October 2026 at 07:46$/.test(PV.fullDate("2026-10-23T05:46:26Z", "en")));
  assert.ok(/^vrijdag 23 oktober 2026/.test(PV.fullDate("2026-10-23T05:46:26Z", "nl")));
  const h = PV.render({ ...w, mailbox: "drachten" }, thread, { scope: "one", lang: "en", refs });
  assert.ok(h.includes("Budget Parts B.V.") && h.includes("drachten@budget-parts.nl") && /@page \{ size: A4/.test(h));
});
// The print menu tick (assets/axle.js): the href rule run as written, and the wiring around it.
test("tick wiring: the change of the tick rewrites every print row; the tick's click is its own", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "assets", "axle.js"), "utf8");
  const fn = /function printHref\(href, on\) \{[\s\S]*?\n  \}/.exec(src)[0];
  const printHref = new Function("location", `${fn}; return printHref;`)({ href: "http://box/axle/item/2919" });
  assert.strictEqual(printHref("/axle/item/2919/print?scope=thread", true), "http://box/axle/item/2919/print?scope=thread&atts=1");
  assert.strictEqual(printHref("/axle/item/2919/print?scope=thread&atts=1", false), "http://box/axle/item/2919/print?scope=thread");
  assert.strictEqual(printHref(printHref("/axle/item/1/print?scope=one", true), true), "http://box/axle/item/1/print?scope=one&atts=1");
  assert.ok(/addEventListener\("change"[\s\S]{0,120}\[data-print-atts\][\s\S]{0,200}a\[data-print-row\][\s\S]{0,120}printHref/.test(src), "change listener updates the rows");
  assert.ok(/const tg = e\.target;\n    if \(tg\.closest\?\.\("\.ax-print-atts"\)\) return;/.test(src), "tick click returns before anything can close the menu");
  assert.notStrictEqual(require("./views/ui.js").ASSET_V, "ax23", "asset version bumped so browsers fetch the new axle.js");
});
console.log(`${pass} passed`);
