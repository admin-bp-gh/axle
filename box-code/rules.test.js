// rules.test.js — routing rules (rules.js) and the owner labels derived from them.
//
// Exists because of the 2026-08-06 misroute: `supplier_invoice` matched on sender OR subject, so
// any email whose subject contained "factuur"/"invoice" went to purchasing. #992 — a Belgian
// customer's propshaft complaint, subject "Klacht propshaft … factuur #427858" — was routed to
// Tom and sat in a queue nobody watches. These tests pin the shape that prevents it: a supplier
// rule may key on WHO sent the mail, never on a word a customer might use in a subject line.
const test = require("node:test");
const assert = require("node:assert");
const rulesets = require("./rules.js");
const { ownerChoices } = require("./views/ui.js");

const SALES = "Sales(Gouda)";
const email = (address, subject) => ({ from: { address }, subject });
const route = (address, subject, box = "info") =>
  rulesets.matchRule(email(address, subject), rulesets[box].rules);

// --- the regression -------------------------------------------------------------------
test("a customer complaint mentioning an invoice number is NOT a supplier email", () => {
  const r = route("benjamin@cartek.be", "Klacht propshaft LR037027G — factuur #427858 — trillingen na montage");
  assert.notStrictEqual(r.id, "supplier_invoice", "the #992 misroute is back");
  assert.strictEqual(r.owner, SALES);
});

test("neither does the English wording, from any customer domain", () => {
  for (const [addr, subj] of [
    ["someone@example.com", "Question about invoice 428100"],
    ["klant@bedrijf.nl", "Vraag over factuur 428100"],
    ["buyer@garage.co.uk", "Wrong item on invoice — please advise"],
  ]) {
    assert.strictEqual(route(addr, subj).owner, SALES, `${addr} / ${subj}`);
  }
});

// --- the supplier rules still do their real job ---------------------------------------
// Their purpose is not routing to a person: it is keeping supplier correspondence out of the
// drafting path. If one of these ever starts drafting, Axle writes customer-style replies to
// Allmakes and MyParcel.
test("supplier mail still matches its rule, by sender", () => {
  assert.strictEqual(route("facturen@myparcel.nl", "Factuur 2026-08").id, "supplier_invoice");
  assert.strictEqual(route("facturen@myparcel.nl", "Herinnering").id, "supplier_invoice",
    "an unexpected subject must not drop the invoice out of the rule");
  assert.strictEqual(route("nethbil@fedex.com", "Invoice 771-2288").id, "supplier_invoice");
  assert.strictEqual(route("psp@allmakes.co.uk", "WARP claim 88213").id, "warranty_warp");
  assert.strictEqual(route("sales@allmakes.co.uk", "Order acknowledgement 91188").id, "supplier_order");
  assert.strictEqual(route("info@breeland.nl", "Levering week 33").id, "supplier_direct");
});

test("no supplier rule drafts", () => {
  for (const id of ["supplier_invoice", "warranty_warp", "supplier_order", "supplier_direct"]) {
    const rule = rulesets.info.rules.find((r) => r.id === id);
    assert.ok(rule, id + " is missing");
    assert.ok(!rule.draft, id + " must not draft");
  }
});

test("supplier marketing is still archived", () => {
  assert.strictEqual(route("marketing@allmakes.co.uk", "New catalogue").action, "archive");
  assert.strictEqual(route("sales@hotbray.net", "Summer offers").action, "archive");
});

// --- nothing routes to purchasing any more --------------------------------------------
test("no rule in either mailbox assigns to Tom", () => {
  for (const box of ["info", "drachten"]) {
    const owners = rulesets[box].rules.map((r) => r.owner).filter(Boolean);
    assert.ok(!owners.includes("Tom"), `${box} still routes to Tom: ${owners.join(", ")}`);
  }
});

test("...but Tom remains a manual reassign target on info@ only", () => {
  assert.ok(ownerChoices("info").includes("Tom"));
  assert.ok(!ownerChoices("drachten").includes("Tom"));
});

test("owner choices are otherwise still derived from the rules", () => {
  assert.deepStrictEqual(ownerChoices("info"), [SALES, "Tom"]);
  assert.deepStrictEqual(ownerChoices("drachten"), ["Drachten"]);
});

// --- the catch-all safety net ----------------------------------------------------------
test("an unrecognised sender lands on sales, drafted", () => {
  const r = route("nobody@nowhere.example", "Do you have a rear diff for a Disco 2?");
  assert.strictEqual(r.id, "catch_all");
  assert.strictEqual(r.owner, SALES);
  assert.ok(r.draft);
});

test("drachten routes everything to Drachten", () => {
  assert.strictEqual(route("nobody@nowhere.example", "Vraag", "drachten").owner, "Drachten");
  assert.strictEqual(route("benjamin@cartek.be", "Klacht factuur #427858", "drachten").owner, "Drachten");
});
