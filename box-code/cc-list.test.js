// cc-list.test.js - the Cc of a reply (round 2, request 8): the suggestion set, what may be added and
// removed, the cap, our own domains refused except the three internal mailboxes (round 3) minus the
// one the reply is sent from, the customer's SAP card addresses offered on file (round 3), the
// screen again at send time, and that a send with Cc hands Graph exactly those addresses. Pure: no
// database, Graph is a stubbed fetch.
// Run: node cc-list.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const CC = require("./cc-list.js");
const SG = require("./send-guard.js");

const item = (cc, extra) => ({ id: 9, mailbox: "info", sender_email: "anna@klant.test", subject: "Brake discs", email_text: "Hello", injection_flag: 0,
  cc_json: cc ? JSON.stringify(cc) : null, ...extra });
const known = [{ addr: "anna@klant.test", source: "sender" }, { addr: "inkoop@klant.test", source: "onfile" }, { addr: "typed@else.test", source: "typed" }];
const thread = [
  { from: { address: "anna@klant.test" }, to: [{ address: "old@klant.test" }], cc: [] },
  { from: { address: "info@budget-parts.nl" }, to: [{ address: "anna@klant.test" }], cc: [{ address: "ours@klant.test" }] },
  { from: { address: "Anna@Klant.test" }, to: [{ address: "info@budget-parts.nl" }, { address: "Piet@Klant.test" }],
    cc: [{ address: "INKOOP@klant.test" }, { address: "drachten@budget-parts.nl" }, { address: "boss@klant.test" }, { address: "not an address" }] },
];

const INTERNAL = [{ addr: "drachten@budget-parts.nl", source: "internal" }, { addr: "admin@budget-parts.nl", source: "internal" }];
const sugg = (w, to, card) => CC.suggestions(w, { known, card, thread, to });

test("suggestions: on file (the known set, then the SAP card), copied by the customer, internal", () => {
  assert.deepStrictEqual(sugg(item(), "anna@klant.test"), [
    { addr: "inkoop@klant.test", source: "onfile" },
    { addr: "piet@klant.test", source: "copied" },
    { addr: "boss@klant.test", source: "copied" },
    ...INTERNAL,
  ]);
  // Already in Cc and the current To are left out; a redirected To frees the sender as a suggestion.
  assert.deepStrictEqual(sugg(item([{ addr: "piet@klant.test", source: "copied" }]), "inkoop@klant.test").map((e) => e.addr),
    ["anna@klant.test", "boss@klant.test", "drachten@budget-parts.nl", "admin@budget-parts.nl"]);
  assert.strictEqual(CC.newestCustomerMessage(thread), thread[2]);
  assert.deepStrictEqual(CC.suggestions(item(), { known: [], thread: [], to: "anna@klant.test" }), INTERNAL);
});

test("suggestions: the customer's SAP card addresses are on file, whatever resolved the customer", () => {
  // the card's E_Mail and U_E_Mail (customer-summary.js emails): deduplicated against the known set,
  // never the To, never an address already in Cc, never one on our own domains
  const card = ["Inkoop@klant.test", "facturen@klant.test", "anna@klant.test", "boss@klant.test", "x@budget-parts.nl", "cc@klant.test"];
  assert.deepStrictEqual(sugg(item([{ addr: "cc@klant.test", source: "typed" }]), "anna@klant.test", card).filter((e) => e.source === "onfile").map((e) => e.addr),
    ["inkoop@klant.test", "facturen@klant.test", "boss@klant.test"]);
  // a compose, voicemail or contact-form item has no thread sender in the known set: the card alone
  assert.deepStrictEqual(CC.suggestions(item(null, { mailbox: "drachten" }), { known: [], card: ["a@k.test", "b@k.test"], thread: [], to: "a@k.test" }), [
    { addr: "b@k.test", source: "onfile" }, { addr: "info@budget-parts.nl", source: "internal" }, { addr: "admin@budget-parts.nl", source: "internal" }]);
});

test("internal: info@, drachten@ and admin@ may be copied, never the mailbox the reply is sent from", () => {
  for (const [mailbox, from, others] of [["info", "info@budget-parts.nl", ["drachten@budget-parts.nl", "admin@budget-parts.nl"]],
    ["drachten", "drachten@budget-parts.nl", ["info@budget-parts.nl", "admin@budget-parts.nl"]]]) {
    const w = item(null, { mailbox });
    assert.deepStrictEqual(SG.internalCc(mailbox), others);
    assert.strictEqual(SG.sendingAddress(mailbox), from);
    for (const a of others) {
      // offered or typed, in any case: accepted as internal (no amber pill), and it goes out
      assert.deepStrictEqual(CC.add(w, a.toUpperCase(), [], "anna@klant.test").entry, { addr: a, source: "internal" }, a);
      assert.deepStrictEqual(SG.assembleSend(item([{ addr: a, source: "internal" }], { mailbox }), "Hi").cc, [a]);
    }
    assert.ok(!CC.suggestions(w, { known: [], thread: [], to: "anna@klant.test" }).some((e) => e.addr === from), "the sending mailbox is not offered");
    assert.deepStrictEqual(CC.add(w, " " + from.replace("budget", "Budget") + " ", [], "anna@klant.test"), { refuse: "sending_box" });
    assert.throws(() => SG.assembleSend(item([{ addr: from }], { mailbox }), "Hi"), /the mailbox this reply is sent from/);
  }
  // every other address on our own domains stays refused, typed or stored
  for (const a of ["tom@budget-parts.nl", "Info@RoverParts.eu", "x@shop.roverparts.eu", "info@sub.budget-parts.nl"]) {
    assert.deepStrictEqual(CC.add(item(), a, [], "anna@klant.test"), { refuse: "own" }, a);
    assert.throws(() => SG.assembleSend(item([{ addr: a }]), "Hi"), /only info@, drachten@ and admin@ may be copied/, a);
  }
});

test("own-domain look-alikes: trailing dots are refused, the rest is ours or refused", () => {
  // [typed, add() result, send-time result]: a domain ending in a dot is no Cc address at all
  const forms = [
    ["info@budget-parts.nl.", { refuse: "bad_address" }, /not a valid email address/],
    ["x@budget-parts.nl.", { refuse: "bad_address" }, /not a valid email address/],
    ["x@budget-parts.nl...", { refuse: "bad_address" }, /not a valid email address/],
    ["X@BUDGET-PARTS.NL.", { refuse: "bad_address" }, /not a valid email address/],
    ["x@sub.budget-parts.nl.", { refuse: "bad_address" }, /not a valid email address/],
    ["Admin@RoverParts.eu.", { refuse: "bad_address" }, /not a valid email address/],
    ["x@.budget-parts.nl", { refuse: "own" }, /only info@, drachten@ and admin@ may be copied/],
    ["  X@Budget-Parts.NL  ", { refuse: "own" }, /only info@, drachten@ and admin@ may be copied/],
    [" INFO@budget-parts.nl ", { refuse: "sending_box" }, /the mailbox this reply is sent from/],
  ];
  for (const [addr, added, sent] of forms) {
    assert.deepStrictEqual(CC.add(item(), addr, [], "anna@klant.test"), added, addr);
    assert.throws(() => SG.assembleSend(item([{ addr }]), "Hi"), sent, addr);
  }
  // upper case and white space round an internal mailbox: accepted, stored clean
  assert.deepStrictEqual(CC.add(item(), " DRACHTEN@Budget-Parts.NL ", [], "anna@klant.test").entry, { addr: "drachten@budget-parts.nl", source: "internal" });
  // the own-domain test itself ignores trailing dots, so nothing else can slip through that form
  for (const a of ["x@budget-parts.nl.", "x@roverparts.eu..", "x@sub.budget-parts.nl.", "X@BUDGET-PARTS.NL."]) assert.ok(SG.isOwnAddress(a), a);
  assert.ok(!SG.isOwnAddress("x@notbudget-parts.nl.") && !SG.isOwnAddress("x@klant.test."));
  // a customer address with a trailing dot is not offered either
  assert.deepStrictEqual(CC.suggestions(item(), { known: [], card: ["a@klant.test."], thread: [], to: "anna@klant.test" }).filter((e) => e.source === "onfile"), []);
});

test("add: a suggestion keeps its source, anything else is screened and typed", () => {
  const offered = sugg(item(), "anna@klant.test");
  assert.deepStrictEqual(CC.add(item(), " Piet@Klant.test ", offered, "anna@klant.test").entry, { addr: "piet@klant.test", source: "copied" });
  assert.deepStrictEqual(CC.add(item(), "inkoop@klant.test", offered, "anna@klant.test").entry, { addr: "inkoop@klant.test", source: "onfile" });
  const r = CC.add(item([{ addr: "piet@klant.test", source: "copied" }]), "new@else.test", offered, "anna@klant.test");
  assert.deepStrictEqual(r.entry, { addr: "new@else.test", source: "typed" });
  assert.deepStrictEqual(r.cc.map((e) => e.addr), ["piet@klant.test", "new@else.test"]);
});

test("add refuses: bad address, our own domains, the To, a duplicate, a sixth", () => {
  for (const bad of ["", "nope", "a@b.nl, c@d.nl", "Jan <jan@x.nl>", "a@b.nl\nBcc: x@evil.test", "a b@c.nl"]) {
    assert.deepStrictEqual(CC.add(item(), bad, [], "anna@klant.test"), { refuse: "bad_address" }, bad);
  }
  assert.deepStrictEqual(CC.add(item(), "jack@budget-parts.nl", [], "anna@klant.test"), { refuse: "own" });
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
    [[{ addr: "x@budget-parts.nl" }], /our own domain/],
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
