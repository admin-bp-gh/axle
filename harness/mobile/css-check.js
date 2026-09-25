// css-check.js - tiny CSS reader for the phase-0 static checks (4.4/K5 note: "static check;
// emulation reports 0" - env(safe-area-inset-*) and the vh/dvh fallback pattern must be read
// from the source text, since a headless browser always resolves env() to 0). Not a full CSS
// parser: just enough brace/selector splitting to find rule bodies by selector name, at the
// top level and inside @media blocks.
"use strict";

// Parses `css` into a flat list of {selectors: [string], body: string, atRule: string|null}.
function parseRules(css, atRule) {
  const rules = [];
  // Comments are stripped first: a comment sitting directly before an @media line would
  // otherwise be glued onto its head and the block would no longer be recognised as an at-rule.
  css = css.replace(/\/\*[\s\S]*?\*\//g, " ");
  let i = 0;
  while (i < css.length) {
    // skip whitespace/comments
    while (i < css.length && /\s/.test(css[i])) i++;
    if (i >= css.length) break;
    const headStart = i;
    while (i < css.length && css[i] !== "{" && css[i] !== "}") i++;
    if (i >= css.length) break;
    if (css[i] === "}") { i++; continue; } // stray close, ignore
    const head = css.slice(headStart, i).trim();
    // consume the matching { ... } block
    let depth = 0, blockStart = i;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") { depth--; if (depth === 0) { i++; break; } }
    }
    const inner = css.slice(blockStart + 1, i - 1);
    if (!head) continue;
    if (head.startsWith("@")) {
      // recurse: everything inside is nested rules under this at-rule
      rules.push(...parseRules(inner, head));
    } else {
      rules.push({ selectors: head.split(",").map((s) => s.trim()), body: inner, atRule: atRule || null });
    }
  }
  return rules;
}

// Concatenated bodies of every rule anywhere in `css` whose selector list contains exactly
// `name` (e.g. "header", ".m-back", ".actionbar").
function bodiesFor(rules, name) {
  return rules.filter((r) => r.selectors.includes(name)).map((r) => r.body);
}

// Concatenated bodies of every rule whose selector list contains a selector that IS `name`
// or starts with `name` followed by a combinator/pseudo/attribute (covers "header",
// "header .x", "header:has(...)" etc. - used for the env(safe-area-inset-) check, which the
// brief only requires to be present somewhere in "the rules for X").
function bodiesForPrefix(rules, name) {
  const isMatch = (s) => s === name || s.startsWith(name + " ") || s.startsWith(name + ":") || s.startsWith(name + "[") || s.startsWith(name + ".") || s.startsWith(name + ">");
  return rules.filter((r) => r.selectors.some(isMatch)).map((r) => r.body);
}

function mediaMaxWidthRules(rules, maxWidthPx) {
  const marker = "media (max-width: " + maxWidthPx + "px)";
  return rules.filter((r) => r.atRule && r.atRule.replace(/\s+/g, " ").includes(marker.replace(/\s+/g, " ")));
}

// Does the concatenated text for `name` (top-level + inside the 1100px block) contain
// "env(safe-area-inset-"?
function hasSafeAreaEnv(css, name) {
  const rules = parseRules(css, null);
  const text = bodiesForPrefix(rules, name).join("\n");
  return text.includes("env(safe-area-inset-");
}

// For each name in `names`: every bare `<num>vh` declaration must be followed, later in the
// declaration order for that selector, by a `dvh` declaration of the SAME property.
function checkVhFallback(css, names) {
  const rules = parseRules(css, null);
  const out = {};
  for (const name of names) {
    const bodies = bodiesFor(rules, name);
    const decls = [];
    bodies.forEach((body) => body.split(";").forEach((d) => { const t = d.trim(); if (t) decls.push(t); }));
    let ok = true;
    const bad = [];
    for (let i = 0; i < decls.length; i++) {
      const d = decls[i];
      if (/\d+(?:\.\d+)?[sld]vh\b/.test(d)) continue; // dvh/svh/lvh - not a bare vh
      const m = /^([a-zA-Z-]+)\s*:.*?\d+(?:\.\d+)?vh\b/.exec(d);
      if (!m) continue;
      const prop = m[1];
      const laterDvh = decls.slice(i + 1).some((d2) => new RegExp("^" + prop + "\\s*:").test(d2) && /dvh\b/.test(d2));
      if (!laterDvh) { ok = false; bad.push(d); }
    }
    out[name] = { ok, bad, declCount: decls.length };
  }
  return out;
}

module.exports = { parseRules, bodiesFor, bodiesForPrefix, mediaMaxWidthRules, hasSafeAreaEnv, checkVhFallback };
