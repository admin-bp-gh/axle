// axle-editor.test.js - the reply editor's model (assets/axle-editor.js, round 2 request 3): stored
// text to lines of formatted runs and back. (a) canonical text survives parse and serialise exactly,
// any other text renders the same afterwards; (b) every model the toolbar and typing make survives
// serialise and parse; (c) literal asterisks and backslashes; (d) formatting moves off white space;
// (e) markers never span a line; (f) empty formatting writes nothing; (g) image tokens and links
// untouched; (h) lists; underline (round 3) with the same guarantees, three flags. Then the cross-check: what the editor shows equals what the read-only
// display (reply-format.js displayHtml) shows for the same text. Run: node axle-editor.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const E = require("./assets/axle-editor.js");
const F = require("./reply-format.js");
const SG = require("./send-guard.js");
const { replyParas, esc } = require("./views/ui.js");

const round = (t) => E.serialise(E.parse(t));
const line = (list, ...runs) => ({ list, runs: runs.map(([t, f = ""]) => ({ t, b: f.includes("b"), i: f.includes("i"), u: f.includes("u") })) });
const back = (m) => E.normalise(E.parse(E.serialise(m)));
// A seeded generator (mulberry32), so every run draws the same models.
const prng = (seed) => (n) => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n; };

test("(a) canonical text survives parse and serialise exactly", () => {
  for (const t of [
    "", "Hello", "Beste Anna,\n\nDank voor je bericht.\n\nMet vriendelijke groet,\nTeam Budget Parts",
    "a **bold** b", "a *italic* b", "***both***", "**bold *and italic* here**", "*italic **and bold** here*",
    "in**side**word", "**ab***cd*", "5 * 3 = 15", "a ** b ** c", "Price* excl. VAT", "a*b", "\\*lit\\* and a\\b",
    "\\***x**", "**x\\\\**", "a\\b and c\\", "- one\n- **two**\n- \n\nAfter", "line\n\n\n",
    "[image:12] and [SEE123 - Remklauw](https://www.roverparts.eu/products/see123)", "https://www.roverparts.eu/a*b*c",
    "**see [our page](https://www.roverparts.eu/x)**", "Ünïcödé **vét** 😀 *ok*",
  ]) assert.strictEqual(round(t), t, JSON.stringify(t));
});

test("(a) any other text renders the same after parse and serialise", () => {
  for (const t of [
    "**open only", "close only**", "****four****", "*a*b*", "a*b*c", "\\\\*", "2 * 3*4", "**a *b**", "*a **b*",
    "\\x \\\\ \\", "**one\ntwo**", "a\r\nb", "**bold **", "** bold**", "- **x\n-x", "***a** b*",
  ]) {
    const s = round(t);
    assert.strictEqual(replyParas(s), replyParas(t), `display ${JSON.stringify(t)} -> ${JSON.stringify(s)}`);
    assert.strictEqual(SG.toSafeHtml(s), SG.toSafeHtml(t.replace(/\r\n/g, "\n")), `email ${JSON.stringify(t)} -> ${JSON.stringify(s)}`);
    assert.strictEqual(round(s), s, `stable ${JSON.stringify(s)}`);
  }
});

test("(b) what the toolbar and typing make survives serialise and parse", () => {
  const models = [
    [line(false, ["Hello "], ["world", "b"], ["!"])],
    [line(false, ["a "], ["b ", "i"], ["c", "bi"], [" d", "i"])],
    [line(false, ["bold", "b"], ["text"])],
    [line(false, ["ab", "b"], ["cd", "i"])],
    [line(false, ["a ", "b"], ["b", "bi"], [" c", "i"])],            // crossing at a word gap
    [line(false, ["5 * 3 = 15 and a\\b"])],
    [line(false, ["*", ""], ["x", "b"]), line(false, ["x\\", "b"])],
    [line(true, ["one"]), line(true, ["two", "b"]), line(true), line(false), line(false, ["end", "i"])],
    [line(false, ["see ", ""], ["[image:7]", "b"], [" and "], ["[the part](https://www.roverparts.eu/p)", "i"])],
  ];
  for (const m of models) assert.deepStrictEqual(back(m), E.normalise(m), E.serialise(m));
  // Random models whose formatting changes only at word gaps (as selecting words and toggling makes),
  // words drawn from letters, asterisks, backslashes, hyphens and digits.
  const rnd = prng(7);
  const ALPH = "ab*\\-1 xy*", FL = ["", "b", "i", "bi"];
  for (let k = 0; k < 3000; k++) {
    const lines = [];
    for (let l = 0, nl = 1 + rnd(3); l < nl; l++) {
      const runs = [];
      for (let w = 0, nw = rnd(5); w < nw; w++) {
        let word = "";
        for (let c = 0, nc = 1 + rnd(4); c < nc; c++) word += ALPH[rnd(ALPH.length - 1)];
        runs.push([word, FL[rnd(4)]]);
        if (w < nw - 1) runs.push([" ".repeat(1 + rnd(2)), FL[rnd(4)]]);
      }
      const list = !!rnd(2);
      if (!list && runs.length && /^- /.test(runs.map((r) => r[0]).join(""))) runs.unshift(["x"]);   // the editor shows such a line as a list item (readDom)
      lines.push(line(list, ...runs));
    }
    assert.deepStrictEqual(back(lines), E.normalise(lines), E.serialise(lines));
  }
});

test("(b) any formatting at all: the text is kept and no marker ever shows", () => {
  const rnd = prng(11);
  let kept = 0;
  for (let k = 0; k < 3000; k++) {
    const runs = [];
    for (let r = 0, n = 1 + rnd(6); r < n; r++) runs.push([["a", "b ", "*", "\\", "x*y", " "][rnd(6)], ["", "b", "i", "bi"][rnd(4)]]);
    const m = [line(false, ...runs)];
    const got = back(m), want = E.normalise(m);
    assert.strictEqual(got[0].runs.map((r) => r.t).join(""), want[0].runs.map((r) => r.t).join(""), E.serialise(m));
    if (JSON.stringify(got) === JSON.stringify(want)) kept++;
  }
  assert.ok(kept > 2000, `formatting kept in ${kept} of 3000`);
});

test("(c) a literal asterisk or backslash is escaped where the grammar needs it", () => {
  assert.strictEqual(E.serialise([line(false, ["*", ""], ["bold", "b"])]), "\\***bold**");
  assert.strictEqual(E.serialise([line(false, ["a*b"])]), "a*b");
  assert.strictEqual(E.serialise([line(false, ["a*b*c"])]), "a\\*b\\*c");
  assert.strictEqual(E.serialise([line(false, ["*", ""], ["i", "i"])]), "\\**i*");
  assert.strictEqual(E.serialise([line(false, ["*lit*"])]), "\\*lit\\*");
  assert.strictEqual(E.serialise([line(false, ["5 * 3"])]), "5 * 3");
  assert.strictEqual(E.serialise([line(false, ["end\\", "b"])]), "**end\\\\**");
  assert.strictEqual(E.serialise([line(false, ["a\\*b"])]), "a\\\\\\*b");
  assert.strictEqual(E.serialise([line(false, ["a\\b"])]), "a\\b");
});

test("(c) backslashes: ordinary except in a run directly before an asterisk", () => {
  for (const t of ["UNC \\\\nas\\share", "C:\\Windows\\System32", "a\\b and c\\\\d"]) {
    assert.strictEqual(round(t), t, JSON.stringify(t));
    assert.deepStrictEqual(E.parse(t)[0].runs, [{ t, b: false, i: false, u: false }]);
  }
  // a path ending in an asterisk, typed: the backslash doubled, the asterisk escaped, and back
  const typed = (t) => E.serialise([line(false, [t])]);
  assert.strictEqual(typed("C:\\dir\\*"), "C:\\dir\\\\\\*");
  assert.strictEqual(typed("C:\\dir\\*.txt"), "C:\\dir\\\\\\*.txt");
  for (const t of ["C:\\dir\\*", "C:\\dir\\*.txt"]) assert.deepStrictEqual(back([line(false, [t])]), E.normalise([line(false, [t])]));
  // runs of 1 to 4 literal backslashes before an asterisk and before a letter, typed and stored
  for (let n = 1; n <= 4; n++) {
    for (const after of ["*", "*x", "a"]) {
      const m = [line(false, ["x" + "\\".repeat(n) + after])];
      assert.deepStrictEqual(back(m), E.normalise(m), JSON.stringify(E.serialise(m)));
    }
    assert.strictEqual(typed("x" + "\\".repeat(n) + "a"), "x" + "\\".repeat(n) + "a", "before a letter nothing is doubled");
  }
});

test("underline: canonical text survives, the model with three flags survives", () => {
  for (const t of ["a __u__ b", "__a **b** c__", "**a __b__ c**", "*a __b__*", "__***all***__", "LR_012345 foto_1.jpg", "a__b and ___ and __",
    "x\\__y__z__", "__a \\__b__", "\\\\__a__", "__[image:3]__ and __[x](https://www.roverparts.eu/x)__", "- __one__\n- two"]) assert.strictEqual(round(t), t, JSON.stringify(t));
  assert.strictEqual(E.serialise([line(false, ["say"], [" word ", "u"], ["now"])]), "say __word__ now");
  assert.strictEqual(E.serialise([line(false, ["a", "u"], ["b", "bu"], ["c", "b"])]), "__a**b**__**c**");
  assert.strictEqual(E.serialise([line(false, ["one", "u"]), line(false, ["two", "u"])]), "__one__\n__two__");
  assert.strictEqual(E.serialise([line(false, ["a__b", "u"])]), "__a\\__b__", "a literal __ inside an underline is escaped");
  assert.strictEqual(E.serialise([line(false, ["a\\", "u"])]), "__a\\\\__", "a backslash before the closing __ is doubled");
  assert.strictEqual(E.serialise([line(false, ["C:\\__temp"])]), "C:\\__temp", "nothing pairs, nothing escaped");
  // underline against a literal underscore cannot be written: the underline goes, the text stays
  assert.deepStrictEqual(back([line(false, ["foo", "u"], ["_bar"])]), [line(false, ["foo_bar"])]);
  // random models changing formatting at word gaps (selecting words and toggling), three flags
  const rnd = prng(31);
  const ALPH = "ab*\\_-1 x_", FL = ["", "b", "i", "bi", "u", "bu", "iu", "biu"];
  for (let k = 0; k < 4000; k++) {
    const lines = [];
    for (let l = 0, nl = 1 + rnd(3); l < nl; l++) {
      const runs = [];
      for (let w = 0, nw = rnd(5); w < nw; w++) {
        let word = "";
        for (let c = 0, nc = 1 + rnd(4); c < nc; c++) word += ALPH[rnd(ALPH.length - 1)];
        runs.push([word, FL[rnd(FL.length)]]);
        if (w < nw - 1) runs.push([" ".repeat(1 + rnd(2)), FL[rnd(FL.length)]]);
      }
      const list = !!rnd(2);
      if (!list && runs.length && /^- /.test(runs.map((r) => r[0]).join(""))) runs.unshift(["x"]);
      lines.push(line(list, ...runs));
    }
    // a word holding an underscore is not underlined (a "__" next to it would join its underscores)
    const m = lines.map((l) => ({ list: l.list, runs: l.runs.map((r) => (/_/.test(r.t) ? { ...r, u: false } : r)) }));
    assert.deepStrictEqual(back(m), E.normalise(m), E.serialise(m));
  }
});

test("(d) bolding ' word ' with spaces around moves the spaces outside the markers", () => {
  assert.strictEqual(E.serialise([line(false, ["say"], [" word ", "b"], ["now"])]), "say **word** now");
  assert.strictEqual(E.serialise([line(false, ["  x  ", "i"])]), "  *x*  ");
});

test("(e) formatting across several lines is one marked run per line", () => {
  assert.strictEqual(E.serialise([line(false, ["one", "b"]), line(false, ["two", "b"])]), "**one**\n**two**");
  assert.strictEqual(E.serialise([line(true, ["a", "i"]), line(true, ["b", "i"])]), "- *a*\n- *b*");
});

test("(f) empty or blank formatting writes no markers", () => {
  assert.strictEqual(E.serialise([line(false, ["a"], ["", "b"], ["b"])]), "ab");
  assert.strictEqual(E.serialise([line(false, ["a"], ["   ", "bi"], ["b"])]), "a   b");
  assert.strictEqual(E.serialise([line(false, ["", "b"])]), "");
});

test("(g) image tokens and links are plain text and survive untouched", () => {
  const t = "Foto: [image:41] en [SEE123 - Remklauw](https://www.roverparts.eu/products/see123?x=*1*) of https://www.roverparts.eu/a\\*b";
  assert.strictEqual(round(t), t);
  assert.deepStrictEqual(E.parse(t)[0].runs, [{ t, b: false, i: false, u: false }]);
  assert.strictEqual(E.serialise([line(false, ["[image:3]", "b"])]), "**[image:3]**");
  assert.strictEqual(E.serialise([line(false, ["https://www.roverparts.eu/a*b", ""])]), "https://www.roverparts.eu/a*b");
});

test("(h) lists: consecutive '- ' lines, empty items, no nesting", () => {
  const m = E.parse("- a\n- \n- *c*\nplain\n- d");
  assert.deepStrictEqual(m.map((l) => l.list), [true, true, true, false, true]);
  assert.strictEqual(E.toHtml(m), "<ul><li>a</li><li><br></li><li><i>c</i></li></ul><div>plain</div><ul><li>d</li></ul>");
  assert.strictEqual(E.serialise(m), "- a\n- \n- *c*\nplain\n- d");
  assert.deepStrictEqual(E.parse("  - not a list").map((l) => l.list), [false]);
});

// What the editor shows (toHtml) against what the read-only display shows (displayHtml), line by
// line, as characters with their formatting: the same words, the same bold, italic and underline,
// the same list lines. Links stay their text on both sides (the display's anchors are compared as typed).
function shown(html, kind) {
  const out = [];
  let cur = null, b = 0, i = 0, u = 0, list = false;
  const start = () => { cur = { list, cs: [] }; out.push(cur); };
  for (const tok of html.match(/<[^>]+>|[^<]+/g) || []) {
    if (tok === "<b>") b++; else if (tok === "</b>") b--; else if (tok === "<i>") i++; else if (tok === "</i>") i--;
    else if (tok === "<u>") u++; else if (tok === "</u>") u--;
    else if (tok === "<ul>") list = true; else if (tok === "</ul>") list = false;
    else if (tok === "<div>" || tok === "<li>" || tok === "<p>") start();
    else if (tok[0] !== "<") {
      const text = tok.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
      text.split("\n").forEach((s, n) => { if (n || !cur) start(); for (const c of s) cur.cs.push(/\s/.test(c) ? c : c + (b ? "B" : "") + (i ? "I" : "") + (u ? "U" : "")); });
    }
  }
  for (const l of out) while (l.cs.length && /^\s$/.test(l.cs[l.cs.length - 1])) l.cs.pop();
  return out.filter((l) => l.cs.length).map((l) => (l.list ? "- " : "") + l.cs.join("|"));
}
test("cross-check: the editor shows what reply-format.js displays", () => {
  const disp = (t) => F.displayHtml(t, { esc, atom: (t) => esc(t.raw) });
  for (const t of [
    "Beste Anna,\n\n**Dit is vet** en *dit cursief*, met **vet en *cursief* samen**:\n- [SEE123 - Remklauw](https://www.roverparts.eu/products/see123)\n- *tweede regel*\n\nFoto: [image:4]\n\nPrijs 5 * 3 = 15 en een \\*sterretje\\*.\n\nMet vriendelijke groet,\nTeam Budget Parts",
    "in**side**word and ***all***", "**a *b**", "*a*b*", "\\\\* and \\x", "- a\n- **b *c***\ntext\n- d",
    "<script>alert(1)</script> **&amp;**", "https://www.roverparts.eu/a**b**c", "**open\nclose**",
    "**see (https://www.roverparts.eu/x)**", "*our page https://www.roverparts.eu/x's end*", "(*https://www.roverparts.eu/a*)",
    "Graag __vóór vrijdag__ betalen, **__LR_012345__** en *__foto_1.jpg__*", "__a **b *c* d** e__ x__y__z __init__",
    "C:\\__temp and \\__a__ and __a \\__b__", "___x___ a__ b __c", "__https://www.roverparts.eu/a__b__ x__",
  ]) assert.deepStrictEqual(shown(E.toHtml(E.parse(t))), shown(disp(t)), JSON.stringify(t));
});

// The invariant the editor keeps (round 2 fix): what it shows equals what the stored text renders.
// Random models, character by character, from letters, white space, hyphens, asterisks,
// backslashes, an emoji, links, URLs and image tokens, each piece with any formatting, as plain and
// list lines. The editor shows normalise(model) until its check redraws it from parse(serialise(
// model)); the display of the stored text must equal that redrawn view, always, and the model
// itself whenever it holds nothing the grammar cannot write (inexpressible below; and a plain line
// starting "- ", which the editor shows as a list item anyway).
const disp = (t) => F.displayHtml(t, { esc, atom: (tok) => esc(tok.raw) });
// What the grammar cannot write: italic going on while bold starts or ends inside a word; formatting
// changing next to a literal underscore while underline is on ("__foo___bar" is a run of three, text,
// and an underline closes and opens again where bold or italic inside it ends); formatting
// that changes inside a link, URL or image token of the line's text (a URL runs on to the next white
// space, so "*https://x.nl/p*bc" is all URL); formatting that changes right after a bare URL
// where what follows would join the URL; and an underline ending at a bare URL.
function inexpressible(m) {
  for (const l of m) {
    const cs = l.runs.flatMap((r) => r.t.split("").map((c) => ({ c, f: /\s/.test(c) ? "" : (r.b ? "b" : "") + (r.i ? "i" : "") + (r.u ? "u" : "") })));
    const raw = l.runs.flatMap((r) => r.t.split("").map(() => (r.b ? "b" : "") + (r.i ? "i" : "") + (r.u ? "u" : "")));
    const bi = (x) => x.f.replace("u", "");
    for (let k = 1; k < cs.length; k++) if (bi(cs[k - 1]) && bi(cs[k]) && [bi(cs[k - 1]), bi(cs[k])].sort().join() === "bi,i") return true;
    // a "__" marker lands wherever formatting changes while underline is on at one side
    const f = (k) => (k >= 0 && k < cs.length ? cs[k].f : "");
    for (let k = 0; k <= cs.length; k++) if (f(k) !== f(k - 1) && (f(k) + f(k - 1)).includes("u") && ((cs[k] && cs[k].c === "_") || (cs[k - 1] && cs[k - 1].c === "_"))) return true;
    let at = 0;
    for (const t of F.tokens(cs.map((x) => x.c).join(""))) {
      if (t.type !== "text" && new Set(cs.slice(at, at + t.raw.length).map((x) => x.f)).size > 1) return true;
      at += t.raw.length;
      // a marker right after a bare URL is part of the URL unless the next character is one the URL
      // gives back ( ) ] . , ; : ! ? ); a literal "*" needs "\*", and the backslash is URL too
      if (t.type !== "url") continue;
      let z = at;
      while (z < cs.length && !/\s/.test(cs[z].c)) z++;
      const rest = cs.slice(at, z);
      if (rest.some((x) => x.f !== cs[at - 1].f) && rest.some((x) => !/[)\].,;:!?]/.test(x.c))) return true;
      if ((cs[at - 1].f || rest.some((x) => x.f)) && rest.some((x) => x.c === "*" || x.c === "\\")) return true;
      // underline on at a URL's end (or on what follows it up to the next word) while any formatting
      // changes there, white space included: a marker closes right after the URL, and "__" is not
      // given back
      let y = z;
      while (y < cs.length && /\s/.test(cs[y].c)) y++;
      const fs = raw.slice(at - 1, y + 1);
      if (y >= cs.length) fs.push("");
      if (fs.some((f) => f.includes("u")) && new Set(fs).size > 1) return true;
    }
  }
  return false;
}
test("invariant: what the editor shows is what the stored text renders", () => {
  const rnd = prng(23);
  const PIECES = ["a", "bc", " ", "  ", "-", "*", "\\", "😀", "x-y", "[image:3]", "https://www.roverparts.eu/p", "[part](https://www.roverparts.eu/q)", "(", ")",
    "_", "__", "LR_01", "a__b"], FL = ["", "b", "i", "bi", "u", "bu", "iu", "biu"];
  let models = 0, exact = 0, redrawn = 0;
  for (let k = 0; k < 12000; k++) {
    const m = [];
    for (let l = 0, nl = 1 + rnd(3); l < nl; l++) {
      const runs = [];
      for (let r = 0, n = rnd(7); r < n; r++) { const f = FL[rnd(FL.length)]; runs.push({ t: PIECES[rnd(PIECES.length)], b: f.includes("b"), i: f.includes("i"), u: f.includes("u") }); }
      m.push({ list: !!rnd(2), runs });
    }
    const stored = E.serialise(m), view = E.parse(stored);
    models++;
    assert.deepStrictEqual(shown(disp(stored)), shown(E.toHtml(E.normalise(view))), `display of ${JSON.stringify(stored)} against the redrawn editor`);
    assert.strictEqual(E.serialise(view), stored, `parse(stored) serialises back: ${JSON.stringify(stored)}`);
    const dashLine = m.some((l) => !l.list && /^- /.test(l.runs.map((r) => r.t).join("")));
    if (JSON.stringify(E.normalise(view)) === JSON.stringify(E.normalise(m))) exact++;
    else { redrawn++; assert.ok(inexpressible(m) || dashLine, `formatting dropped without a reason: ${JSON.stringify(m)} -> ${JSON.stringify(stored)}`); }
  }
  console.log(`# invariant: ${models} models, ${exact} kept exactly, ${redrawn} redrawn (each an intraword italic crossing, underline against a literal underscore, formatting changing inside a link or URL, or a plain "- " line)`);
});
