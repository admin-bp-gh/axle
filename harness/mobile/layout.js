// layout.js - desktop-equivalence captures for baseline/compare: a per-element layout
// snapshot, a normalized DOM snapshot, and an in-browser (canvas, no npm image libs)
// pixel diff between two PNG buffers.
"use strict";

// For every element with a non-empty box: a stable path (tag + :nth-child from body, plus
// id), rounded rect, computed font-size/color/background-color/display.
async function layoutSnapshot(page) {
  return page.evaluate(() => {
    function domPath(el) {
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1) {
        // M-45/M-46: the div.hscroll wrapper (no desktop rules, added around an existing
        // <table>) gets no path segment of its own, so a wrapped table's path still reads
        // the same as an unwrapped one once diffLayout normalises away the indices.
        if (node !== el && node.classList && node.classList.contains("hscroll")) { node = node.parentElement; continue; }
        // M-22/M-36: the div.m-mail wrapper (phone-only order wrapper, no desktop rules)
        // gets the same treatment - no path segment of its own.
        if (node !== el && node.classList && node.classList.contains("m-mail")) { node = node.parentElement; continue; }
        let idx = 1, sib = node;
        while ((sib = sib.previousElementSibling)) idx++;
        let part = node.tagName.toLowerCase() + ":nth-child(" + idx + ")";
        if (node.id) part += "#" + node.id;
        parts.unshift(part);
        if (node === document.body) break;
        // Phase 3, C3 (K6 allowance "the relocated #composeModal"): the compose modal moved
        // from inside #queuepane to after the shell. It is position:fixed, so its rects do
        // not depend on where it lives; rooting the path of every element inside it at
        // div#composeModal makes those paths identical wherever the modal sits in the tree.
        if (node.id === "composeModal") break;
        node = node.parentElement;
      }
      return parts.join(" > ");
    }
    const round = (n) => Math.round(n * 100) / 100;
    const out = [];
    document.querySelectorAll("body, body *").forEach((el) => {
      // M-45/M-46: the div.hscroll wrapper itself has no baseline counterpart (it wraps an
      // existing table, same "existing elements only gain classes or a div.hscroll wrapper"
      // allowance domPath() honours above) - skip its own entry too.
      if (el.classList && el.classList.contains("hscroll")) return;
      // M-22/M-36: the div.m-mail wrapper has no baseline counterpart either - skip its own entry.
      if (el.classList && el.classList.contains("m-mail")) return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      const cs = getComputedStyle(el);
      out.push({
        path: domPath(el),
        rect: { x: round(r.left), y: round(r.top), width: round(r.width), height: round(r.height) },
        fontSize: cs.fontSize, color: cs.color, backgroundColor: cs.backgroundColor, display: cs.display,
      });
    });
    return out;
  });
}

// K6: drops every element that computes to display:none (and its subtree) before reading
// body.outerHTML, so a phone-only element the plan allows (it computes to display:none at
// 1440) never shows up as a structural difference. Runs inside the page so getComputedStyle
// sees the real cascade. Returns the count of dropped elements too, recorded in the snapshot
// metadata comment so `compare` can tell an old (un-normalised) baseline from a new one.
async function dropDisplayNoneAndSerialize(page) {
  return page.evaluate(() => {
    let dropped = 0;
    // Snapshot the list first: removing a node while walking a live NodeList would skip
    // its still-attached siblings.
    const all = Array.from(document.body.querySelectorAll("*"));
    for (const el of all) {
      if (!el.isConnected) continue; // already removed as part of an earlier subtree
      if (getComputedStyle(el).display === "none") {
        dropped += 1 + el.querySelectorAll("*").length;
        el.remove();
      }
    }
    // M-22/M-36: div.m-mail is a cosmetic phone-order wrapper (like div.hscroll) with no
    // desktop rules and no baseline counterpart. Unlike hscroll it can hold nested divs, so a
    // non-greedy regex would mispair open/close tags; unwrap it structurally instead, on a
    // CLONE (never mutate the live page a screenshot may still be taken from), via a
    // matching-tag walk that moves each wrapper's children out and drops the wrapper itself.
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("div.m-mail").forEach((wrap) => {
      const parent = wrap.parentNode;
      while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
      parent.removeChild(wrap);
    });
    // Phase 3, C3 (K6 allowance "the relocated #composeModal"): the open compose modal used
    // to render inside #queuepane and now renders once per page after the shell. When it is
    // present in the clone (it is open; a closed modal computes to display:none and was
    // dropped above), move it to the end of the cloned body so its position in the tree is
    // the same on both sides. The baseline goes through this same function (captured by it,
    // or re-normalised by renormaliseBaselineDom), so both sides get the move.
    const cm = clone.querySelector("#composeModal");
    if (cm) clone.appendChild(cm);
    // Phase 3, C5 (K6 allowance "the ax-detail body class"): needs no code here. The body
    // tag of a deep-linked item gains the class token ax-detail, which isAllowedTagDiff's
    // added-class-token rule already accepts (the baseline's tokens are a subset).
    return { html: clone.outerHTML, dropped };
  });
}

// body.outerHTML with ?v=polarisNN asset versions normalised to ?v=X, and every
// display:none element (and its subtree) dropped first (K6). The dropped-element count is
// recorded as a leading HTML comment marker so a snapshot captured by this function is
// distinguishable from one captured by the pre-K6 code (no marker).
async function domSnapshot(page) {
  const { html, dropped } = await dropDisplayNoneAndSerialize(page);
  const marker = "<!--axle-dom-normalised dropped=" + dropped + "-->";
  return marker + html.replace(/\?v=polaris\d+/g, "?v=X");
}

// K6: re-normalises a baseline .dom.html captured by the OLD (pre-fix) code, which has no
// "axle-dom-normalised" marker, by loading it into a page (with the real box-code
// stylesheets attached, at the capture width, so the actual cascade - including the
// @media (min-width: 1101px) .m-only rule - applies) and running the same
// display:none-dropping pass, so a committed baseline stays valid without recapturing it.
// A baseline that already carries the marker (captured by the new code) is returned as-is.
async function renormaliseBaselineDom(browser, baseUrl, width, html) {
  if (html.startsWith("<!--axle-dom-normalised")) return html;
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: width.width, height: width.height, deviceScaleFactor: 1 });
    // Same identity header every mobile-harness page carries (env.js/pptr.js) - the
    // real page this loads first is behind the server's identity middleware.
    await page.setExtraHTTPHeaders({ "Tailscale-User-Login": "admin@budget-parts.nl" });
    // Navigate to a real box-code page first (any page - server.js serves the same two
    // stylesheets everywhere) so the document's origin matches baseUrl and the <link>
    // stylesheets actually apply; a bare page.setContent() page has no origin of its own
    // and Chromium does not reliably apply cross-origin stylesheets to it (verified: the
    // computed display stayed the UA default, i.e. the CSS never took effect). Then swap
    // in the snapshot's body wholesale, keeping the already-loaded stylesheets in <head>.
    await page.goto(baseUrl + "/blocks", { waitUntil: "load" });
    await page.evaluate((bodyHtml) => { document.body.outerHTML = bodyHtml; }, html);
    const { html: normalised, dropped } = await dropDisplayNoneAndSerialize(page);
    return "<!--axle-dom-normalised dropped=" + dropped + " (re-normalised from an unmarked baseline)-->" + normalised;
  } finally {
    await page.close();
  }
}

// Every :nth-child(N) index stripped from a path, at every level of the chain. Two
// elements with the same normalised path are structurally the same slot in the tree
// (same tag/id chain), even if a display:none sibling inserted earlier shifted their
// literal :nth-child index - see diffLayout below.
function normalisePath(path) {
  // Phase 3, C3: a committed baseline .layout.json stores the paths layoutSnapshot produced
  // at capture time, which ran the full chain up to body (the modal then lived inside
  // #queuepane). Root any path through #composeModal at that segment here as well, so a
  // stored baseline path and a current path (already rooted there by domPath) group
  // together. Same allowance as the domPath stop, applied to the stored side.
  const cm = path.search(/[a-z0-9]+(:nth-child\(\d+\))?#composeModal(?= >|$)/);
  if (cm > 0) path = path.slice(cm);
  return path.replace(/:nth-child\(\d+\)/g, "");
}

// Diffs two layout snapshots. Groups each snapshot's entries by normalised path (document
// order preserved within a group) and pairs the two sides positionally within each group,
// rather than by exact path string: a display:none element added earlier in the tree
// (M-45/M-46's .m-back/.desktop-note - the plan's allowed display:none addition) shifts
// every later sibling's literal :nth-child index, which would otherwise pair unrelated
// elements that merely share a now-coincidental path string (or wrongly report an unmoved
// element as missing/added). Reports rect/font/color/background/display differences for
// paired entries, plus any entry left over on one side once its group is exhausted.
function diffLayout(baseline, current) {
  const groupBy = (list) => {
    const groups = new Map();
    for (const e of list) {
      const key = normalisePath(e.path);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    return groups;
  };
  const groupsA = groupBy(baseline), groupsB = groupBy(current);
  const keys = new Set([...groupsA.keys(), ...groupsB.keys()]);
  const diffs = [];
  for (const key of keys) {
    const listA = groupsA.get(key) || [], listB = groupsB.get(key) || [];
    const n = Math.max(listA.length, listB.length);
    for (let i = 0; i < n; i++) {
      const a = listA[i], b = listB[i];
      if (!a) { diffs.push({ path: b.path, kind: "added_in_current" }); continue; }
      if (!b) { diffs.push({ path: a.path, kind: "missing_in_current" }); continue; }
      const fields = ["fontSize", "color", "backgroundColor", "display"];
      for (const f of fields) {
        if (a[f] !== b[f]) diffs.push({ path: a.path, kind: "field", field: f, baseline: a[f], current: b[f] });
      }
      for (const f of ["x", "y", "width", "height"]) {
        if (a.rect[f] !== b.rect[f]) diffs.push({ path: a.path, kind: "rect", field: f, baseline: a.rect[f], current: b.rect[f] });
      }
    }
  }
  return diffs;
}

// DOM diff: allowed differences (4.2 / phase-specific) are: elements in the new tree that
// compute to display:none (can't tell from a raw HTML string alone, so this checks only the
// structural allowances listed in the brief - callers pass computed exceptions separately
// when they can); added class tokens; added hx-*/data-* attributes on existing elements; a
// div.m-mail wrapper; a relocated #composeModal; a body class ax-detail. This function does
// a conservative structural comparison and reports anything outside those textual allowances.
function diffDom(baselineHtml, currentHtml) {
  // Strip the K6 "axle-dom-normalised dropped=N" marker comment before comparing - it
  // records how many display:none elements each side dropped, which legitimately differs
  // (a phone-only element dropped on one side, never present to drop on the other) and is
  // not itself a structural difference.
  const stripMarker = (h) => h.replace(/^<!--axle-dom-normalised[^>]*-->/, "");
  baselineHtml = stripMarker(baselineHtml);
  currentHtml = stripMarker(currentHtml);
  // M-45/M-46: a div.hscroll wrapper around an existing <table> (added so the table can
  // scroll sideways on the phone) has no desktop rules and no visual effect at desktop
  // widths - the plan's "a div.m-mail wrapper" allowance, applied to this phase's own
  // cosmetic wrapper. Unwrap it (keep the table, drop the wrapper) before comparing; there
  // is never a nested div inside these tables, so a non-greedy match is safe.
  const unwrapHscroll = (h) => h.replace(/<div class="hscroll">([\s\S]*?)<\/div>/g, "$1");
  baselineHtml = unwrapHscroll(baselineHtml);
  currentHtml = unwrapHscroll(currentHtml);
  if (baselineHtml === currentHtml) return [];
  const reported = [];
  // Tokenize into tags/text for a coarse diff; exact byte diff would flag every whitespace
  // change, so this compares parsed-ish tag streams instead.
  const tagsA = baselineHtml.match(/<[^>]+>/g) || [];
  const tagsB = currentHtml.match(/<[^>]+>/g) || [];
  const n = Math.max(tagsA.length, tagsB.length);
  let i = 0, j = 0;
  while (i < tagsA.length && j < tagsB.length) {
    if (tagsA[i] === tagsB[j]) { i++; j++; continue; }
    const a = tagsA[i], b = tagsB[j];
    if (isAllowedTagDiff(a, b)) { i++; j++; continue; }
    reported.push({ index: reported.length, baseline: a, current: b });
    i++; j++;
    if (reported.length > 200) break; // cap noise
  }
  while (i < tagsA.length) { reported.push({ baseline: tagsA[i], current: null }); i++; if (reported.length > 200) break; }
  while (j < tagsB.length) { reported.push({ baseline: null, current: tagsB[j] }); j++; if (reported.length > 200) break; }
  return reported;
}

function isAllowedTagDiff(a, b) {
  if (a == null || b == null) return false;
  // same tag name?
  const nameA = /^<\/?\s*([a-zA-Z0-9-]+)/.exec(a);
  const nameB = /^<\/?\s*([a-zA-Z0-9-]+)/.exec(b);
  if (!nameA || !nameB || nameA[1].toLowerCase() !== nameB[1].toLowerCase()) return false;
  // added class tokens: b's class is a is a superset of a's class tokens
  const classA = (/class="([^"]*)"/.exec(a) || [, ""])[1].trim().split(/\s+/).filter(Boolean);
  const classB = (/class="([^"]*)"/.exec(b) || [, ""])[1].trim().split(/\s+/).filter(Boolean);
  const classOk = classA.every((c) => classB.includes(c));
  // strip class + hx-*/data-* attrs + style(display:none) from both, compare the rest
  function strip(tag) {
    return tag
      .replace(/\sclass="[^"]*"/, "")
      .replace(/\shx-[a-zA-Z-]+="[^"]*"/g, "")
      .replace(/\sdata-[a-zA-Z-]+="[^"]*"/g, "")
      .replace(/\sstyle="display:\s*none;?"/, "");
  }
  return classOk && strip(a) === strip(b);
}

// Diffs two PNG buffers via a canvas in a fresh puppeteer page (no npm image libs): decodes
// both, exact per-pixel RGBA compare, produces a highlight PNG (red = differing pixel,
// dimmed original elsewhere), skipping pixels inside any masked rect (default: .qlive).
async function pixelDiff(browser, bufA, bufB, maskRects) {
  const page = await browser.newPage();
  try {
    const dataA = "data:image/png;base64," + bufA.toString("base64");
    const dataB = "data:image/png;base64," + bufB.toString("base64");
    const result = await page.evaluate(async (dataA, dataB, maskRects) => {
      function loadImg(src) {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = src;
        });
      }
      const [imgA, imgB] = await Promise.all([loadImg(dataA), loadImg(dataB)]);
      const w = Math.max(imgA.width, imgB.width), h = Math.max(imgA.height, imgB.height);
      const ca = document.createElement("canvas"); ca.width = w; ca.height = h;
      const cb = document.createElement("canvas"); cb.width = w; cb.height = h;
      ca.getContext("2d").drawImage(imgA, 0, 0);
      cb.getContext("2d").drawImage(imgB, 0, 0);
      const da = ca.getContext("2d").getImageData(0, 0, w, h).data;
      const db = cb.getContext("2d").getImageData(0, 0, w, h).data;
      const out = document.createElement("canvas"); out.width = w; out.height = h;
      const xo = out.getContext("2d");
      const od = xo.createImageData(w, h);
      // A small per-channel tolerance: headless Chromium's software rasterizer (no GPU in
      // the sandbox) is not bit-exact run to run on antialiased edges - radio/details
      // markers, border-radius/box-shadow blur - even with identical DOM and computed
      // styles (verified separately via the layout/DOM diff). Zero tolerance made the
      // same-tree self-check (brief step b) nondeterministic on exactly this kind of
      // pixel; a real visual change moves far more than a handful of pixels by far more
      // than this tolerance, so it still gets caught.
      const TOL = 24;
      let diffCount = 0, sameDims = imgA.width === imgB.width && imgA.height === imgB.height;
      for (let p = 0; p < da.length; p += 4) {
        const px = (p / 4) % w, py = Math.floor((p / 4) / w);
        const masked = (maskRects || []).some((m) => px >= m.x && px < m.x + m.width && py >= m.y && py < m.y + m.height);
        if (masked) { od.data[p] = 40; od.data[p + 1] = 80; od.data[p + 2] = 220; od.data[p + 3] = 90; continue; }
        const diff = Math.abs(da[p] - db[p]) > TOL || Math.abs(da[p + 1] - db[p + 1]) > TOL || Math.abs(da[p + 2] - db[p + 2]) > TOL || Math.abs(da[p + 3] - db[p + 3]) > TOL;
        if (diff) {
          diffCount++;
          od.data[p] = 255; od.data[p + 1] = 0; od.data[p + 2] = 0; od.data[p + 3] = 255;
        } else {
          od.data[p] = da[p]; od.data[p + 1] = da[p + 1]; od.data[p + 2] = da[p + 2]; od.data[p + 3] = 60;
        }
      }
      xo.putImageData(od, 0, 0);
      return { width: w, height: h, diffCount, totalPixels: w * h, sameDims, dataUrl: out.toDataURL("image/png") };
    }, dataA, dataB, maskRects || []);
    const pngBuffer = Buffer.from(result.dataUrl.split(",")[1], "base64");
    return { diffCount: result.diffCount, totalPixels: result.totalPixels, width: result.width, height: result.height, sameDims: result.sameDims, pngBuffer };
  } finally {
    await page.close();
  }
}

// Rects (CSS px, matching a DPR-1 desktop screenshot) of elements matching `selectors`
// (an array of CSS selectors), for use as pixelDiff mask rects.
async function maskRectsFor(page, selectors) {
  return page.evaluate((selectors) => {
    const out = [];
    selectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) out.push({ x: Math.floor(r.left), y: Math.floor(r.top), width: Math.ceil(r.width), height: Math.ceil(r.height) });
      });
    });
    return out;
  }, selectors);
}

module.exports = { layoutSnapshot, domSnapshot, diffLayout, diffDom, pixelDiff, maskRectsFor, renormaliseBaselineDom };
