// reply-format.js - the formatting markers of a stored reply (round 2, request 3). ONE grammar, used
// by the send path (send-guard toSafeHtml), the read-only displays (views/ui.js replyParas), plain
// text consumers (exemplars, reply translation, the search index) and the rich editor (phase 3).
//
// The stored reply stays plain text. Markers:
//   **bold**        bold
//   *italic*        italic
//   ***both***      bold and italic; bold may contain italic and italic may contain bold:
//                   "**a *b* c**" and "*a **b** c*"
//   - item          a line starting with "- " (hyphen, space, at the very start of the line) is a
//                   bulleted list item; consecutive such lines form one list. The item text may carry
//                   bold and italic. Nested lists do not exist.
//   \* and \\*      backslashes are special only in a run that stands directly before an asterisk:
//                   in such a run each pair "\\" is one literal backslash and a final single "\"
//                   makes the asterisk literal ("\*" shows "*", "\\*x*" shows "\" then italic x,
//                   "\\\*" shows "\*"). Every other backslash, single or doubled, is an ordinary
//                   character ("\\nas\share" shows as typed), so text without an asterisk is never
//                   changed by a backslash. A Windows path ending in an asterisk is therefore read
//                   as escaping it ("C:\dir\*.txt" shows "C:\dir*.txt"); typed in the editor it
//                   is stored "C:\dir\\\*.txt" and shows as typed.
// Rules:
//   - markers apply within one line, never across a line break (CRLF and LF are both line breaks);
//   - an opening marker must be followed by a non-space and a closing marker preceded by a non-space,
//     so "5 * 3 = 15" and "a ** b" stay literal;
//   - a run of more than three asterisks is literal; a marker that finds no partner stays literal
//     text ("**a" shows "**a"; "**a *b**" is bold "a *b", the unpaired "*" literal);
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
//     ends: a "*" or "]" directly after a bare URL is text, and a URL keeps a ")" closing its "(".
// The HTML built here is escape-first: every character of the text is escaped by the caller's
// escaper and the only tags ever produced are <b>, <i>, <ul>, <li>, <br>, <p> and the caller's own
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
// run), { star: n } a run of n
// unescaped asterisks, { tok } an atom (a tokens() entry other than text).
function units(line) {
  const out = [];
  const pushText = (s) => {
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "\\") {
        // a run of backslashes: special only directly before an asterisk (see the rules above)
        let n = 1;
        while (s[i + n] === "\\") n++;
        const star = s[i + n] === "*";
        for (let k = 0; k < (star ? n >> 1 : n); k++) out.push(star ? { lit: "\\" } : { c: "\\" });
        if (star && n % 2) { out.push({ lit: "*" }); i += n; }
        else i += n - 1;
        continue;
      }
      if (ch === "*") {
        const last = out[out.length - 1];
        if (last && last.star) { last.star++; continue; }
        out.push({ star: 1 });
        continue;
      }
      out.push({ c: ch });
    }
  };
  for (const tok of tokens(line)) {
    if (tok.type === "text") pushText(tok.raw);
    else out.push({ tok });
  }
  return out;
}

const isSpace = (u) => !u || (u.c !== undefined && /\s/.test(u.c));

// Pair the asterisk runs of one line. Each run gets .close (kinds closed, in order), .open (kinds
// opened, in order) and .literal (asterisks shown as text). Kinds: "b" (two stars), "i" (one).
function pair(us) {
  const stack = [];   // open entries: { run, kind, ok }
  for (let k = 0; k < us.length; k++) {
    const run = us[k];
    if (!run.star) continue;
    run.close = []; run.open = []; run.literal = run.star;
    if (run.star > MAX_RUN) continue;
    let rem = run.star;
    if (!isSpace(us[k - 1])) {
      while (rem > 0 && stack.length) {
        // Three stars close whatever is innermost; two prefer a bold, one wants an italic.
        let j = stack.length - 1;
        if (rem < 3) {
          const want = rem === 2 && stack.some((e) => e.kind === "b") ? "b" : "i";
          while (j >= 0 && stack[j].kind !== want) j--;
        }
        if (j < 0) break;
        const e = stack[j];
        const need = e.kind === "b" ? 2 : 1;
        if (need > rem) break;
        stack.length = j;          // openers inside the pair never found a partner: literal
        e.ok = true;
        run.close.push(e.kind);
        rem -= need;
      }
    }
    if (rem > 0 && !isSpace(us[k + 1])) {
      for (const kind of rem === 1 ? ["i"] : rem === 2 ? ["b"] : ["b", "i"]) {
        const e = { run, kind, ok: false };
        run.open.push(e);
        stack.push(e);
      }
    }
  }
  // Settle: literal asterisks are those neither closing nor in a paired opener.
  for (const u of us) {
    if (!u.star || !u.close) continue;
    const used = u.close.reduce((n, kind) => n + (kind === "b" ? 2 : 1), 0)
      + u.open.filter((e) => e.ok).reduce((n, e) => n + (e.kind === "b" ? 2 : 1), 0);
    u.literal = u.star - used;
    u.open = u.open.filter((e) => e.ok).map((e) => e.kind);
  }
  return us;
}

// One line as HTML. o.esc escapes text; o.atom(token) returns the HTML of a link, URL or image
// token (a tokens() entry; it may throw, as the send path does for an off-allowlist URL); o.tags
// false drops the formatting (plain text out).
function inline(line, o) {
  const tag = (kind, close) => (o.tags === false ? "" : `<${close ? "/" : ""}${kind}>`);
  let out = "", buf = "";
  const flush = () => { out += o.esc(buf); buf = ""; };
  for (const u of pair(units(line))) {
    if (u.c !== undefined) buf += u.c;
    else if (u.lit !== undefined) buf += u.lit;
    else if (u.tok) { flush(); out += o.atom(u.tok); }
    else {
      flush();
      out += u.close.map((k) => tag(k, true)).join("") + o.esc("*".repeat(u.literal)) + u.open.map((k) => tag(k, false)).join("");
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
