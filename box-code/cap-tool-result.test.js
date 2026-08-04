// cap-tool-result.test.js — P1.3: prove capToolResult never drops the right answer silently.
// It must keep valid JSON, preserve leading rows, mark how many were dropped, and trim the
// dominant array inside a result object (a dossier's items / a finder's candidates). Run:
// node cap-tool-result.test.js
"use strict";
const { capToolResult } = require("./engine.js");

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log("  FAIL:", m); } };
const parses = (s) => { try { JSON.parse(s); return true; } catch { return false; } };

// 1) Under the cap -> returned unchanged, valid JSON.
const small = [{ a: 1 }, { a: 2 }];
ok(capToolResult(small, 12000) === JSON.stringify(small), "small array unchanged");

// 2) Big bare array -> valid JSON, leading rows kept, trailing rows dropped + marker, within cap.
const big = Array.from({ length: 200 }, (_, i) => ({ item_code: "LR" + i, name: "Brake Disc number " + i, blurb: "x".repeat(80) }));
const capped = capToolResult(big, 4000);
ok(capped.length <= 4000, "big array capped to <= maxChars");
ok(parses(capped), "capped array is valid JSON");
const arr = JSON.parse(capped);
ok(arr[0].item_code === "LR0", "leading rows preserved (first row intact)");
const marker = arr[arr.length - 1];
ok(marker && typeof marker._truncated_rows === "number" && marker._truncated_rows > 0, "drop marker present with a count");
ok(arr.length - 1 + marker._truncated_rows === 200, "kept + dropped == original count");

// 3) Dossier-shaped object: the items array is trimmed, sibling fields (query/matched) preserved.
const dossier = {
  query: "LR027107", matched: ["LR027107C"],
  items: Array.from({ length: 12 }, (_, i) => ({ item_code: "LR027107" + i, name: "Brake Disc", faq: "Q".repeat(400), long_description: "D".repeat(400) })),
};
const dCap = capToolResult(dossier, 3000);
ok(dCap.length <= 3000, "dossier object capped to <= maxChars");
ok(parses(dCap), "capped dossier is valid JSON");
const dObj = JSON.parse(dCap);
ok(dObj.query === "LR027107" && Array.isArray(dObj.matched), "non-array fields (query/matched) preserved");
ok(dObj.items[0].item_code === "LR0271070", "first item preserved");
const dMarker = dObj.items[dObj.items.length - 1];
ok(dMarker && dMarker._truncated_rows > 0, "items array carries the drop marker");

// 4) Object with no array but oversized -> clearly-marked hard slice (still bounded).
const blob = { note: "z".repeat(9000) };
const bCap = capToolResult(blob, 1000);
ok(bCap.length <= 1000, "oversized blob hard-sliced within cap");
ok(bCap.includes("[truncated]"), "blob slice carries a truncation marker");

// 5) capFor tiers
const { capFor } = require("./engine.js");
ok(capFor("part_dossier") === 12000 && capFor("part_finder") === 12000 && capFor("sap_query") === 12000, "part tools -> 12000");
ok(capFor("myparcel_track") === 6000 && capFor("anything_else") === 6000, "other/default -> 6000");

console.log(`\n${pass}/${pass + fail} asserts passed` + (fail ? `  (${fail} FAILED)` : "  ✓"));
process.exit(fail ? 1 : 0);
