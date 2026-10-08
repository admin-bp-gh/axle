// cc-list.test.js - the Cc of a reply (round 2, request 8): the suggestion set, what may be added and
// removed, the cap, our own mailboxes refused, the screen again at send time, and that a send with
// Cc hands Graph exactly those addresses. Pure: no database, Graph is a stubbed fetch.
// Run: node cc-list.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const CC = require("./cc-list.js");
const SG = require("./send-guard.js");

const item = (cc, extra) => ({ id: 9, sender_email: "anna@klant.test", subject: "Brake discs", email_text: "Hello", injection_flag: 0,
  cc_json: cc ? JSON.stringify(cc) : null, ...extra });
const known = [{ addr: "anna@klant.test", source: "sender" }, { addr: "inkoop@klant.test", source: "onfile" }, { addr: "typed@else.test", source: "typed" }];
const thread = [
  { from: { address: "anna@klant.test" }, to: [{ address: "old@klant.test" }], cc: [] },
  { from: { address: "info@budget-parts.nl" }, to: [{ address: "anna@klant.test" }], cc: [{ address: "ours@klant.test" }] },
  { from: { address: "Anna@Klant.test" }, to: [{ address: "info@budget-parts.nl" }, { address: "Piet@Klant.test" }],
    cc: [{ address: "INKOOP@klant.test" }, { address: "drachten@budget-parts.nl" }, { address: "boss@klant.test" }, { address: "not an address" }] },
];

test("suggestions: the known set as on file, then what the customer copied on their newest email", () => {
  assert.deepStrictEqual(CC.suggestions(item(), known, thread, "anna@klant.test"), [
    { addr: "inkoop@klant.test", source: "onfile" },
    { addr: "piet@klant.test", source: "copied" },
    { addr: "boss@klant.test", source: "copied" },
  ]);
  // Already in Cc and the current To are left out; a redirected To frees the sender as a suggestion.
  assert.deepStrictEqual(CC.suggestions(item([{ addr: "piet@klant.test", source: "copied" }]), known, thread, "inkoop@klant.test").map((e) => e.addr),
    ["anna@klant.test", "boss@klant.test"]);
  assert.strictEqual(CC.newestCustomerMessage(thread), thread[2]);
  assert.deepStrictEqual(CC.suggestions(item(), [], [], "anna@klant.test"), []);
});

test("add: a suggestion keeps its source, anything else is screened and typed", () => {
  const offered = CC.suggestions(item(), known, thread, "anna@klant.test");
  assert.deepStrictEqual(CC.add(item(), " Piet@Klant.test ", offered, "anna@klant.test").entry, { addr: "piet@klant.test", source: "copied" });
  assert.deepStrictEqual(CC.add(item(), "inkoop@klant.test", offered, "anna@klant.test").entry, { addr: "inkoop@klant.test", source: "onfile" });
  const r = CC.add(item([{ addr: "piet@klant.test", source: "copied" }]), "new@else.test", offered, "anna@klant.test");
  assert.deepStrictEqual(r.entry, { addr: "new@else.test", source: "typed" });
  assert.deepStrictEqual(r.cc.map((e) => e.addr), ["piet@klant.test", "new@else.test"]);
});

test("add refuses: bad address, our own mailboxes, the To, a duplicate, a sixth", () => {
  for (const bad of ["", "nope", "a@b.nl, c@d.nl", "Jan <jan@x.nl>", "a@b.nl\nBcc: x@evil.test", "a b@c.nl"]) {
    assert.deepStrictEqual(CC.add(item(), bad, [], "anna@klant.test"), { refuse: "bad_address" }, bad);
  }
  assert.deepStrictEqual(CC.add(item(), "drachten@budget-parts.nl", [], "anna@klant.test"), { refuse: "own" });
  assert.deepStrictEqual(CC.add(item(), "x@shop.roverparts.eu", [], "anna@klant.test"), { refuse: "own" });
  assert.deepStrictEqual(CC.add(item(), "ANNA@klant.test", [], "anna@klant.test"), { refuse: "same_as_to" });
  assert.deepStrictEqual(CC.add(item([{ addr: "piet@klant.test", source: "copied" }]), "piet@klant.test", [], "anna@klant.test"), { refuse: "duplicate" });
  const five = ["a", "b", "c", "d", "e"].map((x) => ({ addr: `${x}@klant.test`, source: "typed" }));
  assert.strictEqual(CC.MAX_CC, 5);
  assert.deepStrictEqual(CC.add(item(five), "f@klant.test", [], "anna@klant.test"), { refuse: "too_many" });
  assert.ok(CC.add(item(five.slice(0, 4)), "f@klant.test", [], "anna@klant.test").entry);
});

test("remove: one address, case-insensitive; the column is NULL when empty", () => {
  const w = item([{ addr: "piet@klant.test", source: "copied" }, { addr: "boss@klant.test", source: "copied" }]);
  assert.deepStrictEqual(CC.remove(w, "PIET@klant.test"), { cc: [{ addr: "boss@klant.test", source: "copied" }], removed: true });
  assert.strictEqual(CC.remove(w, "nobody@klant.test").removed, false);
  assert.strictEqual(CC.column([]), null);
  assert.deepStrictEqual(CC.list(item(null, { cc_json: "not json" })), []);
});

test("send: the Cc goes out as stored, screened again; empty unless set", () => {
  const w = item([{ addr: "piet@klant.test", source: "copied" }, { addr: "Boss@Klant.test", source: "typed" }]);
  assert.deepStrictEqual(SG.assembleSend(w, "Hi").cc, ["piet@klant.test", "boss@klant.test"]);
  assert.deepStrictEqual(SG.assembleSend(item(), "Hi").cc, []);
  assert.deepStrictEqual(SG.assembleNewOutboundSend({ ...w, recipient: "jan@klant.test" }, "Hi", "Subject").cc, ["piet@klant.test", "boss@klant.test"]);
  assert.deepStrictEqual(SG.assembleSend(w, "Hi").bcc, []);
  assert.strictEqual(SG.assembleSend(w, "Hi").sha256, SG.sha256("Hi"), "the Cc does not touch the body hash");
});

test("send refuses a Cc that went stale, never dropping it silently", () => {
  const refusals = [
    [[{ addr: "anna@klant.test" }], /same as the To/],
    [[{ addr: "x@budget-parts.nl" }], /our own mailboxes/],
    [[{ addr: "a@b.nl,c@d.nl" }], /not a valid email address/],
    [[{ addr: "p@klant.test" }, { addr: "P@klant.test" }], /listed twice/],
    [["a", "b", "c", "d", "e", "f"].map((x) => ({ addr: `${x}@klant.test` })), /more than 5/],
  ];
  for (const [cc, re] of refusals) assert.throws(() => SG.assembleSend(item(cc), "Hi"), re, JSON.stringify(cc));
  assert.throws(() => SG.assembleSend(item(null, { cc_json: "{bad" }), "Hi"), /could not be read/);
  assert.throws(() => SG.assembleSend(item(null, { cc_json: "{}" }), "Hi"), /could not be read/);
  for (const none of [null, "", "[]", "null"]) assert.deepStrictEqual(SG.assembleSend(item(null, { cc_json: none }), "Hi").cc, [], `cc_json ${JSON.stringify(none)} is no Cc`);
  // The To changed onto an address in the Cc: the send refuses rather than mail it twice.
  assert.throws(() => SG.assembleSend(item([{ addr: "piet@klant.test" }], { recipient: "piet@klant.test" }), "Hi"), /same as the To/);
  // The older refusals still come first.
  assert.throws(() => SG.assembleSend(item([{ addr: "x@budget-parts.nl" }], { injection_flag: 1 }), "Hi"), /flagged/);
});

test("send.js hands Graph the Cc as ccRecipients, and none when there is none", async () => {
  const sent = [];
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("/oauth2/")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
    if (u.endsWith("/sendMail")) { sent.push(JSON.parse(init.body).message); return new Response(null, { status: 202 }); }
    return new Response(JSON.stringify({ value: [] }), { status: 200 });
  };
  const SEND = require("./send.js");
  await SEND.sendReply({ mailbox: "info@budget-parts.nl", to: "anna@klant.test", cc: ["piet@klant.test", "boss@klant.test"], subject: "Re: x", html: "<div>x</div>" });
  await SEND.sendReply({ mailbox: "info@budget-parts.nl", to: "anna@klant.test", subject: "Re: x", html: "<div>x</div>" });
  assert.deepStrictEqual(sent[0].ccRecipients, [{ emailAddress: { address: "piet@klant.test" } }, { emailAddress: { address: "boss@klant.test" } }]);
  assert.deepStrictEqual(sent[0].toRecipients, [{ emailAddress: { address: "anna@klant.test" } }]);
  assert.deepStrictEqual(sent[0].bccRecipients, []);
  assert.deepStrictEqual(sent[1].ccRecipients, []);
});
