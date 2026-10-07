// vocabulary-sync.test.js: Axle's copies of the shared vocabulary must stay identical to Workbench's
// (line endings aside, since a Windows checkout may write CRLF). assets/tokens.css and
// assets/vocabulary.css are never edited here; a change is made in Workbench (web/src/styles) and
// copied across. This catches a copy that was forgotten.
//
// Workbench's folder: AXLE_WORKBENCH_STYLES, else C:\Admin\Projects\Workbench\web\src\styles (the
// box-local Workbench repo). Where that folder does not exist the check is skipped, not failed.
//
// Run: node vocabulary-sync.test.js
"use strict";
const fs = require("fs");
const path = require("path");

const WB = process.env.AXLE_WORKBENCH_STYLES || "C:\\Admin\\Projects\\Workbench\\web\\src\\styles";
if (!fs.existsSync(WB)) {
  console.log("skipped: Workbench styles not found");
  process.exit(0);
}

const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
let fail = 0;
for (const f of ["tokens.css", "vocabulary.css"]) {
  if (read(path.join(__dirname, "assets", f)) === read(path.join(WB, f))) console.log(`  ok: assets/${f} matches Workbench`);
  else {
    fail++;
    console.log(`  FAIL: assets/${f} differs from ${path.join(WB, f)}. Copy Workbench's file over Axle's (never the other way).`);
  }
}
console.log(`\nvocabulary-sync: ${2 - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
