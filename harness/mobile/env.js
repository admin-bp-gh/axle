// env.js - shared paths and small helpers for the mobile harness.
"use strict";
const path = require("path");
const crypto = require("crypto");

const MOBILE_DIR = __dirname;                       // .../harness/mobile
const HARNESS_DIR = path.join(MOBILE_DIR, "..");     // .../harness
const REPO_ROOT = path.join(HARNESS_DIR, "..");      // repo root
const STEP0_DIR = path.join(HARNESS_DIR, "step0");
const DEFAULT_TREE = path.join(REPO_ROOT, "box-code");

// "393x852,375x812" -> [{label:"393x852", width:393, height:852}, ...]
function parseWidths(s) {
  return String(s || "").split(",").map((w) => w.trim()).filter(Boolean).map((w) => {
    const m = /^(\d+)x(\d+)$/.exec(w);
    if (!m) throw new Error("bad --widths entry: " + w + " (expected WIDTHxHEIGHT)");
    return { label: w, width: +m[1], height: +m[2] };
  });
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function outDir(relOrAbs) {
  return path.isAbsolute(relOrAbs) ? relOrAbs : path.join(REPO_ROOT, relOrAbs);
}

module.exports = { MOBILE_DIR, HARNESS_DIR, REPO_ROOT, STEP0_DIR, DEFAULT_TREE, parseWidths, sha256Hex, outDir };
