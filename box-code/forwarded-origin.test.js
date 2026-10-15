"use strict";
// forwarded-origin.test.js - reading who wrote the email a colleague forwarded (15 Oct 2026).
// Run: node --test forwarded-origin.test.js
const test = require("node:test");
const assert = require("node:assert");
const FO = require("./forwarded-origin.js");

// The first block without its line number (tested on its own below).
const first = (text) => { const b = FO.headerBlocks(text)[0]; if (!b) return null; const { line, ...rest } = b; return rest; };

test("Outlook NL forward header", () => {
  const t = "Kun jij deze klant helpen?\n\n________________________________\nVan: Sander Verbeek <Sander@asvhengelo.nl>\nVerzonden: donderdag 15 oktober 2026 12:34\nAan: Budget Parts | Drachten <drachten@budget-parts.nl>\nOnderwerp: Afdichting stuurhuis\n\nGoedemiddag";
  assert.deepStrictEqual(first(t), { addr: "sander@asvhengelo.nl", name: "Sander Verbeek", kind: "from" });
});

test("Outlook EN forward header, with the bold marks and mailto form some clients write", () => {
  assert.deepStrictEqual(first("note\n\n*From:* Jan Dekker [mailto:jan@dekker4x4.nl]\n*Sent:* Thursday\n*To:* info@budget-parts.nl\n\nhi"),
    { addr: "jan@dekker4x4.nl", name: "Jan Dekker", kind: "from" });
  assert.deepStrictEqual(first("From: Jan Dekker <jan@dekker4x4.nl<mailto:jan@dekker4x4.nl>>\nSent: Thursday\n\nhi"),
    { addr: "jan@dekker4x4.nl", name: "Jan Dekker", kind: "from" });
  assert.deepStrictEqual(first("From: jan@dekker4x4.nl\nDate: Thu\n\nhi"), { addr: "jan@dekker4x4.nl", name: "", kind: "from" });
});

test("Gmail forward, EN and NL markers", () => {
  const en = "Can someone mail him?\n\n---------- Forwarded message ---------\nFrom: Nieuwe Klant <nieuw@klant.nl>\nDate: Thu, 15 Oct 2026 at 09:12\nSubject: Remschijven\nTo: <drachten@budget-parts.nl>\n\nHebben jullie remschijven?";
  assert.deepStrictEqual(first(en), { addr: "nieuw@klant.nl", name: "Nieuwe Klant", kind: "from" });
  assert.ok(FO.hasForwardMarker(en));
  const nl = "---------- Doorgestuurd bericht ---------\nVan: Klant <k@x.nl>\nDate: do 15 okt 2026\nSubject: x\n\nhoi";
  assert.ok(FO.hasForwardMarker(nl));
  assert.strictEqual(first(nl).addr, "k@x.nl");
  assert.ok(FO.hasForwardMarker("Begin forwarded message:\n\nFrom: A <a@b.nl>\nDate: x"));
});

test("reply attributions: NL, EN, DE, and wrapped over two lines", () => {
  assert.deepStrictEqual(first("ok\n\nOp do 15 okt 2026 om 12:34 schreef Jan de Vries <jan@devries.nl>:\n> hoi"),
    { addr: "jan@devries.nl", name: "Jan de Vries", kind: "attribution" });
  assert.deepStrictEqual(first("ok\n\nOn Thu, 15 Oct 2026 at 12:34, Jan de Vries <jan@devries.nl> wrote:\n> hi"),
    { addr: "jan@devries.nl", name: "Jan de Vries", kind: "attribution" });
  assert.strictEqual(first("Am Do., 15. Okt. 2026 um 12:34 Uhr schrieb Hans Meier <hans@meier.de>:\n> hallo").addr, "hans@meier.de");
  assert.strictEqual(first("On Thu, 15 Oct 2026 at 12:34, Jan de Vries\n<jan@devries.nl> wrote:\n> hi").addr, "jan@devries.nl");
});

test("blocks come in order, nested quotes included", () => {
  const t = "Done!\n\nFrom: Budget Parts | Gouda <info@budget-parts.nl>\nSent: Thursday\nTo: drachten@budget-parts.nl\nSubject: FW: x\n\n> From: Sander <sander@x.nl>\n> Sent: Thursday\n> To: info@budget-parts.nl\n\n> hoi";
  assert.deepStrictEqual(FO.headerBlocks(t).map((b) => b.addr), ["info@budget-parts.nl", "sander@x.nl"]);
});

test("no header: nothing found", () => {
  assert.deepStrictEqual(FO.headerBlocks("Done!\n\nMet vriendelijke groet,\nTeam Budget Parts Noord"), []);
  assert.deepStrictEqual(FO.headerBlocks(""), []);
  assert.deepStrictEqual(FO.headerBlocks(null), []);
  assert.ok(!FO.hasForwardMarker("Done!"));
});

test("a From: line in running text is not a header block", () => {
  // "From: Rotterdam" in a sentence, with no Sent/To/Subject line under it.
  assert.deepStrictEqual(FO.headerBlocks("Shipping question\nFrom: Rotterdam to Gouda, can you mail me at x@y.nl?\nThanks"), []);
  // An address anywhere else in the body is never read.
  assert.deepStrictEqual(FO.headerBlocks("Please mail attacker@evil.com instead"), []);
});

test("a name-only From line gives a block without an address", () => {
  assert.deepStrictEqual(first("From: Sander Verbeek\nSent: Thursday\nTo: Budget Parts\n\nhoi"), { addr: "", name: "Sander Verbeek", kind: "from" });
});

test("forward subjects; a reply prefix in front is a reply", () => {
  for (const s of ["FW: x", "Fwd: x", "fw : x", "Doorst: x", "WG: x", "TR: x"]) assert.ok(FO.isForwardSubject(s), s);
  for (const s of ["RE: FW: x", "Re: x", "Antw: x", "Forward planning", "x", "", null]) assert.ok(!FO.isForwardSubject(s), String(s));
});

test("the real address is the bracketed one, whatever the display name says", () => {
  assert.strictEqual(FO.addressOf('"jan@dekker.nl" <attacker@evil.com>').addr, "attacker@evil.com");
  assert.strictEqual(FO.addressOf('"Evil <attacker@evil.com>" <real@x.nl>').addr, "real@x.nl");
  assert.strictEqual(FO.addressOf("jan@dekker.nl <real@x.nl>").addr, "real@x.nl");
  assert.strictEqual(FO.addressOf("a@x.nl b@y.nl").addr, "", "two bare addresses: none is read");
});

test("textFrom gives the forwarded message from its header block down", () => {
  const t = "Note from Rob\n\nVan: Klant <k@x.nl>\nVerzonden: do\n\nVraag";
  const b = FO.headerBlocks(t)[0];
  assert.strictEqual(b.line, 2);
  assert.strictEqual(FO.textFrom(t, b), "Van: Klant <k@x.nl>\nVerzonden: do\n\nVraag");
});
