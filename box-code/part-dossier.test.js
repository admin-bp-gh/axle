// part-dossier.test.js — P1.1: prove the pure assembly logic of the part_dossier tool.
// customerCode() (the customer-facing code rule) and assembleDossier() (matched-vs-compact
// shaping, trimming, handle attach, ordering) are unit-tested here with fixtures mirroring
// the live LR027107 Freelander-2 brake-disc family. The SAP/Shopify I/O in partDossier() is
// validated live on the box (the two queries were proven against the real DB during the build).
// Run: node part-dossier.test.js
"use strict";
const C = require("./connectors.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("  FAIL:", m); } };

// --- customerCode(): COALESCE precedence AllMakes > BritPart > Hotbray > U_WS_LRNo > ItemCode
ok(C.customerCode({ ItemCode: "X", U_Code_AllMakes: "AM1", U_Code_BritPart: "BP1", U_WS_LRNo: "LR1" }) === "AM1", "AllMakes wins");
ok(C.customerCode({ ItemCode: "X", U_Code_AllMakes: " ", U_Code_BritPart: "BP1", U_WS_LRNo: "LR1" }) === "BP1", "blank AllMakes -> BritPart");
ok(C.customerCode({ ItemCode: "X", U_Code_Hotbray: "HB1", U_WS_LRNo: "LR1" }) === "HB1", "Hotbray before BaseCode");
ok(C.customerCode({ ItemCode: "X", U_WS_LRNo: "LR1" }) === "LR1", "BaseCode before ItemCode");
ok(C.customerCode({ ItemCode: "X" }) === "X", "falls back to ItemCode");
ok(C.customerCode({ ItemCode: "X", U_Code_AllMakes: null, U_Code_BritPart: "", U_WS_LRNo: "  " }) === "X", "nulls/blanks skipped -> ItemCode");

// --- assembleDossier(): family shaping. Fixture = matched LR027107C + two siblings.
const fam = [
  { ItemCode: "LR027107",  U_WS_LRNo: "LR027107", U_Code_AllMakes: "LR027107",  ItemName: "Brake Disc – Front",         U_Quality: "OEM", U_ABC: "C", U_WS_DropShip: "Y", OnHand: 0, OnOrder: 0, WebPrice: 54.1, U_Tag_Model: "FREELANDER 2 2006-2014 — Front brake disc", U_Alternatives: "LR000470", U_FAQ: "", UserText: "x".repeat(1200) },
  { ItemCode: "LR027107C", U_WS_LRNo: "LR027107", U_Code_AllMakes: "LR027107C", ItemName: "Brake Disc – Coated – Front", U_Quality: "OEM", U_ABC: "D", U_WS_DropShip: "Y", OnHand: 2, OnOrder: 0, WebPrice: 60.7, U_Tag_Model: "FREELANDER 2 2006-2014 — Front brake disc", U_Alternatives: "LR000470", U_FAQ: "Q".repeat(1500), UserText: "Coated front disc." },
  { ItemCode: "LR027107G", U_WS_LRNo: "LR027107", U_Code_AllMakes: "LR027107G", ItemName: "Brake Disc – Front",         U_Quality: "OEM", U_ABC: "D", U_WS_DropShip: "Y", OnHand: 0, OnOrder: 0, WebPrice: 108.8, U_Tag_Model: "FREELANDER 2 2006-2014 — Front brake disc", U_Alternatives: "LR000470", U_FAQ: "", UserText: "y".repeat(900) },
];
const matched = new Set(["LR027107C"]);
const handles = { LR027107C: "brake-disc-coated-front-lr027107c", LR027107: "brake-disc-front-lr027107" };
const out = C.assembleDossier(fam, matched, handles);

ok(out.length === 3, "all family members returned");
ok(out[0].item_code === "LR027107C", "matched item is listed first");
ok(out[0].matched === true, "matched flag set on the resolved item");
ok(out[0].customer_code === "LR027107C" && out[0].handle === "brake-disc-coated-front-lr027107c", "matched item: customer_code + handle");
ok(out[0].on_hand === 2 && out[0].web_price_excl_vat === 60.7, "stock + price carried through");
ok(out[0].faq && out[0].faq.length <= 1001 && out[0].faq.endsWith("…"), "matched faq trimmed to ~1000");
ok(out[0].long_description === "Coated front disc.", "matched long_description carried");

const sib = out.find((x) => x.item_code === "LR027107");
ok(!sib.matched, "sibling has no matched flag");
ok(sib.faq === undefined && sib.long_description === undefined, "siblings stay compact (no heavy text)");
ok(sib.fitment === "FREELANDER 2 2006-2014 — Front brake disc" && sib.alternatives === "LR000470", "siblings keep fitment + alternatives");
ok(sib.handle === "brake-disc-front-lr027107", "sibling handle attached when present");

const noHandle = out.find((x) => x.item_code === "LR027107G");
ok(noHandle.handle === undefined, "missing handle -> undefined (not crash)");

// --- empty family -> empty array, no throw
ok(C.assembleDossier([], new Set(), {}).length === 0, "empty family -> []");

console.log(`\n${pass}/${pass + fail} asserts passed` + (fail ? `  (${fail} FAILED)` : "  ✓"));
process.exit(fail ? 1 : 0);
