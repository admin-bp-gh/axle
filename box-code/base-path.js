// base-path.js - the URL prefix Axle is served under (W3, shell integration, 2026-10).
//
// AXLE_BASE_PATH (box .env, optional). Unset or empty keeps the old root mount. At the Workbench
// cutover the shell frames Axle at https://axle-box.tail58a804.ts.net/axle/, and the .env then holds:
//   AXLE_BASE_PATH=/axle
//   AXLE_ALLOWED_ORIGIN=https://axle-box.tail58a804.ts.net      (comma-separated list accepted)
//   AXLE_BASE_URL=https://axle-box.tail58a804.ts.net/axle       (the emailed handover link base;
//                                                               it already carries the prefix, so
//                                                               nothing appends BASE to it in code)
//
// The value is normalised to "" or "/seg[/seg...]": leading slash added, trailing slashes dropped.
// Only letters, digits, "_" and "-" are allowed in a segment, so the result is safe to drop into
// HTML attributes, CSS selectors and RegExp sources unescaped. Anything else stops the server at
// startup rather than serving a half-prefixed app.
//
// BASE.path        "" or "/axle"
// BASE.url(p)      prefixes an app-absolute path: url("/item/5") -> "/axle/item/5", url("/") -> "/axle/"
// BASE.has(u)      true when a request URL already carries the prefix
"use strict";

function normalise(v) {
  let s = String(v == null ? "" : v).trim().replace(/\/+$/, "");
  if (!s) return "";
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/{2,}/g, "/");
  if (!/^(\/[A-Za-z0-9_-]+)+$/.test(s)) throw new Error(`AXLE_BASE_PATH "${v}" is not a plain path such as /axle`);
  return s;
}

function make(raw) {
  const path = normalise(raw);
  const url = (p) => path + (String(p).startsWith("/") ? String(p) : "/" + String(p));
  const has = (u) => !path || u === path || u.startsWith(path + "/") || u.startsWith(path + "?");
  return { path, url, has };
}

module.exports = { ...make(process.env.AXLE_BASE_PATH), normalise, make };
