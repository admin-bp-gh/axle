/* assets/axle-editor.js: the reply editor (round 2, request 3). Plain JavaScript, no library, no build.
   The stored reply stays plain text with the markers of reply-format.js (**bold**, *italic*, "- "
   list lines, \* and \\ for a literal asterisk or backslash). The editor shows that text as rich text
   in a contenteditable box and writes it back as text on every input, into the hidden reply field
   that autosave, the phone's draft protection and Send read.
     1. The model, pure (plain node loads this part for the tests: axle-editor.test.js): a reply is
        lines, each { list, runs: [{ t, b, i }] }. parse() reads stored text with the grammar itself
        (reply-format.js inline, never a copy of it); serialise() writes the markers back and proves
        each line by reading it again; toHtml() is the editor's DOM as markup (the server renders the
        first view with it, so the page opens already formatted).
     2. The DOM, in the browser: the editor's DOM is held to div lines, ul > li list lines, b, i and
        br. readDom() reads any DOM (strong, em, bold or italic spans, p and nested blocks, foreign
        markup unwrapped to its text); a DOM holding anything else is rebuilt from what it reads,
        lazily (on input, never while a composition is open). Bold, italic and the list are
        document.execCommand, the one route that works the same in Chromium, Safari and iOS Safari and
        keeps undo and redo; paste and drop insert plain text through insertText for the same reason.
   Browser surface: window.AxleEditor.mount(element, field) -> { setText, insert, focus, caret,
   setCaret }; axle.js keeps the one adapter (section 8, replyEd). */
(function (root, make) {
  if (typeof module === "object" && module.exports) module.exports = make(require("../reply-format.js"));
  else root.AxleEditor = make(root.AxleFormat.exports);
})(typeof self !== "undefined" ? self : this, (FMT) => {
  "use strict";

  /* ---------- 1. The model ---------- */
  const LIST = /^- /;
  const WS = /\s/;
  const enc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const dec = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const MARK = { b: "**", i: "*" };

  function push(runs, t, b, i) {
    if (!t) return;
    const last = runs[runs.length - 1];
    if (last && last.b === b && last.i === i) last.t += t;
    else runs.push({ t, b, i });
  }

  // One line (without its "- ") as runs, read by reply-format.js: its HTML, escaped by enc, split at
  // the only tags it makes.
  function runsOf(line) {
    const runs = [];
    let b = 0, i = 0;
    for (const part of FMT.inline(line, { esc: enc, atom: (t) => enc(t.raw) }).split(/(<\/?[bi]>)/)) {
      if (part === "<b>") b++;
      else if (part === "</b>") b--;
      else if (part === "<i>") i++;
      else if (part === "</i>") i--;
      else push(runs, dec(part), b > 0, i > 0);
    }
    return runs;
  }

  const parse = (text) => String(text == null ? "" : text).split(/\r?\n/)
    .map((l) => (LIST.test(l) ? { list: true, runs: runsOf(l.slice(2)) } : { list: false, runs: runsOf(l) }));

  // A line's characters (UTF-16 units, as the DOM counts them), each with its formatting.
  const chars = (runs) => runs.flatMap((r) => r.t.split("").map((c) => ({ c, b: r.b, i: r.i })));
  // Equal characters, and equal formatting wherever it shows (formatting on white space never does).
  const same = (a, z) => a.length === z.length && a.every((x, p) => x.c === z[p].c && (WS.test(x.c) || (x.b === z[p].b && x.i === z[p].i)));
  const merge = (cs) => cs.reduce((runs, x) => { push(runs, x.c, x.b, x.i); return runs; }, []);

  // The stretches of one kind of formatting: [{ k, p, q }] (characters p to q - 1).
  function stretches(cs) {
    const out = [];
    for (const k of ["b", "i"]) {
      for (let p = 0; p < cs.length;) {
        if (!cs[p][k]) { p++; continue; }
        let q = p;
        while (q < cs.length && cs[q][k]) q++;
        out.push({ k, p, q });
        p = q;
      }
    }
    return out;
  }

  // The grammar needs a non-space just inside every marker, so a stretch never starts or ends on
  // white space: bolding " word " stores " **word** ", and a stretch of spaces only is plain.
  function trim(cs) {
    for (const s of stretches(cs)) {
      let a = s.p, z = s.q;
      while (a < z && WS.test(cs[a].c)) cs[a++][s.k] = false;
      while (z > a && WS.test(cs[z - 1].c)) cs[--z][s.k] = false;
    }
    return cs;
  }

  // The characters of a link, URL or image token (reply-format.js tokens, the one tokeniser): the
  // grammar reads no marker or escape inside one, so they are written as they are.
  function atomMask(cs) {
    const mask = [];
    for (const t of FMT.tokens(cs.map((x) => x.c).join(""))) for (let k = 0; k < t.raw.length; k++) mask.push(t.type !== "text");
    return mask;
  }

  // The stored text of one line's characters. Markers: bold and italic opening together open as
  // "***", which the grammar reads as bold outside italic; at a change the stretches that end close
  // innermost first, and one that must close only because an inner one ends opens again before its
  // next non-space character (across white space that is always possible). gaps: everything open
  // also closes before each white space and opens again after it, which expresses a crossing at a
  // word gap ("*c* ***d*e**"). Literal
  // asterisks, a run of them at a time: as typed with white space or the line's edge on both sides
  // (the grammar never reads a marker there: "5 * 3"); escaped "\*" next to a marker or a backslash;
  // otherwise as typed when raw names it (rawSets in lineText: "Price* excl." stays as typed).
  // A literal backslash is doubled only in a run of them that stands directly before an asterisk
  // (a marker or an escaped literal one): elsewhere the grammar reads backslashes as typed.
  function emit(cs, atoms, raw, gaps) {
    const runs = [];
    cs.forEach((x, p) => {
      const f = (x.b ? "b" : "") + (x.i ? "i" : ""), r = runs[runs.length - 1];
      if (r && r.f === f) r.end = p + 1;
      else runs.push({ f, start: p, end: p + 1 });
    });
    const STAR = {}, BS = {};
    const parts = [], stack = [];
    let pending = [];
    runs.forEach((run) => {
      const at = stack.findIndex((k) => !run.f.includes(k));
      if (at >= 0) {
        const shut = stack.splice(at).reverse().filter((k) => (pending.includes(k) ? (pending = pending.filter((x) => x !== k), false) : true));
        parts.push(shut.map((k) => MARK[k]).join(""));
      }
      const open = ["b", "i"].filter((k) => run.f.includes(k) && !stack.includes(k));
      stack.push(...open);
      pending.push(...open);
      for (let p = run.start; p < run.end; p++) {
        const c = cs[p].c;
        if (gaps && WS.test(c) && stack.length > pending.length) {
          parts.push(stack.slice(0, stack.length - pending.length).reverse().map((k) => MARK[k]).join(""));
          pending = [...stack];
        }
        if (pending.length && !WS.test(c)) {
          const order = ["b", "i"].filter((k) => pending.includes(k));   // as the grammar reads "***"
          stack.splice(stack.length - pending.length, pending.length, ...order);
          parts.push(order.map((k) => MARK[k]).join(""));
          pending = [];
        }
        parts.push(atoms[p] ? { a: c } : c === "*" ? STAR : c === "\\" ? BS : c);
      }
    });
    parts.push(stack.filter((k) => !pending.includes(k)).reverse().map((k) => MARK[k]).join(""));
    const flat = parts.filter((x) => x !== "");
    const groups = [];
    for (let n = 0; n < flat.length; n++) {
      if (flat[n] !== STAR) continue;
      let z = n;
      while (flat[z] === STAR) z++;
      // a neighbour: a marker (a string of stars), a literal backslash, an atom's character or text
      const near = (x) => (x === undefined ? "" : x === BS ? "\\" : x.a !== undefined ? x.a : x);
      const before = near(flat[n - 1]), after = near(flat[z]);
      const ws = (c) => !c || WS.test(c);
      const mark = (x) => x === BS || (typeof x === "string" && /^\*+$/.test(x));
      groups.push({ n, z, loose: ws(before.slice(-1)) && ws(after[0]), marker: mark(flat[n - 1]) || mark(flat[z]) });
      n = z;
    }
    const free = groups.filter((g) => !g.loose && !g.marker);
    for (const g of groups) {
      const keep = g.loose || raw.has(free.indexOf(g));
      for (let k = g.n; k < g.z; k++) flat[k] = keep ? "*" : "\\*";
    }
    let out = "";
    for (let n = flat.length - 1; n >= 0; n--) out = (flat[n] === BS ? (/^\\*\*/.test(out) ? "\\\\" : "\\") : flat[n].a ?? flat[n]) + out;
    return { out, free: free.length };
  }

  // The runs of free asterisks (see emit) to try writing as typed, in order of preference: the one
  // run when there is one ("Price* excl."), else none ("\*lit\*"), then the fewest that work.
  function rawSets(n) {
    const sets = n === 1 ? [new Set([0]), new Set()] : [new Set()];
    if (n > 1 && n <= 6) for (let size = 1; size <= n; size++) for (let mask = 1; mask < 1 << n; mask++) {
      const set = new Set([...Array(n).keys()].filter((k) => mask & (1 << k)));
      if (set.size === size) sets.push(set);
    }
    return sets;
  }

  // One line's characters as stored text, proven: the text is read back by the grammar and must give
  // the same characters and the same formatting wherever it shows. Formatting the grammar cannot
  // hold (a bold that starts inside an italic word) is dropped one stretch at a time, nearest the
  // first difference, so the text never shows a stray marker.
  function lineText(cs) {
    trim(cs);
    const atoms = atomMask(cs);
    for (let guard = 0; ; guard++) {
      for (const gaps of [false, true]) {
        for (const raw of rawSets(emit(cs, atoms, new Set(), gaps).free)) {
          const { out } = emit(cs, atoms, raw, gaps);
          if (same(chars(runsOf(out)), cs)) return out;
        }
      }
      const all = stretches(cs), got = chars(runsOf(emit(cs, atoms, new Set(), false).out));
      if (!all.length || guard > 64) return emit(cs, atoms, new Set(), false).out;
      let m = 0;
      while (m < cs.length && m < got.length && same([cs[m]], [got[m]])) m++;
      const s = all.filter((x) => x.p <= m).sort((x, y) => y.p - x.p)[0] || all[0];
      for (let p = s.p; p < s.q; p++) cs[p][s.k] = false;
    }
  }

  const serialise = (lines) => lines.map((l) => (l.list ? "- " : "") + lineText(chars(l.runs))).join("\n");

  // The model as it shows: formatting on white space dropped (it never shows, and no marker can start
  // or end on it), runs merged. Two models that normalise alike look alike and store alike.
  const normalise = (lines) => lines.map((l) => ({ list: l.list, runs: merge(chars(l.runs).map((x) => (WS.test(x.c) ? { c: x.c, b: false, i: false } : x))) }));

  // The editor's DOM: a div per line, a ul of li for consecutive list lines, b around i, an empty
  // line holding a br (so it has a height and takes the caret).
  function lineHtml(runs) {
    let out = "";
    for (let n = 0; n < runs.length;) {
      const b = runs[n].b;
      let inner = "";
      for (; n < runs.length && runs[n].b === b; n++) inner += runs[n].i ? `<i>${enc(runs[n].t)}</i>` : enc(runs[n].t);
      out += b ? `<b>${inner}</b>` : inner;
    }
    return out || "<br>";
  }
  function toHtml(lines) {
    let out = "", ul = false;
    for (const l of lines) {
      if (l.list !== ul) { out += ul ? "</ul>" : "<ul>"; ul = l.list; }
      out += l.list ? `<li>${lineHtml(l.runs)}</li>` : `<div>${lineHtml(l.runs)}</div>`;
    }
    return out + (ul ? "</ul>" : "");
  }

  const api = { parse, serialise, normalise, toHtml, runsOf };
  if (typeof document === "undefined") return api;

  /* ---------- 2. The DOM ---------- */
  const D = document;
  const BLOCK = /^(DIV|P|LI|UL|OL|H[1-6]|BLOCKQUOTE|PRE|TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|SECTION|ARTICLE|HEADER|FOOTER|ASIDE|NAV|FIGURE|FIGCAPTION|ADDRESS|DL|DT|DD|HR)$/;
  const SKIP = /^(SCRIPT|STYLE|TEMPLATE|IMG|PICTURE|VIDEO|AUDIO|IFRAME|OBJECT|EMBED|SVG|CANVAS|INPUT|TEXTAREA|SELECT|BUTTON|META|LINK|TITLE|HEAD)$/;

  // A br that only ends its block (the last thing in it, or right before a block) makes no line.
  function filler(br, root) {
    for (let x = br; x !== root; x = x.parentNode) {
      for (let s = x.nextSibling; s; s = s.nextSibling) {
        if (s.nodeType === 3) { if (s.data.length) return false; continue; }
        if (s.nodeType !== 1 || SKIP.test(s.tagName)) continue;
        if (BLOCK.test(s.tagName)) return true;
        if (s.tagName === "BR" || s.textContent.length || s.querySelector("br")) return false;
      }
      if (x.parentNode === root || BLOCK.test(x.parentNode.tagName)) return true;
    }
    return true;
  }

  // Any DOM as lines. sel { node, offset }: the caret, returned as { line, at } (characters into
  // that line). Formatting: b, strong and a bold span; i, em and an italic span. Every other element
  // gives its text; images, scripts, styles and form controls give nothing.
  function readDom(root, sel) {
    const lines = [];
    let cur = null, fresh = false, caret = null;
    const line = (list) => { cur = { list, runs: [] }; lines.push(cur); fresh = true; };
    const len = () => (cur ? cur.runs.reduce((n, r) => n + r.t.length, 0) : 0);
    const mark = () => { if (!caret) caret = cur ? { line: lines.length - 1, at: len() } : { line: lines.length, at: 0 }; };
    function text(node, f) {
      let off = 0;
      node.data.replace(/ /g, " ").split("\n").forEach((s, n) => {   // pre-wrap: a line feed in a text node breaks the line
        if (n) line(f.list);
        if (sel && sel.node === node && !caret && sel.offset >= off && sel.offset <= off + s.length) {
          if (!cur) line(f.list);
          caret = { line: lines.length - 1, at: len() + sel.offset - off };
        }
        if (s) { if (!cur) line(f.list); push(cur.runs, s, f.b, f.i); fresh = false; }
        off += s.length + 1;
      });
    }
    function walk(node, f) {
      const kids = [...node.childNodes];
      for (let k = 0; k <= kids.length; k++) {
        if (sel && sel.node === node && sel.offset === k) mark();
        const n = kids[k];
        if (!n) break;
        if (n.nodeType === 3) { text(n, f); continue; }
        if (n.nodeType !== 1 || SKIP.test(n.tagName)) continue;
        const tag = n.tagName, st = n.style || {};
        if (tag === "BR") {
          if (!filler(n, root)) { if (!cur) line(f.list); line(f.list); }
          continue;
        }
        const g = {
          b: f.b || tag === "B" || tag === "STRONG" || /^(bold|bolder|[6-9]00)$/.test(st.fontWeight || ""),
          i: f.i || tag === "I" || tag === "EM" || st.fontStyle === "italic",
          list: f.list || tag === "LI",
        };
        if (!BLOCK.test(tag)) { walk(n, g); continue; }
        if (tag === "UL" || tag === "OL") { if (!fresh) cur = null; }   // a list inside a fresh line (Chromium) is that line
        else if (!cur || !fresh) line(g.list);
        else cur.list = g.list;
        walk(n, g);
        cur = null;
      }
    }
    walk(root, { b: false, i: false, list: false });
    if (!lines.length) lines.push({ list: false, runs: [] });
    // A line that starts "- " is a list item when stored, so it is one here too (a paste of a list).
    for (const l of lines) {
      if (l.list || !LIST.test(l.runs.map((r) => r.t).join(""))) continue;
      l.list = true;
      for (let cut = 2; cut;) { const r = l.runs[0], n = Math.min(cut, r.t.length); r.t = r.t.slice(n); cut -= n; if (!r.t) l.runs.shift(); }
    }
    return { lines, caret };
  }

  // The DOM is the editor's own set: div and ul lines straight in the editor (Chromium's commands go
  // wrong on text loose in it, which it leaves after everything was deleted), or a ul inside such a
  // div (where Chromium's list command puts it); li in a ul, b, i and br inside them; no attributes;
  // no div line starting "- " (a list item, see readDom). Anything else is rebuilt.
  const OWN = /^(DIV|UL|LI|B|I|BR)$/;
  const clean = (root) => [...root.childNodes].every((n) => n.nodeType === 1 && (n.tagName === "DIV" || n.tagName === "UL"))
    && [...root.querySelectorAll("*")].every((n) => OWN.test(n.tagName) && !n.attributes.length
      && (n.tagName === "UL" ? n.parentNode === root || (n.parentNode.tagName === "DIV" && n.parentNode.parentNode === root)
        : n.tagName === "LI" ? n.parentNode.tagName === "UL" : n.tagName !== "DIV" || !LIST.test(n.textContent)));

  // The caret at { line, at } in a DOM toHtml made.
  function setCaret(root, c) {
    const els = root.querySelectorAll(":scope > div, :scope > ul > li");
    const el = els[Math.min(c.line, els.length - 1)];
    if (!el) return;
    let at = c.line >= els.length ? Infinity : c.at, node, last = null;
    const w = D.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while ((node = w.nextNode())) { if (at <= node.data.length) break; at -= node.data.length; last = node; }
    const r = D.createRange();
    if (node) r.setStart(node, at);
    else if (last) r.setStart(last, last.data.length);
    else r.setStart(el, 0);
    r.collapse(true);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  const selIn = (el) => { const s = getSelection(); return s.rangeCount && el.contains(s.focusNode) ? s : null; };
  const caretPoint = (x, y) => {
    if (D.caretRangeFromPoint) return D.caretRangeFromPoint(x, y);
    const p = D.caretPositionFromPoint && D.caretPositionFromPoint(x, y);
    if (!p) return null;
    const r = D.createRange();
    r.setStart(p.offsetNode, p.offset);
    return r;
  };

  // The caret stays in sight above the sticky dock or phone bar (and above the iOS keyboard, which
  // the visual viewport leaves out) when typing at the end of a long reply.
  function keepVisible() {
    const s = getSelection();
    if (!s.rangeCount) return;
    let r = s.getRangeAt(0).getBoundingClientRect();
    if (!r.height) { const n = s.focusNode; r = (n.nodeType === 1 ? n : n.parentElement).getBoundingClientRect(); }
    const vv = window.visualViewport;
    let limit = vv ? vv.offsetTop + vv.height : innerHeight;
    for (const b of D.querySelectorAll(".ax-email .wb-bar, .ax-email .ax-dockwrap")) {
      const top = b.getBoundingClientRect().top;
      if (b.offsetParent && top < limit && top > r.top) limit = top;
    }
    if (r.bottom > limit - 12) scrollBy(0, r.bottom - limit + 12);
  }

  const EDITORS = new Set();
  D.addEventListener("selectionchange", () => EDITORS.forEach((ed) => ed.selected()));

  function mount(el, field) {
    if (el.axEd) return el.axEd;
    try { D.execCommand("defaultParagraphSeparator", false, "div"); D.execCommand("styleWithCSS", false, false); } catch (e) { /* older engines: their defaults */ }
    const bar = el.parentElement.querySelector("[data-fmt]") ? el.parentElement : null;
    let saved = null, busy = false, fromHere = false, composing = false, check = 0;

    const empty = () => el.toggleAttribute("data-empty", field.value === "");
    // The model back into the hidden field; its own input event reaches autosave, the draft
    // protection and Reset to draft exactly as the old text area's did.
    function sync() {
      const text = serialise(readDom(el).lines);
      if (text === field.value) return;
      field.value = text;
      empty();
      field.dispatchEvent(new Event("input", { bubbles: true }));
    }
    // The DOM again from lines (the caret kept by its text offset): from what it reads (foreign
    // markup), or from the stored text (formatting the grammar cannot hold).
    function rebuild(lines) {
      const s = selIn(el);
      const got = readDom(el, s ? { node: s.focusNode, offset: s.focusOffset } : null);
      el.innerHTML = toHtml(lines || got.lines);
      if (s && got.caret) setCaret(el, got.caret);
    }
    // What the editor shows must be what the stored text renders. The only formatting serialise
    // cannot store is italic that goes on while bold starts or ends inside the same word ("a" italic,
    // "b" bold italic, no space between): the grammar has no way to write it. Shortly after the last
    // input (never during a composition) the editor is compared with the stored text read back, and
    // where they differ it is redrawn from the stored text, so that formatting goes at once rather
    // than at send.
    function verify() {
      check = 0;
      if (composing || !el.isConnected) return;
      const want = parse(field.value);
      if (JSON.stringify(normalise(readDom(el).lines)) === JSON.stringify(normalise(want))) return;
      rebuild(want);
      pressed();
    }
    function pressed() {
      if (!bar) return;
      const on = !!selIn(el);
      for (const b of bar.querySelectorAll("[data-fmt]")) {
        let st = false;
        try { st = on && D.queryCommandState(b.dataset.fmt === "list" ? "insertUnorderedList" : b.dataset.fmt); } catch (e) { /* not supported */ }
        b.setAttribute("aria-pressed", String(st));
      }
    }
    // The selection as it was in the editor, put back before a toolbar button or an insert acts.
    function restore() {
      if (selIn(el)) return;
      el.focus({ preventScroll: true });
      const s = getSelection();
      if (saved && el.contains(saved.startContainer)) { s.removeAllRanges(); s.addRange(saved); }
      else setCaret(el, { line: Infinity, at: Infinity });
    }
    function format(cmd) {
      if (el.contentEditable !== "true") return;
      restore();
      D.execCommand(cmd === "list" ? "insertUnorderedList" : cmd, false, null);
      pressed();
    }
    // A line typed as "- " becomes a list item (it would be one when stored anyway): the line turns
    // into a list item first, then the two characters go (two undo steps).
    function autoList(e) {
      if (e.inputType !== "insertText" || e.data !== " ") return;
      const s = selIn(el);
      if (!s || !s.isCollapsed || s.focusNode.nodeType !== 3 || s.focusOffset !== 2) return;
      const node = s.focusNode, blk = node.parentNode;
      if (node.previousSibling || node.data.replace(/\u00a0/g, " ").slice(0, 2) !== "- " || blk.tagName !== "DIV" || blk.parentNode !== el) return;
      D.execCommand("insertUnorderedList", false, null);
      const t = selIn(el), li = t && (t.focusNode.nodeType === 1 ? t.focusNode : t.focusNode.parentElement).closest("li");
      const first = li && D.createTreeWalker(li, NodeFilter.SHOW_TEXT).nextNode();
      if (!first || first.data.replace(/\u00a0/g, " ").slice(0, 2) !== "- ") return;
      const r = D.createRange();
      r.setStart(first, 0);
      r.setEnd(first, 2);
      t.removeAllRanges();
      t.addRange(r);
      D.execCommand("delete", false, null);
    }
    function changed(e) {
      if (busy) return;
      busy = true;
      try {
        if (!e.isComposing) { autoList(e); if (!clean(el)) rebuild(); }
        sync();
      } finally { busy = false; }
      clearTimeout(check);
      check = setTimeout(verify, 250);
      if (D.activeElement === el) keepVisible();
      pressed();
    }

    el.addEventListener("input", changed);
    el.addEventListener("compositionstart", () => { composing = true; });
    el.addEventListener("compositionend", () => { composing = false; changed({}); });
    el.addEventListener("keydown", (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return;
      const k = e.key.toLowerCase();
      if (k === "b" || k === "i") { e.preventDefault(); format(k === "b" ? "bold" : "italic"); }
      else if (k === "u") e.preventDefault();   // underline cannot be stored
    });
    // Paste is plain text. A paste with no text (an image) is left to the reply's file path (axle.js).
    el.addEventListener("paste", (e) => {
      const text = e.clipboardData && e.clipboardData.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      D.execCommand("insertText", false, text.replace(/\r\n?/g, "\n"));
    });
    // A drop from elsewhere is plain text at the drop point; a move inside the editor stays the
    // browser's; files go to the reply's file path.
    el.addEventListener("dragstart", () => { fromHere = true; });
    el.addEventListener("dragend", () => { fromHere = false; });
    el.addEventListener("drop", (e) => {
      if (fromHere || [...(e.dataTransfer.types || [])].includes("Files")) return;
      const text = e.dataTransfer.getData("text/plain");
      if (!text) return;
      e.preventDefault();
      const r = caretPoint(e.clientX, e.clientY);
      el.focus({ preventScroll: true });
      if (r && el.contains(r.startContainer)) { const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
      D.execCommand("insertText", false, text.replace(/\r\n?/g, "\n"));
    });
    if (bar) {
      // The toolbar keeps the focus and the selection in the editor (no blur, so the iOS keyboard stays).
      bar.addEventListener("mousedown", (e) => { if (e.target.closest("[data-fmt]")) e.preventDefault(); });
      bar.addEventListener("click", (e) => { const b = e.target.closest("[data-fmt]"); if (b) format(b.dataset.fmt); });
    }
    if (field.disabled || field.readOnly) el.contentEditable = "false";
    empty();

    const ed = {
      el,
      selected() {
        if (!el.isConnected) { EDITORS.delete(ed); return; }
        const s = selIn(el);
        if (s) saved = s.getRangeAt(0).cloneRange();
        pressed();
      },
      // Replace the whole text (Reset to draft, a restored draft, a carried edit): no input event.
      setText(text) { el.innerHTML = toHtml(parse(text)); saved = null; },
      // Text at the caret (or where it last was), as typing: one undo step, then the input path.
      insert(text) { restore(); D.execCommand("insertText", false, text); },
      focus() { restore(); },
      caret() { const s = selIn(el); return s ? readDom(el, { node: s.focusNode, offset: s.focusOffset }).caret : null; },
      setCaret(c) { el.focus({ preventScroll: true }); setCaret(el, c); },
    };
    EDITORS.add(ed);
    el.axEd = ed;
    return ed;
  }

  return Object.assign(api, { mount, readDom, clean });
});
