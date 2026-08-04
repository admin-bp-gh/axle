// part-finder.test.js — P1.2: prove the pure logic of the part_finder tool.
// vinDecode / modelToColumn / categoryFromTokens / rankCandidates are unit-tested here with
// fixtures mirroring the live Freelander-2 front/rear brake-disc set. The SAP/Shopify I/O in
// partFinder() is validated live on the box (the candidate query + flag filter were proven
// against the real DB during the build). Run: node part-finder.test.js
"use strict";
const C = require("./connectors.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("  FAIL:", m); } };

// --- vinDecode(): year from position 10, model left null (conservative), WMI flagged
const v = C.vinDecode("SALLAAAA6FA123456");   // pos10 (index 9) = 'F' -> 2015
ok(v.year === 2015 && v.year_approx === true, "VIN -> model year 2015 (approx)");
ok(v.model === null && v.is_landrover === true, "LR VIN: model left null, WMI flagged landrover");
ok(C.vinDecode("SAJ12345678901234").model === "Jaguar", "SAJ WMI -> Jaguar (so the draft can decline)");
ok(C.vinDecode("ABC123").year === null, "short string -> not a VIN, no year");

// --- modelToColumn(): correct U_M_* column, specificity, year handling
ok(C.modelToColumn("Defender", null).column === "U_M_Def_Old", "unqualified Defender -> Def_Old");
ok(C.modelToColumn("Defender", 2021).column === "U_M_Def_New", "Defender 2021 -> Def_New");
ok(C.modelToColumn("Range Rover Sport", 2010).column === "U_M_RR_Sport_05_13", "RR Sport 2010 (checked before RR)");
ok(C.modelToColumn("Range Rover", 2010).column === "U_M_RR_02_12", "Range Rover 2010 -> L322");
ok(C.modelToColumn("Range Rover", null).column === null && C.modelToColumn("Range Rover", null).year_needed, "Range Rover, no year -> unresolved + year_needed");
ok(C.modelToColumn("Discovery 3", null).column === "U_M_Disc3", "Discovery 3 by number");
ok(C.modelToColumn("Discovery", 2012).column === "U_M_Disc4", "Discovery + 2012 -> Disc4");
ok(C.modelToColumn("Freelander 2", null).column === "U_M_Free_2", "Freelander 2");
ok(C.modelToColumn("Evoque", 2015).column === "U_M_Evoque_12_18", "Evoque 2015");
ok(C.modelToColumn("Velar", null).column === "U_M_Velar_17", "Velar");
ok(C.modelToColumn("Series 2a", null).column === "U_M_Series_2_3", "Series 2a -> Series 2/3");
ok(C.modelToColumn("Bugatti Veyron", null).column === null, "unknown model -> null");

// --- categoryFromTokens()
ok(C.categoryFromTokens(["front", "brake", "disc"]) === "U_C_Braking", "brake/disc -> Braking");
ok(C.categoryFromTokens(["clutch", "kit"]) === "U_C_Clutch", "clutch -> Clutch");
ok(C.categoryFromTokens(["widget"]) === null, "no category keyword -> null");

// --- rankCandidates(): front discs out-rank rear; in-stock + category boost; evidence attached.
// Fixture mirrors the live U_M_Free_2 brake-disc rows.
const rows = [
  { ItemCode: "LR027107",  U_Code_AllMakes: "LR027107",  ItemName: "Brake Disc – Front",          U_Quality: "OEM",         U_ABC: "C", OnHand: 0, WebPrice: 54.1, U_Tag_Model: "FREELANDER 2 2006-2014 — Front brake disc", U_Alternatives: "LR000470", CatFlag: "Y" },
  { ItemCode: "LR000571",  U_Code_AllMakes: "LR000571",  ItemName: "Disc Brake Front Frl2, Evoque", U_Quality: "OEM",        U_ABC: "D", OnHand: 4, WebPrice: 48.3, U_Tag_Model: "FREELANDER 2 — front brake disc", U_Alternatives: "", CatFlag: "Y" },
  { ItemCode: "LR001018",  U_Code_AllMakes: "LR001018",  ItemName: "Brake Disc – Rear",            U_Quality: "OEM",         U_ABC: "D", OnHand: 4, WebPrice: 27.2, U_Tag_Model: "FREELANDER 2 2006-2014 — Rear brake disc", U_Alternatives: "", CatFlag: "Y" },
  { ItemCode: "LR001019",  U_Code_AllMakes: "LR001019",  ItemName: "Brake Disc – Rear",            U_Quality: "Aftermarket", U_ABC: "C", OnHand: 0, WebPrice: 34.3, U_Tag_Model: "FREELANDER 2 — rear brake disc", U_Alternatives: "", CatFlag: "Y" },
];
const handles = { LR000571: "disc-brake-front-frl2", LR027107: "lr027107c-front-disc" };
const ranked = C.rankCandidates(rows, ["front", "brake", "disc"], { column: "U_M_Free_2", hasCat: true, handleMap: handles, limit: 15 });

ok(ranked[0].item_code === "LR000571", "top = in-stock front disc (3 tokens + stock + cat)");
ok(ranked[1].item_code === "LR027107", "2nd = out-of-stock front disc (3 tokens, no stock boost)");
ok(ranked.findIndex((c) => c.item_code === "LR001018") > 1, "rear discs (2 tokens) rank below the front ones");
ok(ranked[0].customer_code === "LR000571" && ranked[0].handle === "disc-brake-front-frl2", "candidate carries customer_code + handle");
ok(JSON.stringify(ranked[0].match.tokens_matched.sort()) === JSON.stringify(["brake", "disc", "front"]), "match evidence lists the hit tokens");
ok(ranked[0].match.model_flag === "U_M_Free_2", "match evidence names the model flag");
ok(ranked[1].fitment === "FREELANDER 2 2006-2014 — Front brake disc", "fitment note carried for disambiguation");
ok(C.rankCandidates([], ["x"], {}).length === 0, "no rows -> []");
ok(C.rankCandidates(rows, ["front", "brake", "disc"], { limit: 2 }).length === 2, "limit respected");

console.log(`\n${pass}/${pass + fail} asserts passed` + (fail ? `  (${fail} FAILED)` : "  ✓"));
process.exit(fail ? 1 : 0);
