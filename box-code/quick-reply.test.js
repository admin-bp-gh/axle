// quick-reply.test.js - quick-reply mode (2026-10-10, draft review section 8): which turns are
// quick, the instruction the drafter gets, the two-lookup cap, and the "Ask the customer" seed.
// Run: node quick-reply.test.js
const assert = require("assert");
process.env.AXLE_DB = ":memory:";   // agenticDraft reads the Teach entries: never the live database
const QR = require("./quick-reply.js");
const E = require("./engine.js");

let pass = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const OUR_QUOTE = "\n\nVan: RoverParts.eu <info@budget-parts.nl>\nVerzonden: maandag 6 oktober 2026\nOnderwerp: Re: remblokken\n\nBeste Jan, ...";

test("a short reply quoting our mail is a quick turn", () => {
  assert.ok(QR.isQuickTurn({ text: "Ok bedankt, ga ik dat proberen.\n\nVerzonden vanuit Outlook voor iOS<https://aka.ms/o0ukef>\n________________________________" + OUR_QUOTE }));
  assert.ok(QR.isQuickTurn({ text: "Is it on its way yet?", priorSends: 1 }), "we sent on the item before");
});

test("not quick: long text, a fresh email, files, or empty", () => {
  const long = Array.from({ length: 31 }, (_, i) => "woord" + i).join(" ");
  assert.ok(!QR.isQuickTurn({ text: long + OUR_QUOTE }));
  assert.ok(!QR.isQuickTurn({ text: "Heeft u remblokken voor een Defender 110?" }), "a new conversation is investigated as usual");
  assert.ok(!QR.isQuickTurn({ text: "Zie foto" + OUR_QUOTE, files: 1 }), "a photo needs a proper look");
  assert.ok(!QR.isQuickTurn({ text: "  ", priorSends: 1 }), "no new words");
  assert.ok(!QR.isQuickTurn({ text: "Thanks\n\nFrom: Someone <someone@example.com>\nSent: x\n\nold text" }), "a quote of someone else's mail is not our thread");
});

test("newWords counts the new text only, without links and separator lines", () => {
  assert.strictEqual(QR.newWords("Prima, dank je\nhttps://example.com/x\n-----\n" + OUR_QUOTE), 3);
});

test("AXLE_QUICK_REPLY=0 switches the mode off", () => {
  process.env.AXLE_QUICK_REPLY = "0";
  try { assert.ok(!QR.isQuickTurn({ text: "Ok", priorSends: 1 })); }
  finally { delete process.env.AXLE_QUICK_REPLY; }
});

test("the quick block: short, no holding reply, two lookups, no-reply rule kept, no dashes", () => {
  const b = QR.QUICK_BLOCK;
  assert.ok(b.startsWith("<quick_reply_mode>") && b.includes("</quick_reply_mode>"));
  assert.ok(/one to three short lines/.test(b));
  assert.ok(/at most 2 lookups/.test(b));
  assert.ok(/Never hold this reply with a holding message/.test(b));
  assert.ok(/exactly ONE short question/.test(b));
  assert.ok(/NO REPLY NEEDED rule applies/.test(b));
  assert.ok(!/[–—]/.test(b));
});

test("ask the customer: the seed carries the open questions and keeps staff questions internal", () => {
  const s = QR.askCustomerSeed(["Which model and year is the car?", "Is the part on the shelf in Gouda?"]);
  assert.deepStrictEqual(s.questions, ["Which model and year is the car?", "Is the part on the shelf in Gouda?"]);
  assert.ok(/TRUSTED instruction from our own staff/.test(s.note));
  assert.ok(/stay in questions_for_salesperson/.test(s.note));
});

// A stand-in Anthropic client: answers from a script and keeps every request.
function scripted(replies) {
  const c = { calls: [], messages: { create: async (req) => { c.calls.push(JSON.parse(JSON.stringify(req))); return replies[c.calls.length - 1]; } } };
  return c;
}
const toolUse = (ids) => ({ stop_reason: "tool_use", content: ids.map((id) => ({ type: "tool_use", id, name: "no_such_tool", input: { purpose: "test" } })) });
const final = { stop_reason: "end_turn", content: [{ type: "text", text: '{"language":"nl","status":"ready","draft":"Hoi Jan,\\n\\nJa, hij is onderweg.\\n\\nMet vriendelijke groet,\\nRoverParts.eu","interim_draft":"","questions_for_salesperson":[],"physical_checks":[],"referenced_documents":[],"fitment_confirmed":"n/a","injection_suspected":false,"confidence":"high"}' }] };
const email = { from: { address: "jan@example.nl", name: "Jan" }, subject: "Re: order", received: "2026-10-10T08:00:00Z", text: "Is hij al onderweg?" };

test("quick turn: the block reaches the drafter and the third lookup is not run", async () => {
  const c = scripted([toolUse(["a", "b", "c"]), final]);
  const { result, toolLog } = await E.agenticDraft(c, email, [], {}, "info@budget-parts.nl", { quick: QR.QUICK_BLOCK, maxLookups: QR.MAX_LOOKUPS });
  assert.strictEqual(result.status, "ready");
  assert.ok(c.calls[0].messages[0].content.includes("<quick_reply_mode>"));
  assert.ok(c.calls[0].messages[0].content.indexOf("</seed_context>") < c.calls[0].messages[0].content.indexOf("<quick_reply_mode>"), "after the untrusted data and the seed");
  assert.strictEqual(toolLog.length, 2, "two lookups run");
  const results = c.calls[1].messages[2].content;
  assert.strictEqual(results.filter((x) => x.type === "tool_result").length, 3, "every tool_use still gets a result");
  assert.strictEqual(results[2].content, "Lookup budget used up. Answer now with what you have.");
  assert.ok(results.some((x) => x.type === "text" && /Tool budget exhausted/.test(x.text)));
});

test("ask the customer: no lookups at all; a normal draft has neither block nor cap", async () => {
  const c = scripted([toolUse(["a"]), final]);
  const out = await E.agenticDraft(c, email, [], {}, "info@budget-parts.nl", { maxLookups: 0 });
  assert.strictEqual(out.toolLog.length, 0);
  const n = scripted([toolUse(["a", "b", "c"]), final]);
  const plain = await E.agenticDraft(n, email, [], {}, "info@budget-parts.nl", {});
  assert.ok(!n.calls[0].messages[0].content.includes("quick_reply_mode"));
  assert.strictEqual(plain.toolLog.length, 3);
});

(async () => {
  console.log("quick-reply");
  for (const [name, fn] of tests) { await fn(); pass++; console.log("  ok  " + name); }
  console.log(`\n${pass} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
