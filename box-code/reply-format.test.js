// reply-format.test.js - the formatting markers of a stored reply (round 2, request 3): the grammar,
// HTML safety for any input, the plain-text strip, the read-only display, and that a reply without
// markers produces exactly the email HTML it produced before (the round 1 toSafeHtml, kept in
// _ref/r1/send-guard.js, when that copy is present). Run: node reply-format.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const F = require("./reply-format.js");
const SG = require("./send-guard.js");
const { replyParas, paras } = require("./views/ui.js");

// The body inside send-guard's wrapper div.
const body = (text) => SG.toSafeHtml(text).replace(/^<div[^>]*>/, "").replace(/<\/div>$/, "");
const UL = '<ul style="margin:0 0 0 1.5em;padding:0">', LI = '<li style="margin:0;padding:0">';

test("bold, italic and both, nested either way", () => {
  assert.strictEqual(body("a **bold** b"), "a <b>bold</b> b");
  assert.strictEqual(body("a *italic* b"), "a <i>italic</i> b");
  assert.strictEqual(body("***both***"), "<b><i>both</i></b>");
  assert.strictEqual(body("**bold *and italic* here**"), "<b>bold <i>and italic</i> here</b>");
  assert.strictEqual(body("*italic **and bold** here*"), "<i>italic <b>and bold</b> here</i>");
  assert.strictEqual(body("in**side**word"), "in<b>side</b>word");
});

test("opening needs a non-space after, closing a non-space before; unmatched stays literal", () => {
  assert.strictEqual(body("5 * 3 = 15 and 2 * 4"), "5 * 3 = 15 and 2 * 4");
  assert.strictEqual(body("a ** b ** c"), "a ** b ** c");
  assert.strictEqual(body("**open only"), "**open only");
  assert.strictEqual(body("close only**"), "close only**");
  assert.strictEqual(body("**a *b**"), "<b>a *b</b>");
  assert.strictEqual(body("*a **b*"), "<i>a **b</i>");
  assert.strictEqual(body("****four****"), "****four****");
  assert.strictEqual(body("*a*b*"), "<i>a</i>b*");
  assert.strictEqual(body("Price* excl. VAT"), "Price* excl. VAT");
});

test("markers stay within one line, LF or CRLF", () => {
  assert.strictEqual(body("**one\ntwo**"), "**one<br>\ntwo**");
  assert.strictEqual(body("**one**\r\n*two*"), "<b>one</b><br>\n<i>two</i>");
});

test("backslashes are special only in a run directly before an asterisk", () => {
  assert.strictEqual(body("\\*not italic\\*"), "*not italic*");
  assert.strictEqual(body("\\***bold**"), "*<b>bold</b>");
  assert.strictEqual(body("\\**it**"), "*<i>it</i>*", "the escaped asterisk is not part of the run");
  assert.strictEqual(body("\\\\*it*"), "\\<i>it</i>");
  // anywhere else a backslash is an ordinary character, single or doubled (round 1)
  assert.strictEqual(body("a\\\\b"), "a\\\\b");
  assert.strictEqual(body("C:\\temp\\x"), "C:\\temp\\x");
  assert.strictEqual(body("UNC \\\\nas\\share"), "UNC \\\\nas\\share");
  // runs of 1 to 4 before an asterisk (here an unpaired one) and before a letter
  assert.deepStrictEqual([1, 2, 3, 4].map((n) => body("x" + "\\".repeat(n) + "* y")), ["x* y", "x\\* y", "x\\* y", "x\\\\* y"]);
  assert.deepStrictEqual([1, 2, 3, 4].map((n) => body("x" + "\\".repeat(n) + "a")), [1, 2, 3, 4].map((n) => "x" + "\\".repeat(n) + "a"));
  // a Windows path ending in an asterisk: plain text reads the backslash as escaping it; the editor
  // stores the backslash doubled and the asterisk escaped, which shows as typed
  assert.strictEqual(body("C:\\dir\\*.txt"), "C:\\dir*.txt");
  assert.strictEqual(body("C:\\dir\\\\\\*.txt"), "C:\\dir\\*.txt");
});

test("a bare URL ends at a ) that closes nothing; a link's URL is taken as written", () => {
  const href = (t) => (body(t).match(/href="([^"]+)"/) || [])[1];
  assert.strictEqual(href("Paren mid (https://www.roverparts.eu/products/abc)and more"), "https://www.roverparts.eu/products/abc");
  assert.strictEqual(href("https://www.roverparts.eu/wiki_(b) ok"), "https://www.roverparts.eu/wiki_(b)");
  assert.strictEqual(href("(https://www.roverparts.eu/wiki_(b))"), "https://www.roverparts.eu/wiki_(b)");
  assert.strictEqual(href("[t](https://www.roverparts.eu/products/abc*) x"), "https://www.roverparts.eu/products/abc*");
  assert.strictEqual(href("[t](https://www.roverparts.eu/products/abc.) x"), "https://www.roverparts.eu/products/abc");
});

test("links, URLs and image tokens keep working, also inside formatting", () => {
  assert.strictEqual(body("**see [STC1234 - Disc](https://www.roverparts.eu/products/stc1234)**"),
    '<b>see <a href="https://www.roverparts.eu/products/stc1234">STC1234 - Disc</a></b>');
  assert.strictEqual(body("*track https://www.roverparts.eu/a*b*c here*"),
    '<i>track <a href="https://www.roverparts.eu/a*b*c">https://www.roverparts.eu/a*b*c</a> here</i>', "markers inside a URL are not read");
  assert.strictEqual(body("[*not italic*](https://www.roverparts.eu/x)"), '<a href="https://www.roverparts.eu/x">*not italic*</a>');
  assert.strictEqual(body("**[image:3]** and *[image:4]*"), "<b>[image:3]</b> and <i>[image:4]</i>");
  assert.throws(() => body("**[x](https://evil.example/pay)**"), /off-allowlist/);
});

test("lists: consecutive '- ' lines, between paragraphs, formatted items", () => {
  assert.strictEqual(body("Parts:\n- STC1234\n- **SFP500010**\nThanks"),
    `Parts:\n${UL}${LI}STC1234</li>\n${LI}<b>SFP500010</b></li></ul>\nThanks`);
  assert.strictEqual(body("Intro\n\n- a\n- b\n\nEnd"), `Intro<br>\n<br>\n${UL}${LI}a</li>\n${LI}b</li></ul>\n<br>\nEnd`);
  assert.strictEqual(body("- only\r\n- items"), `${UL}${LI}only</li>\n${LI}items</li></ul>`);
  assert.strictEqual(body(" - indented\n-no space"), " - indented<br>\n-no space", "only a line starting with hyphen, space");
  assert.strictEqual(body("- a\nb\n- c"), `${UL}${LI}a</li></ul>\nb\n${UL}${LI}c</li></ul>`);
});

test("hostile input: escaped first, only our own tags come out", () => {
  const hostile = [
    "<script>alert(1)</script> **<img src=x onerror=alert(1)>**",
    '*"><svg onload=alert(1)>* \'quoted\' & more',
    "[click](javascript:alert(1)) **[x](javascript:alert(1))**",
    "- <b>not ours</b>\n- *<i>* **</b>**",
    "***a** **b* *c***",
    "**a *b** c* <a href=\"https://www.roverparts.eu\">x</a>",
    "\\<b>\\</b>\\*",
  ];
  for (const t of hostile) {
    const h = body(t);
    const tags = (h.match(/<\/?[a-z][^>]*>/gi) || []).map((x) => x.replace(/\s.*$/, "").replace(/>$/, "").toLowerCase());
    for (const tag of tags) assert.ok(["<b", "</b", "<i", "</i", "<ul", "</ul", "<li", "</li", "<br", "<a", "</a"].includes(tag), `${tag} from ${t}`);
    assert.ok(!/href="javascript/i.test(h), t);
    assert.ok(!/<(script|img|svg)/i.test(h), t);
    // Balanced: every <b>/<i>/<ul>/<li> we open is closed, in order.
    const stack = [];
    for (const m of h.matchAll(/<(\/?)(b|i|ul|li)\b[^>]*>/g)) {
      if (!m[1]) stack.push(m[2]); else assert.strictEqual(stack.pop(), m[2], t);
    }
    assert.deepStrictEqual(stack, [], t);
  }
});

test("strip: the words without the markers, everything else as typed", () => {
  assert.strictEqual(F.toPlain("**Bold** and *it* \\* \\\\ 5 * 3 \\\\*"), "Bold and it * \\\\ 5 * 3 \\*");
  assert.strictEqual(F.toPlain("- **a**\r\n- b\n[**x**](https://www.roverparts.eu/x) [image:2]"), "- a\n- b\n[**x**](https://www.roverparts.eu/x) [image:2]");
  assert.strictEqual(F.toPlain("no markers at all\nsecond line"), "no markers at all\nsecond line");
  assert.strictEqual(F.toPlain(null), "");
});

test("display: the same grammar as the email, as paragraphs and lists, escaped", () => {
  assert.strictEqual(replyParas("Hi **Jan**,\n\nParts:\n- *a*\n- b\nThanks"),
    "<p>Hi <b>Jan</b>,</p><p>Parts:</p><ul><li><i>a</i></li><li>b</li></ul><p>Thanks</p>");
  assert.strictEqual(replyParas("<b>x</b> *y*"), "<p>&lt;b&gt;x&lt;/b&gt; <i>y</i></p>");
  const plain = "Hello,\n\nSee https://www.roverparts.eu/products/x and [STC1 - Disc](https://www.roverparts.eu/p).\nLine two\n\nKind regards,\nTeam";
  assert.strictEqual(replyParas(plain), paras(plain), "a reply without markers displays exactly as before");
});

test("one tokeniser: where a bare URL ends", () => {
  const toks = (t) => F.tokens(t).map((x) => [x.type, x.raw]);
  assert.deepStrictEqual(toks("**see (https://www.roverparts.eu/x)**"), [["text", "**see ("], ["url", "https://www.roverparts.eu/x"], ["text", ")**"]]);
  assert.deepStrictEqual(toks("*our page https://www.roverparts.eu/x's end*"), [["text", "*our page "], ["url", "https://www.roverparts.eu/x"], ["text", "'s end*"]]);
  assert.deepStrictEqual(toks("(*https://www.roverparts.eu/a*)"), [["text", "(*"], ["url", "https://www.roverparts.eu/a"], ["text", "*)"]]);
  assert.deepStrictEqual(toks("https://www.roverparts.eu/wiki_(b)."), [["url", "https://www.roverparts.eu/wiki_(b)"], ["text", "."]], "a ( in the URL keeps its )");
  assert.deepStrictEqual(toks('[https://www.roverparts.eu/x]; "https://www.roverparts.eu/y"!?'),
    [["text", "["], ["url", "https://www.roverparts.eu/x"], ["text", ']; "'], ["url", "https://www.roverparts.eu/y"], ["text", '"!?']]);
  assert.deepStrictEqual(toks("https://www.roverparts.eu/a*b*c, [STC1 - Disc](https://www.roverparts.eu/p). [image:7]"),
    [["url", "https://www.roverparts.eu/a*b*c"], ["text", ", "], ["link", "[STC1 - Disc](https://www.roverparts.eu/p)"], ["text", ". "], ["image", "[image:7]"]]);
  assert.deepStrictEqual(F.tokens("[x](https://www.roverparts.eu/p.)")[0], { type: "link", raw: "[x](https://www.roverparts.eu/p.)", text: "x", url: "https://www.roverparts.eu/p" });
  assert.deepStrictEqual(F.tokens("[image:12]")[0], { type: "image", raw: "[image:12]", id: 12 });
  assert.deepStrictEqual(toks("https:// nothing"), [["text", "https:// nothing"]]);
  for (const t of ["a (https://www.roverparts.eu/x) b", "**x** [y](https://a.nl) https://b.nl/c). [image:2]"]) assert.strictEqual(F.tokens(t).map((x) => x.raw).join(""), t);
});

test("the three reported cases render the same in the email and on screen", () => {
  const a = '<a href="https://www.roverparts.eu/x">https://www.roverparts.eu/x</a>';
  const shown = '<a href="https://www.roverparts.eu/x" target="_blank" rel="noopener noreferrer" title="https://www.roverparts.eu/x">https://www.roverparts.eu/x</a>';
  assert.strictEqual(body("**see (https://www.roverparts.eu/x)**"), `<b>see (${a})</b>`);
  assert.strictEqual(replyParas("**see (https://www.roverparts.eu/x)**"), `<p><b>see (${shown})</b></p>`);
  assert.strictEqual(body("*our page https://www.roverparts.eu/x's end*"), `<i>our page ${a}&#39;s end</i>`);
  assert.strictEqual(replyParas("*our page https://www.roverparts.eu/x's end*"), `<p><i>our page ${shown}'s end</i></p>`);
  assert.strictEqual(body("(*https://www.roverparts.eu/x*)"), `(<i>${a}</i>)`);
  assert.strictEqual(replyParas("(*https://www.roverparts.eu/x*)"), `<p>(<i>${shown}</i>)</p>`);
});

test("an empty trailing bullet is nothing, in the email and on screen", () => {
  const UL1 = `${UL}${LI}one</li></ul>`;
  assert.strictEqual(body("Intro\n- one\n- "), `Intro\n${UL1}`);
  assert.strictEqual(body("Intro\r\n- one\r\n-  \t"), `Intro\n${UL1}`);
  assert.strictEqual(replyParas("Intro\n- one\n- "), "<p>Intro</p><ul><li>one</li></ul>");
  assert.strictEqual(body("a\n- \nb"), "a<br>\nb");
  assert.strictEqual(F.toPlain("- one\n- "), "- one");
  assert.strictEqual(body("-  x"), `${UL}${LI} x</li></ul>`, "an item with text after the space is still an item");
});

test("text without markers gives exactly the round 1 email HTML", () => {
  const r1 = path.join(__dirname, "..", "_ref", "r1", "send-guard.js");
  if (!fs.existsSync(r1)) return;   // the reference copy lives beside the repo, not on the box
  const OLD = require(r1);
  const samples = [
    "Hallo Jan,\n\nDe STC1234 is op voorraad: [STC1234 - Remschijf](https://www.roverparts.eu/products/stc1234).\n\nMet vriendelijke groet,\nTeam Budget Parts",
    "Hi,\r\n\r\nTracking: https://www.postnl.nl/track?b=3S123, see you.\r\nKind regards,\r\nTeam Budget Parts",
    "Line with <angle> & \"quotes\" and 'apostrophes'\n\n\nthree blank lines above\n",
    "Photo below:\n[image:12]\n\nPrice 2-3 weeks - 45,00 EUR excl. VAT (5 x 9)",
    "A hyphen line\n -not a list\n--- \nend",
    "",
  ];
  for (const s of samples) assert.strictEqual(SG.toSafeHtml(s), OLD.toSafeHtml(s), JSON.stringify(s));
  // Where the round 1 URL end was itself wrong, and only there, the output changes.
  const A = (u) => `<a href="${u}">${u}</a>`;
  const changed = [
    ["link https://www.roverparts.eu/a* end", `link ${A("https://www.roverparts.eu/a")}* end`],        // r1 linked the "*"
    ["https://www.roverparts.eu/wiki_(b) ok", `${A("https://www.roverparts.eu/wiki_(b)")} ok`],        // r1 cut the URL before ")"
    ["[https://www.roverparts.eu/x] ok", `[${A("https://www.roverparts.eu/x")}] ok`],                  // r1 linked the "]"
  ];
  for (const [s, want] of changed) {
    assert.notStrictEqual(OLD.toSafeHtml(s), SG.toSafeHtml(s), s);
    assert.strictEqual(body(s), want, s);
  }
});
