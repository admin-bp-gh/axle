// review-2026-10.test.js - the reliability fixes from the 10 Oct 2026 draft-vs-sent review.
//
// Covers: empty product links refused at send (send 480), the reply sign-off aligned with the
// reply's language and a language mismatch flagged (nine mismatched sign-offs, send 480), claimed
// actions flagged unless staff input is present (sends 480, 623), and the day-old wording check
// behind the item page's stale-draft warning (sends 481, 509). The own-mailbox recipient guard
// (sends 578, 603) is tested in recipient.test.js.
//
// Run: node review-2026-10.test.js
"use strict";
const assert = require("assert");
const SG = require("./send-guard.js");
const E = require("./engine.js");
const DS = require("./draft-staleness.js");

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log("  ok ", name); };

const item = { id: 1, mailbox: "info", subject: "Vraag", sender_email: "jan@dekker4x4.nl", origin: "inbound", rule_id: "catch_all" };

test("a product link with no product page is refused at send", () => {
  const body = "Hallo,\n\n[TF8006 - Roof Rack](https://www.roverparts.eu/products/)\n\nMet vriendelijke groet,\nTeam Budget Parts";
  assert.throws(() => SG.assembleSend(item, body), /product link/);
  assert.throws(() => SG.assembleNewOutboundSend({ ...item, recipient: "jan@dekker4x4.nl" }, body, "Re"), /product link/);
  assert.deepStrictEqual(SG.findEmptyProductLinks("https://www.roverparts.eu/nl/products"), ["https://www.roverparts.eu/nl/products"]);
  const good = "[TF8006 - Roof Rack](https://www.roverparts.eu/products/tf8006-roof-rack)";
  assert.equal(SG.findEmptyProductLinks(good).length, 0);
  assert.ok(SG.assembleSend(item, good));
});

const EN_BODY = "Hi Michael,\n\nWe found your order and it is in stock. It will ship today and you will receive the tracking link by email once the parcel is on its way to you.\n\n";
const NL_BODY = "Hallo Michael,\n\nWe hebben je bestelling gevonden en de onderdelen zijn op voorraad. Deze wordt vandaag verzonden en je ontvangt de track en trace van ons per e-mail.\n\n";

test("textLanguage reads Dutch, English and German, and stays silent on short text", () => {
  assert.equal(E.textLanguage(NL_BODY), "nl");
  assert.equal(E.textLanguage(EN_BODY), "en");
  assert.equal(E.textLanguage("Hallo Herr Meier,\n\nvielen Dank für Ihre Anfrage. Die Teile sind auf Lager und wir haben die Bestellung für Sie fertig, sie wird heute versandt."), "de");
  assert.equal(E.textLanguage("Prima, wordt geregeld."), "");
});

test("the sign-off follows the language the reply is written in", () => {
  let r = E.applyLanguageGate({ draft: EN_BODY + "Met vriendelijke groet,\nTeam Budget Parts", language: "en" }, "en");
  assert.ok(r.draft.endsWith("Kind regards,\nTeam Budget Parts"), r.draft);
  r = E.applyLanguageGate({ draft: NL_BODY + "Kind regards,\nTeam Budget Parts", language: "nl" }, "nl");
  assert.ok(r.draft.endsWith("Met vriendelijke groet,\nTeam Budget Parts"));
  // A short reply falls back to the model's language field.
  r = E.applyLanguageGate({ draft: "Hi,\n\nOn its way.\n\nMet vriendelijke groet,\nTeam Budget Parts", language: "en" }, "en");
  assert.ok(r.draft.endsWith("Kind regards,\nTeam Budget Parts"));
  // "regards" in the body is not a sign-off.
  r = E.applyLanguageGate({ draft: "Hi,\n\nWith regards to your order, it ships today.\n\nKind regards,\nTeam Budget Parts", language: "en" }, "en");
  assert.ok(r.draft.includes("With regards to your order"));
  assert.ok(!(r.questions_for_salesperson || []).length);
});

test("a reply in another language than the customer's is flagged, not withdrawn", () => {
  const r = E.applyLanguageGate({ draft: NL_BODY + "Met vriendelijke groet,\nTeam Budget Parts", language: "nl", confidence: "high" }, "en");
  assert.ok(r.draft.length > 0, "the draft stays");
  assert.ok(r.questions_for_salesperson.some((q) => /written in Dutch.*English/.test(q)));
  assert.equal(r.confidence, "medium");
});

test("claimed actions are flagged unless staff input is present", () => {
  let r = E.applyActionClaimCheck({ draft: "Dag Michaël,\n\nDe orderbevestiging is opnieuw verstuurd naar je e-mailadres.", confidence: "high" }, false);
  assert.ok(r.questions_for_salesperson.some((q) => /opnieuw verstuurd/.test(q)));
  assert.equal(r.confidence, "medium");
  r = E.applyActionClaimCheck({ draft: "We'll check with the warehouse and get back to you." }, false);
  assert.equal(r.questions_for_salesperson.length, 1);
  r = E.applyActionClaimCheck({ draft: "Je bestelling is geannuleerd." }, true);
  assert.ok(!r.questions_for_salesperson, "a redraft after staff feedback is not flagged");
  r = E.applyActionClaimCheck({ draft: "Prima, wordt geregeld - gaat vandaag nog mee." }, false);
  assert.ok(!r.questions_for_salesperson, "the house-style trade confirmation is not a claimed action");
});

test("applyGates runs both new checks", () => {
  const r = E.applyGates({ status: "ready", draft: EN_BODY + "We have cancelled the second line.\n\nMet vriendelijke groet,\nTeam Budget Parts", language: "en", confidence: "high" }, { language: "en", staffInput: false });
  assert.ok(r.draft.endsWith("Kind regards,\nTeam Budget Parts"));
  assert.ok(r.questions_for_salesperson.some((q) => /cancelled/.test(q)));
});

test("day-old wording: only a draft from an earlier Amsterdam day that leans on the day", () => {
  const now = Date.parse("2026-10-10T07:00:00Z");                  // 09:00 in Amsterdam
  const yesterdayEve = { created_at: "2026-10-09 18:30:00" };       // 20:30 the day before
  const thisMorning = { created_at: "2026-10-10 06:30:00" };
  assert.ok(DS.isDayOldWording(yesterdayEve, "Goedenavond Jan,\n\nHet pakket is vandaag verstuurd.", now));
  assert.ok(!DS.isDayOldWording(yesterdayEve, "Hallo Jan,\n\nHet pakket is onderweg.", now));
  assert.ok(!DS.isDayOldWording(thisMorning, "Het pakket is vandaag verstuurd.", now));
  assert.ok(!DS.isDayOldWording({ created_at: "" }, "vandaag", now));
  // 23:30 UTC on 9 Oct is 01:30 on 10 Oct in Amsterdam: the same day as now.
  assert.ok(!DS.isDayOldWording({ created_at: "2026-10-09 23:30:00" }, "vandaag", now));
});

console.log(`\n${pass} passed`);
