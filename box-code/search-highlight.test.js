// search-highlight.test.js - the words a queue row marks in place (round 2, request 12): the same
// words the snippet looks for (folded, "#id" left out, short words only when no long one was typed)
// and every place they occur, as merged [start, end) positions in the original text, accents and
// case ignored.
// SAFETY: AXLE_DB is a throwaway file.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.AXLE_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "axle-hl-")), "test.db");
const S = require("./search.js");

test("matchWords: folded, #id dropped, short words only on their own", () => {
  assert.deepStrictEqual(S.matchWords("Remklauw #12 de STC"), ["remklauw", "stc"]);
  assert.deepStrictEqual(S.matchWords("de ab"), ["de", "ab"]);
  assert.deepStrictEqual(S.matchWords("Café"), ["cafe"]);
  assert.deepStrictEqual(S.matchWords("#12"), []);
});

test("hitRanges: every occurrence, case and accents ignored, overlaps merged", () => {
  const text = "Défender flange, DEFENDER";
  assert.deepStrictEqual(S.hitRanges(text, S.matchWords("defender")), [[0, 8], [17, 25]]);
  assert.deepStrictEqual(S.hitRanges("STC1234", S.matchWords("stc1 c123")), [[0, 6]]);
  assert.deepStrictEqual(S.hitRanges("nothing here", S.matchWords("flange")), []);
  const [[a, b]] = S.hitRanges("Order TVC100160", S.matchWords("vc10016"));
  assert.strictEqual("Order TVC100160".slice(a, b), "VC10016");
});
