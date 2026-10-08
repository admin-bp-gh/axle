// reply-format.js - the formatting markers of a stored reply (round 2, request 3). ONE grammar, used
// by the send path (send-guard toSafeHtml), the read-only displays (views/ui.js replyParas), plain
// text consumers (exemplars, reply translation, the search index) and the rich editor (phase 3).
//
// The stored reply stays plain text. Markers:
//   **bold**        bold
//   *italic*        italic
//   ***both***      bold and italic; bold may contain italic and italic may contain bold:
//                   "**a *b* c**" and "*a **b** c*"
//   __underline__   underline (round 3): exactly two underscores. It nests with bold and italic in
//                   any order ("__a **b**__", "**a __b__**", "__*a*__"). A single underscore and a
//                   run of three or more are always literal ("LR_012345", "foto_1.jpg", "___").
//   - item          a line starting with "- " (hyphen, space, at the very start of the line) is a
//                   bulleted list item; consecutive such lines form one list. The item text may carry
//                   bold, italic and underline. Nested lists do not exist.
//   \* and \\*      backslashes are special only in a run that stands directly before an asterisk:
//                   in such a run each pair "\\" is one literal backslash and a final single "\"
//                   makes the asterisk literal ("\*" shows "*", "\\*x*" shows "\" then italic x,
//                   "\\\*" shows "\*"). Every other backslash, single or doubled, is an ordinary
//                   character ("\\nas\share" shows as typed), so text without an asterisk is never
//                   changed by a backslash. A Windows path ending in an asterisk is therefore read
//                   as escaping it ("C:\dir\*.txt" shows "C:\dir*.txt"); typed in the editor it
//                   is stored "C:\dir\\\*.txt" and shows as typed.
//   \__ and \\__    the same backslash rule before a "__", but only for a "__" that pairs as a marker
//                   when the backslashes before it are read as ordinary characters (and the escapes
//                   found so far applied, repeated until no further one is found): then "\__a__"
//                   shows "__a__", "\\__a__" shows "\" then underlined a, and "__a \__b__" is
//                   underlined "a __b". Before a "__" that pairs with nothing the backslashes are
//                   ordinary ("C:\__temp" shows as typed), so text without a "__" pair is never
//                   changed.
//                   Two such paths on one line hold a pair and lose those backslashes ("C:\__a and
//                   C:\__b" shows "C:__a and C:__b"), as a path before an asterisk does.
// Rules:
//   - markers apply within one line, never across a line break (CRLF and LF are both line breaks);
//   - an opening marker must be followed by a non-space and a closing marker preceded by a non-space,
//     so "5 * 3 = 15" and "a ** b" stay literal;
//   - a run of more than three asterisks is literal, as is a run of underscores other than two; a
//     marker that finds no partner stays literal text ("**a" shows "**a"; "**a *b**" is bold "a *b",
//     the unpaired "*" literal); a pair that closes makes every unpaired opener inside it literal
//     ("**a __b** c__" is bold "a __b" then " c__");
//   - links "[text](https://...)", bare URLs and image tokens "[image:N]" are atoms (tokens() below,
//     the ONE tokeniser for the send path, the display and the editor) and may sit inside formatted
//     text ("**see [our page](https://www.roverparts.eu/x)**"); markers inside an atom are not
//     interpreted and a link's text shows as typed;
//   - a bare URL runs from "http(s)://" to the first white space, <, >, " or ', and ends earlier at a
//     ")" that does not close a "(" inside the URL; then trailing ] . , ; : ! ? * are given back to
//     the text one by one (a ")" there only when it closes nothing). So "(https://x.nl/a)" and
//     "(https://x.nl/a)and" link https://x.nl/a, "*https://x.nl/a*" is an italic link,
//     "https://x.nl/a's" links https://x.nl/a and "https://x.nl/wiki/A_(b)" keeps its ")";
//   - a link's URL "[text](url)" is taken as written, less trailing . , ; : ! ? ' " (round 1);
//   - a line that is "- " and nothing more (white space aside) is not a list item and renders as
//     nothing: it is what the editor's Enter leaves at the end of a list;
//   - text with no marker renders as it did before markers existed (round 1), apart from three URL
//     ends: a "*" or "]" directly after a bare URL is text, and a URL keeps a ")" closing its "(";
//     underline markers in text that has no "__" pair change nothing (round 2 rendering kept);
//     a word like "__init__" or "x__y__z" holds a pair and is now underlined.
// The HTML built here is escape-first: every character of the text is escaped by the caller's
// escaper and the only tags ever produced are <b>, <i>, <u>, <ul>, <li>, <br>, <p> and the caller's own
// link markup. Nothing the text contains can open another tag or attribute.
"use strict";

const MAX_RUN = 3;

// One line (any text; nothing here crosses a line break) as tokens, in order:
//   { type: "text", raw }                  plain text (markers and escapes still in it)
//   { type: "link", raw, text, url }       [text](url); url less trailing . , ; : ! ? ' "
//   { type: "url", raw, url }              a bare URL (raw === url)
//   { type: "image", raw, id }             [image:N], id a number
// Joining every raw gives the line back exactly.
const ATOM_RE = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)|\[image:(\d+)\]|https?:\/\/[^\s<>"']+/g;
const URL_TAIL = /[)\].,;:!?*]$/;
const LINK_TAIL = /[.,;:!?'"]+$/;
// Where a bare URL (as the regular expression found it) ends: at the first ")" that closes no "("
// inside it, then without its trailing punctuation (a ")" kept only when it closes a "(").
function urlEnd(u) {
  for (let i = 0, depth = 0; i < u.length; i++) {
    if (u[i] === "(") depth++;
    else if (u[i] === ")" && !depth--) { u = u.slice(0, i); break; }
  }
  while (URL_TAIL.test(u)) {
    if (u.endsWith(")") && (u.match(/\(/g) || []).length >= (u.match(/\)/g) || []).length) break;
    u = u.slice(0, -1);
  }
  return u;
}
function tokens(line) {
  const s = String(line == null ? "" : line), out = [];
  const text = (raw) => { if (raw) out.push({ type: "text", raw }); };
  const re = new RegExp(ATOM_RE.source, "g");
  let last = 0, m;
  while ((m = re.exec(s)) !== null) {
    let tok;
    if (m[1] !== undefined) tok = { type: "link", raw: m[0], text: m[1], url: m[2].replace(LINK_TAIL, "") };
    else if (m[3] !== undefined) tok = { type: "image", raw: m[0], id: Number(m[3]) };
    else {
      const url = urlEnd(m[0]);
      if (!/^https?:\/\/./.test(url)) continue;
      tok = { type: "url", raw: url, url };
      re.lastIndex = m.index + url.length;
    }
    text(s.slice(last, m.index));
    out.push(tok);
    last = m.index + tok.raw.length;
  }
  text(s.slice(last));
  return out;
}

// One line as units: { c } a character, { lit } an escaped character (or a backslash of an escaping
// run), { star: n } a run of n unescaped asterisks, { us: n, at } a run of n underscores starting at
// offset at of the line, { tok } an atom (a tokens() entry other than text). esc holds the offsets of
// the "__" runs whose backslash run is special (see inline()).
function units(line, esc) {
  const out = [];
  let base = 0;
  const pushText = (s) => {
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "\\") {
        // a run of backslashes: special only directly before an asterisk or an escaping "__"
        let n = 1;
        while (s[i + n] === "\\") n++;
        const star = s[i + n] === "*", us = esc.has(base + i + n);
        const special = star || us;
        for (let k = 0; k < (special ? n >> 1 : n); k++) out.push(special ? { lit: "\\" } : { c: "\\" });
        if (special && n % 2) {
          out.push(...(star ? [{ lit: "*" }] : [{ lit: "_" }, { lit: "_" }]));
          i += n + (us ? 1 : 0);
        } else i += n - 1;
        continue;
      }
      if (ch === "*" || ch === "_") {
        const last = out[out.length - 1], key = ch === "*" ? "star" : "us";
        if (last && last[key] && last.end === base + i) { last[key]++; last.end++; continue; }
        out.push({ [key]: 1, at: base + i, end: base + i + 1 });
        continue;
      }
      out.push({ c: ch });
    }
  };
  for (const tok of tokens(line)) {
    if (tok.type === "text") pushText(tok.raw);
    else out.push({ tok });
    base += tok.raw.length;
  }
  return out;
}

const isSpace = (u) => !u || (u.c !== undefined && /\s/.test(u.c));

const WIDTH = { b: 2, i: 1, u: 2 };

// Pair the marker runs of one line. Each run gets .close (kinds closed, in order), .open (kinds
// opened, in order) and .literal (marker characters shown as text). Kinds: "b" (two stars), "i"
// (one), "u" (exactly two underscores). All kinds share one stack, so they nest in any order and a
// pair that closes makes every opener inside it literal.
function pair(us) {
  const stack = [];   // open entries: { run, kind, ok }
  const open = (run, kind) => { const e = { run, kind, ok: false }; run.open.push(e); stack.push(e); };
  for (let k = 0; k < us.length; k++) {
    const run = us[k];
    if (!run.star && !run.us) continue;
    const n = run.star || run.us;
    run.close = []; run.open = []; run.literal = n;
    if (run.us) {
      if (n !== 2) continue;
      const j = isSpace(us[k - 1]) ? -1 : stack.map((e) => e.kind).lastIndexOf("u");
      if (j >= 0) { stack[j].ok = true; stack.length = j; run.close.push("u"); }
      else if (!isSpace(us[k + 1])) open(run, "u");
      continue;
    }
    if (n > MAX_RUN) continue;
    let rem = n;
    if (!isSpace(us[k - 1])) {
      while (rem > 0 && stack.length) {
        // Three stars close whatever star pair is innermost; two prefer a bold, one wants an italic.
        const want = rem === 3 ? null : rem === 2 && stack.some((e) => e.kind === "b") ? "b" : "i";
        let j = stack.length - 1;
        while (j >= 0 && (stack[j].kind === "u" || (want && stack[j].kind !== want))) j--;
        if (j < 0) break;
        const e = stack[j];
        if (WIDTH[e.kind] > rem) break;
        stack.length = j;          // openers inside the pair never found a partner: literal
        e.ok = true;
        run.close.push(e.kind);
        rem -= WIDTH[e.kind];
      }
    }
    if (rem > 0 && !isSpace(us[k + 1])) for (const kind of rem === 1 ? ["i"] : rem === 2 ? ["b"] : ["b", "i"]) open(run, kind);
  }
  // Settle: literal markers are those neither closing nor in a paired opener.
  for (const u of us) {
    if (!u.close) continue;
    const width = (n, kind) => n + WIDTH[kind];
    u.open = u.open.filter((e) => e.ok).map((e) => e.kind);
    u.literal = (u.star || u.us) - u.close.reduce(width, 0) - u.open.reduce(width, 0);
  }
  return us;
}

// The units of one line, paired. A backslash run directly before "__" is special only when that
// "__" pairs as a marker: the line is first paired with every such backslash read as an ordinary
// character, then again with the escapes of the "__" that paired applied, until no further "__"
// right after a backslash pairs.
function paired(line) {
  const s = String(line == null ? "" : line), esc = new Set();
  for (;;) {
    const us = pair(units(s, esc));
    const more = us.filter((u) => u.us && (u.open.length || u.close.length) && s[u.at - 1] === "\\" && !esc.has(u.at));
    if (!more.length) return us;
    for (const u of more) esc.add(u.at);
  }
}

// One line as HTML. o.esc escapes text; o.atom(token) returns the HTML of a link, URL or image
// token (a tokens() entry; it may throw, as the send path does for an off-allowlist URL); o.tags
// false drops the formatting (plain text out).
function inline(line, o) {
  const tag = (kind, close) => (o.tags === false ? "" : `<${close ? "/" : ""}${kind}>`);
  let out = "", buf = "";
  const flush = () => { out += o.esc(buf); buf = ""; };
  for (const u of paired(line)) {
    if (u.c !== undefined) buf += u.c;
    else if (u.lit !== undefined) buf += u.lit;
    else if (u.tok) { flush(); out += o.atom(u.tok); }
    else {
      flush();
      out += u.close.map((k) => tag(k, true)).join("") + o.esc((u.star ? "*" : "_").repeat(u.literal)) + u.open.map((k) => tag(k, false)).join("");
    }
  }
  flush();
  return out;
}

const LIST_RE = /^- /;
const EMPTY_ITEM = /^- [ \t]*$/;
// The lines of a text, without the empty "- " lines (see the rules above).
const lines = (text) => String(text == null ? "" : text).split(/\r?\n/).filter((l) => !EMPTY_ITEM.test(l));

// Consecutive lines grouped: [{ list: bool, lines: [...] }], list lines without their "- ".
function blocks(ls) {
  const out = [];
  for (const l of ls) {
    const list = LIST_RE.test(l);
    const cur = out[out.length - 1];
    if (cur && cur.list === list) cur.lines.push(list ? l.slice(2) : l);
    else out.push({ list, lines: [list ? l.slice(2) : l] });
  }
  return out;
}

// Email styles for a list, in step with the wrapper div send-guard puts around the body.
const UL_EMAIL = '<ul style="margin:0 0 0 1.5em;padding:0">';
const LI_EMAIL = '<li style="margin:0;padding:0">';

// The body of an outgoing email (send-guard wraps it in its div). Lines are joined with <br> exactly
// as before; a list is a <ul> block with no <br> of its own. A text block that ends on an empty line
// before a list gets one more <br>, because a trailing <br> before a block shows nothing.
function emailHtml(text, o) {
  const bs = blocks(lines(text));
  return bs.map((b, i) => {
    if (b.list) return UL_EMAIL + b.lines.map((l) => LI_EMAIL + inline(l, o) + "</li>").join("\n") + "</ul>";
    const html = b.lines.map((l) => inline(l, o)).join("<br>\n");
    return bs[i + 1] && b.lines[b.lines.length - 1] === "" ? html + "<br>" : html;
  }).join("\n");
}

// The read-only display: paragraphs (a blank line starts one) as <p> keeping single line breaks
// (the stylesheet keeps white space), and a list inside a paragraph as its own <ul>.
function displayHtml(text, o) {
  return lines(text).join("\n").split(/\n[ \t\r]*\n/).filter((p) => p.trim()).map((p) =>
    blocks(lines(p.replace(/^\n+|\s+$/g, ""))).map((b) => b.list
      ? `<ul>${b.lines.map((l) => `<li>${inline(l, o)}</li>`).join("")}</ul>`
      : `<p>${b.lines.map((l) => inline(l, o)).join("\n")}</p>`).join("")).join("");
}

// The text without formatting: markers that pair are removed, escapes resolved, unpaired markers,
// links, URLs, image tokens and list lines ("- item") kept as typed. Line breaks become "\n".
function toPlain(text) {
  const o = { esc: (s) => s, atom: (tok) => tok.raw, tags: false };
  return lines(text).map((l) => (LIST_RE.test(l) ? "- " + inline(l.slice(2), o) : inline(l, o))).join("\n");
}

module.exports = { tokens, inline, emailHtml, displayHtml, toPlain };
