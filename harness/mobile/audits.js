// audits.js - the K5 headless-walk audits: tap targets, horizontal overflow, small text
// inputs, fixed/sticky elements, the queue's phantom-scroll probe, and a couple of
// Phase-0-specific targeted probes (the attach-by-number input, the customer dialog).
// Each evaluate() callback inlines its own small DOM helpers (labelOf/domPath/isVisible)
// rather than sharing code across the page boundary, since only JSON-serializable
// arguments cross into page.evaluate().
"use strict";

// Every visible a/button/summary/input/select/textarea/label[for]: <44x44, or <8px from a
// same-row neighbour (vertical overlap > 50% of the smaller height), is a violation.
// Links inside pre.mail or .trbox are exempt.
async function tapAudit(page) {
  return page.evaluate(() => {
    function labelOf(el) {
      if (el.id) return "#" + el.id;
      const cls = (el.className && typeof el.className === "string") ? el.className.trim().split(/\s+/).filter(Boolean).join(".") : "";
      return el.tagName.toLowerCase() + (cls ? "." + cls : "");
    }
    function isVisible(el) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none";
    }
    function exempt(el) { return !!el.closest("pre.mail") || !!el.closest(".trbox"); }
    const sel = "a, button, summary, input, select, textarea, label[for]";
    const boxes = Array.from(document.querySelectorAll(sel)).filter(isVisible).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        label: labelOf(el), exempt: exempt(el),
        rect: { x: r.left, y: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom },
      };
    });
    const violations = [];
    for (const b of boxes) {
      if (b.exempt) continue;
      if (b.rect.width < 44 || b.rect.height < 44) {
        violations.push({ label: b.label, rect: b.rect, reason: "size " + Math.round(b.rect.width) + "x" + Math.round(b.rect.height) + " below 44x44" });
      }
    }
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const A = boxes[i], B = boxes[j];
        if (A.exempt || B.exempt) continue;
        const overlapTop = Math.max(A.rect.y, B.rect.y), overlapBottom = Math.min(A.rect.bottom, B.rect.bottom);
        const overlap = overlapBottom - overlapTop;
        const smallerH = Math.min(A.rect.height, B.rect.height);
        if (smallerH > 0 && overlap > 0.5 * smallerH) {
          let gap = null;
          if (A.rect.right <= B.rect.x) gap = B.rect.x - A.rect.right;
          else if (B.rect.right <= A.rect.x) gap = A.rect.x - B.rect.right;
          if (gap !== null && gap < 8) {
            violations.push({ label: A.label + " ~ " + B.label, rect: A.rect, reason: "gap " + Math.round(gap) + "px below 8px" });
          }
        }
      }
    }
    return { total: boxes.length, violations };
  });
}

// documentElement.scrollWidth === innerWidth; else list elements whose right edge exceeds it.
async function overflowAudit(page) {
  return page.evaluate(() => {
    function labelOf(el) {
      if (el.id) return "#" + el.id;
      const cls = (el.className && typeof el.className === "string") ? el.className.trim().split(/\s+/).filter(Boolean).join(".") : "";
      return el.tagName.toLowerCase() + (cls ? "." + cls : "");
    }
    const scrollWidth = document.documentElement.scrollWidth;
    const innerWidth = window.innerWidth;
    const offenders = [];
    if (scrollWidth !== innerWidth) {
      document.querySelectorAll("body *").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > innerWidth + 0.5) offenders.push({ label: labelOf(el), right: Math.round(r.right) });
      });
    }
    return { ok: scrollWidth === innerWidth, scrollWidth, innerWidth, offenders: offenders.slice(0, 50) };
  });
}

// Every visible text-like input/select/textarea/[contenteditable] with computed
// font-size < 16px.
async function fontSizeAudit(page) {
  return page.evaluate(() => {
    function domPath(el) {
      const parts = [];
      let node = el;
      while (node && node.nodeType === 1) {
        let idx = 1, sib = node;
        while ((sib = sib.previousElementSibling)) idx++;
        let part = node.tagName.toLowerCase() + ":nth-child(" + idx + ")";
        if (node.id) part += "#" + node.id;
        parts.unshift(part);
        if (node === document.body) break;
        node = node.parentElement;
      }
      return parts.join(" > ");
    }
    function isVisible(el) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== "hidden" && cs.display !== "none";
    }
    const EXCLUDE_TYPES = ["checkbox", "radio", "file", "hidden"];
    const results = [];
    document.querySelectorAll("input, select, textarea, [contenteditable]").forEach((el) => {
      if (el.tagName === "INPUT" && EXCLUDE_TYPES.includes((el.getAttribute("type") || "").toLowerCase())) return;
      if (!isVisible(el)) return;
      const size = parseFloat(getComputedStyle(el).fontSize);
      if (size < 16) results.push({ path: domPath(el), fontSize: size });
    });
    return results;
  });
}

// Every fixed/sticky element's rect.
async function fixedStickyAudit(page) {
  return page.evaluate(() => {
    function labelOf(el) {
      if (el.id) return "#" + el.id;
      const cls = (el.className && typeof el.className === "string") ? el.className.trim().split(/\s+/).filter(Boolean).join(".") : "";
      return el.tagName.toLowerCase() + (cls ? "." + cls : "");
    }
    const out = [];
    document.querySelectorAll("body *").forEach((el) => {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "sticky") return;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      out.push({ label: labelOf(el), position: cs.position, rect: { x: r.left, y: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom } });
    });
    return out;
  });
}

// scrollHeight minus the max bottom edge of any element with a box, plus main's computed
// bottom padding (the M-05 9px-phantom-scroll trace).
async function phantomScrollProbe(page) {
  return page.evaluate(() => {
    let maxBottom = 0;
    document.querySelectorAll("body *").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) maxBottom = Math.max(maxBottom, r.bottom + window.scrollY);
    });
    const scrollHeight = document.documentElement.scrollHeight;
    const main = document.querySelector("main");
    const mainPaddingBottom = main ? parseFloat(getComputedStyle(main).paddingBottom) : null;
    return { scrollHeight, maxBottom, phantom: scrollHeight - maxBottom, mainPaddingBottom };
  });
}

async function sprocketRect(page) {
  return page.evaluate(() => {
    const el = document.querySelector("#sprocket");
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return { display: cs.display, rect: { x: r.left, y: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom } };
  });
}

// Phase-0 targeted probe: the manual attach-by-number input (item.js:520, no `type`,
// inputmode="numeric") on the item screen.
async function attachByNumberProbe(page) {
  return page.evaluate(() => {
    const el = document.querySelector('input[name="docnum"][inputmode="numeric"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { fontSize: parseFloat(cs.fontSize), height: r.height };
  });
}

async function viewportMetaProbe(page) {
  return page.evaluate(() => {
    const m = document.querySelector('meta[name="viewport"]');
    return m ? m.getAttribute("content") : null;
  });
}

// Phase-0 targeted probe: the open customer dialog's computed max-height vs 86% of
// innerHeight (checked once the item-customer scene has opened it).
async function cusdialogProbe(page) {
  return page.evaluate(() => {
    const el = document.getElementById("cusModal");
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { maxHeight: parseFloat(cs.maxHeight), innerHeight: window.innerHeight, open: el.open === true || el.hasAttribute("open") };
  });
}

// Rect of an element by selector (used for the .actionbar / .modal-foot intersection check).
async function rectOf(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  }, selector);
}

module.exports = {
  tapAudit, overflowAudit, fontSizeAudit, fixedStickyAudit, phantomScrollProbe,
  sprocketRect, attachByNumberProbe, viewportMetaProbe, cusdialogProbe, rectOf,
};
