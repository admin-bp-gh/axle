// handover.test.js - owner handover with a note (2026-10-09): the note's sanitiser, the record,
// the seed block the drafter reads, the forward comment, and the ingest guard that keeps our own
// forward from becoming a second item in the receiving mailbox.
// Run: node handover.test.js
const assert = require("assert");
const HO = require("./handover.js");

let pass = 0;
const test = (name, fn) => { fn(); pass++; console.log("  ok  " + name); };

console.log("handover");

test("cleanNote keeps printable text and line breaks, caps length", () => {
  assert.strictEqual(HO.cleanNote("  Customer called.\r\n\r\n\r\nWants   the  bracket\u0007 too  "), "Customer called.\n\nWants the bracket too");
  assert.strictEqual(HO.cleanNote("x".repeat(HO.MAX_NOTE + 5)).length, HO.MAX_NOTE);
  assert.strictEqual(HO.cleanNote(null), "");
});

test("record carries who, from, to, the note and where the forward went", () => {
  const r = HO.record({ note: " check stock first ", byName: "Jack", byLogin: "jack@bp", fromOwner: "Sales(Gouda)", toOwner: "Drachten", forwardedTo: "drachten@budget-parts.nl", forwardedBox: "drachten" });
  assert.strictEqual(r.note, "check stock first");
  assert.strictEqual(r.by, "Jack");
  assert.strictEqual(r.from_owner, "Sales(Gouda)");
  assert.strictEqual(r.to_owner, "Drachten");
  assert.strictEqual(r.forwarded_box, "drachten");
  assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(r.at));
  const same = HO.record({ note: "", byName: "", byLogin: "tom@bp", fromOwner: null, toOwner: "Tom" });
  assert.strictEqual(same.by, "tom@bp");
  assert.strictEqual(same.forwarded_to, null);
});

test("read tolerates missing or broken json", () => {
  assert.strictEqual(HO.read({}), null);
  assert.strictEqual(HO.read({ handover_json: "{broken" }), null);
  assert.strictEqual(HO.read({ handover_json: JSON.stringify({ note: "x" }) }), null, "no to_owner = no handover");
  assert.strictEqual(HO.read({ handover_json: JSON.stringify(HO.record({ note: "x", byLogin: "a", toOwner: "Brad" })) }).to_owner, "Brad");
});

test("seedBlock names the note as trusted staff input and carries our replies, capped", () => {
  const b = HO.seedBlock(HO.record({ note: "already refunded 12.50", byName: "Vera", byLogin: "vera@bp", fromOwner: "Sales(Gouda)", toOwner: "Brad" }),
    [{ sent_at: "2026-10-01 10:00:00", by: "jack@bp", to: "c@x.nl", text: "y".repeat(2000) }]);
  assert.ok(/TRUSTED/.test(b.note));
  assert.strictEqual(b.colleague_note, "already refunded 12.50");
  assert.strictEqual(b.handed_over_by, "Vera");
  assert.strictEqual(b.our_replies.length, 1);
  assert.strictEqual(b.our_replies[0].text.length, 1500);
  assert.strictEqual(HO.seedBlock(null), null);
});

test("forwardComment puts the note under forward-guard's own note, nothing when empty", () => {
  const base = "Handed over in Axle by Jack.\nFrom: Sales(Gouda)  ->  To: Drachten\n\n";
  assert.strictEqual(HO.forwardComment(base, "  "), base);
  assert.strictEqual(HO.forwardComment(base, "please call them"), base + "Note from the colleague:\nplease call them\n\n");
});

test("isOwnForward matches a recent handover to this box by subject once FW: is stripped", () => {
  const rec = HO.record({ note: "n", byLogin: "jack@bp", fromOwner: "Sales(Gouda)", toOwner: "Drachten", forwardedTo: "drachten@budget-parts.nl", forwardedBox: "drachten" });
  const recent = [{ id: 41, subject: "Re: Discovery 3 brake pads", handover_json: JSON.stringify(rec) },
                  { id: 42, subject: "Defender door seal", handover_json: JSON.stringify({ ...rec, forwarded_box: "info" }) }];
  assert.strictEqual(HO.isOwnForward({ subject: "FW: Re: Discovery 3 brake pads" }, "drachten", recent), 41);
  assert.strictEqual(HO.isOwnForward({ subject: "Doorst: Discovery 3 brake pads" }, "drachten", recent), 41);
  assert.strictEqual(HO.isOwnForward({ subject: "FW: Discovery 3 brake pads" }, "info", recent), null, "forwarded to the other box");
  assert.strictEqual(HO.isOwnForward({ subject: "FW: Defender door seal" }, "drachten", recent), null);
  assert.strictEqual(HO.isOwnForward({ subject: "FW: something else" }, "drachten", recent), null);
  assert.strictEqual(HO.isOwnForward({ subject: "" }, "drachten", recent), null);
});

console.log(`\n${pass} passed`);

// The outlook-close guard: a forwarded handover is not closed on 'read' (the forward marks it read).
const OC = require("./outlook-close.js");
test("outlook-close keeps a forwarded handover open on 'read', closes it on 'moved' and 'gone'", () => {
  const fwd = { handover_json: JSON.stringify(HO.record({ note: "n", byLogin: "a", toOwner: "Drachten", forwardedTo: "drachten@budget-parts.nl", forwardedBox: "drachten" })) };
  const same = { handover_json: JSON.stringify(HO.record({ note: "n", byLogin: "a", toOwner: "Tom" })) };
  assert.ok(OC.handedOver(fwd));
  assert.ok(!OC.handedOver(same), "a same-mailbox handover sent nothing, so 'read' is still the team's gesture");
  assert.ok(!OC.handedOver({ handover_json: null }));
  const mon = new Set(["inbox"]);
  assert.strictEqual(OC.decide({ isRead: true, folderId: "inbox" }, mon, OC.handedOver(fwd)), null);
  assert.strictEqual(OC.decide({ isRead: true, folderId: "inbox" }, mon, OC.handedOver(same)), "read");
  assert.strictEqual(OC.decide({ isRead: true, folderId: "other" }, mon, true), "moved");
  assert.strictEqual(OC.decide({ gone: true }, mon, true), "gone");
});
console.log(`\n${pass} passed (with outlook-close guard)`);
