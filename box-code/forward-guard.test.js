"use strict";
// forward-guard.test.js — the deterministic guardrails behind the reassign-and-forward handover
// (allow-list action #6, 2026-08-08).
//
// The one thing these tests exist to pin: THE DESTINATION CAN ONLY EVER BE ONE OF OUR OWN THREE
// MAILBOXES, resolved in code from the fixed owner table. Everything else here (flagged items,
// compose items, closed items, missing message ids) is the ordinary "a send must refuse rather
// than guess" discipline the send path already follows.
const test = require("node:test");
const assert = require("node:assert");
const FG = require("./forward-guard.js");
const rulesets = require("./rules.js");

const INFO = "info@budget-parts.nl";
const DRACHTEN = "drachten@budget-parts.nl";
const ADMIN = "admin@budget-parts.nl";

// A live inbound item in info@, owned by Gouda sales — the shape everything below varies from.
const item = (over = {}) => Object.assign({
  id: 1171,
  mailbox: "info",
  owner: "Sales(Gouda)",
  status: "new",
  origin: "inbound",
  injection_flag: 0,
  latest_message_id: "AAMkADRlZTk2LWZmZmYtNDQ0NC1hYWFhLTAwMDAwMDAwMDAwMAB=",
  sender_email: "invoices@dhl.com",
  sender_name: "DHL Express",
}, over);

const by = { toOwner: "Brad", byName: "Brad", byLogin: "admin@budget-parts.nl" };

// --- who is a forward target, and who is not --------------------------------------------
test("a cross-mailbox owner is a handover target", () => {
  assert.deepStrictEqual(FG.forwardTargetFor("info", "Brad"), { box: "admin", address: ADMIN });
  assert.deepStrictEqual(FG.forwardTargetFor("drachten", "Sales(Gouda)"), { box: "info", address: INFO });
  assert.deepStrictEqual(FG.forwardTargetFor("info", "Drachten"), { box: "drachten", address: DRACHTEN });
  assert.deepStrictEqual(FG.forwardTargetFor("drachten", "Brad"), { box: "admin", address: ADMIN });
});

test("an owner who already works this mailbox is a relabel, not a handover", () => {
  assert.strictEqual(FG.forwardTargetFor("info", "Sales(Gouda)"), null);
  assert.strictEqual(FG.forwardTargetFor("drachten", "Drachten"), null);
  assert.strictEqual(FG.forwardTargetFor("info", "Tom"), null, "Tom works info@ in Outlook");
});

test("an unknown label is never a target", () => {
  for (const label of ["Jack", "", null, undefined, "attacker@evil.com", "Brad ", "brad"]) {
    assert.strictEqual(FG.forwardTargetFor("info", label), null, String(label));
  }
});

test("every target the guard will ever produce is one of our own mailboxes", () => {
  const ours = rulesets.ourMailboxAddresses();
  for (const box of ["info", "drachten"]) {
    for (const label of ["Brad", "Drachten", "Sales(Gouda)", "Tom", "Jack", "nonsense"]) {
      const t = FG.forwardTargetFor(box, label);
      if (t) assert.ok(ours.includes(t.address), `${box} -> ${label} produced ${t.address}`);
    }
  }
});

// --- assembleForward: the refusals ------------------------------------------------------
const refuses = (w, opts, re) => assert.throws(() => FG.assembleForward(w, opts), re);

test("a flagged item is never handed over", () => {
  refuses(item({ injection_flag: 1 }), by, /flagged as possible injection/);
});

test("a composed email has nothing to forward", () => {
  refuses(item({ origin: "compose" }), by, /no inbound message/);
});

test("a closed item refuses — reopen first", () => {
  refuses(item({ status: "done" }), by, /closed/);
  refuses(item({ status: "archived" }), by, /closed/);
});

test("an item with no source message refuses", () => {
  refuses(item({ latest_message_id: null }), by, /no source message/);
  refuses(item({ latest_message_id: "" }), by, /no source message/);
});

test("no work item at all refuses", () => {
  refuses(null, by, /no work item/);
});

test("an owner with no mailbox of their own refuses", () => {
  refuses(item(), { toOwner: "Tom" }, /no mailbox of their own/);
  refuses(item(), { toOwner: "Sales(Gouda)" }, /no mailbox of their own/);
  refuses(item(), { toOwner: "Jack" }, /no mailbox of their own/);
  refuses(item(), {}, /no mailbox of their own/);
});

// --- assembleForward: the happy path ----------------------------------------------------
test("a Gouda item handed to Brad forwards to admin@, out of info@", () => {
  const f = FG.assembleForward(item(), by);
  assert.strictEqual(f.to, ADMIN);
  assert.strictEqual(f.box, "admin");
  assert.strictEqual(f.mailboxKey, "info", "Graph acts as the mailbox we forward FROM");
  assert.strictEqual(f.messageId, item().latest_message_id);
  assert.strictEqual(f.toOwner, "Brad");
  assert.strictEqual(f.fromOwner, "Sales(Gouda)");
});

test("a Drachten item handed to Gouda forwards to info@, out of drachten@", () => {
  const f = FG.assembleForward(item({ mailbox: "drachten", owner: "Drachten" }), { toOwner: "Sales(Gouda)", byName: "Rob" });
  assert.strictEqual(f.to, INFO);
  assert.strictEqual(f.mailboxKey, "drachten");
});

test("the handover note says who, from where, and where the mail came from", () => {
  const f = FG.assembleForward(item(), by);
  assert.match(f.comment, /Handed over in Axle by Brad\./);
  assert.match(f.comment, /From: Sales\(Gouda\) {2}-> {2}To: Brad/);
  assert.match(f.comment, /Original sender: DHL Express <invoices@dhl\.com>/);
  assert.match(f.comment, /Axle item #1171/);
});

test("AXLE_BASE_URL turns the item reference into a deep link", () => {
  const prev = process.env.AXLE_BASE_URL;
  process.env.AXLE_BASE_URL = "https://axle-box.example.ts.net/";
  try {
    assert.match(FG.assembleForward(item(), by).comment, /https:\/\/axle-box\.example\.ts\.net\/item\/1171/);
  } finally {
    if (prev === undefined) delete process.env.AXLE_BASE_URL; else process.env.AXLE_BASE_URL = prev;
  }
});

// --- the note is ours, not the customer's -----------------------------------------------
// The forwarded BODY is the customer's and travels untouched (that is the point of a forward).
// The note above it is built from our strings plus a scrubbed sender name/address, so a display
// name cannot inject markup or extra header-looking lines into it.
test("a hostile display name cannot break out of the handover note", () => {
  const hostile = "Jan <attacker@evil.com>\nTo: victim@evil.com\r\n<b>x</b>&";
  // The tags lose their brackets and the address-looking tokens are dropped entirely; what is
  // left is inert words. (The forwarded BODY still carries the customer's own text untouched —
  // that is the point of a forward. Only OUR note is scrubbed.)
  const name = FG.plainName(hostile);
  assert.strictEqual(name, "Jan b x /b", "name not scrubbed to plain words");
  assert.ok(!/[<>&"'@:\r\n\t]/.test(name), "an unsafe character survived the scrub");

  const f = FG.assembleForward(item({ sender_name: hostile, sender_email: "jan@dekker4x4.nl" }), by);
  assert.ok(!/attacker@evil\.com/.test(f.comment), "the fake address inside the NAME survived");
  assert.ok(!/victim@evil\.com/.test(f.comment), "the fake header inside the NAME survived");
  assert.ok(!/\r/.test(f.comment), "a CR could split the note into extra lines");
  assert.strictEqual(f.comment.split("\n").length, 5, "the note is exactly the lines we wrote");
  assert.ok(f.comment.includes(`Original sender: ${name} <jan@dekker4x4.nl>`), "the real address is still shown");
});

test("plainName keeps ordinary names intact, including punctuation and accents", () => {
  assert.strictEqual(FG.plainName("Jan's Garage & Zn."), "Jan s Garage Zn.");
  assert.strictEqual(FG.plainName("  Björn   Müller  "), "Björn Müller");
  assert.strictEqual(FG.plainName("x".repeat(200)).length, 80, "capped");
  assert.strictEqual(FG.plainName(null), "");
});

test("an unusable sender address is dropped rather than passed through", () => {
  for (const bad of ["a@b.nl, evil@x.com", "not-an-address", "", null, "a@b.nl>x", "a b@c.nl"]) {
    const f = FG.assembleForward(item({ sender_email: bad, sender_name: "" }), by);
    assert.match(f.comment, /Original sender: unknown/, String(bad));
  }
});

test("plainAddress accepts exactly one clean address", () => {
  assert.strictEqual(FG.plainAddress("  Jan@Dekker4x4.NL "), "jan@dekker4x4.nl");
  assert.strictEqual(FG.plainAddress("a@b.nl,c@d.nl"), "");
  assert.strictEqual(FG.plainAddress("a@b.nl;c@d.nl"), "");
  assert.strictEqual(FG.plainAddress("Jan <a@b.nl>"), "");
  assert.strictEqual(FG.plainAddress("a".repeat(250) + "@b.nl"), "");
});
