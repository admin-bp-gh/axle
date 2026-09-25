// phase-0.js - Phase 0 acceptance assertions (mobile plan section 3.3). Exports
// `async function assert(ctx)`; later phases add their own harness/mobile/phase-N.js
// each exporting the same shape, per the brief ("Structure the code so later phases add
// an assertion module each").
//
// ctx: { tree, baseUrl, browser, walk, widths } where `walk` is the JSON already produced
// by the walk command for this run (reused so phase-0 doesn't re-open every scene), and
// `widths` is the parsed --widths list (phone widths only).
"use strict";
const fs = require("fs");
const path = require("path");
const CC = require("./css-check.js");

function findWalkEntry(walk, widthLabel, sceneId) {
  return walk.entries.find((e) => e.width === widthLabel && e.scene === sceneId);
}

async function assert(ctx) {
  const { tree, baseUrl, browser, walk } = ctx;
  const results = [];
  const push = (id, pass, detail) => results.push({ id, pass: !!pass, detail });

  const phoneWidths = ctx.widths.filter((w) => w.width <= 500).map((w) => w.label);
  const w393 = ctx.widths.find((w) => w.width === 393) || ctx.widths[0];

  // a1: font-size list empty on the listed screens, at every phone width walked.
  {
    const screens = ["queue-open", "item-needs-answer", "item-contact-form", "item-ready", "compose", "audit", "blocks"];
    const offenders = [];
    for (const width of phoneWidths) {
      for (const scene of screens) {
        const entry = findWalkEntry(walk, width, scene);
        if (entry && entry.fontSize && entry.fontSize.length) {
          entry.fontSize.forEach((v) => offenders.push({ width, scene, ...v }));
        }
      }
    }
    push("font-size-16px-on-listed-screens", offenders.length === 0, { offenders: offenders.slice(0, 30) });
  }

  // a2: attach-by-number input: 16px font, >=44px tall, at 393 and 375.
  {
    const details = [];
    let pass = true;
    for (const width of phoneWidths) {
      const entry = findWalkEntry(walk, width, "item-ready");
      const probe = entry && entry.extra && entry.extra.attachByNumber;
      const ok = !!probe && probe.fontSize === 16 && probe.height >= 44;
      if (!ok) pass = false;
      details.push({ width, probe: probe || null, ok });
    }
    push("attach-by-number-16px-44h", pass, { details });
  }

  // a3: #sprocket display:none; no fixed element intersects .actionbar or .modal-foot.
  {
    const details = [];
    let pass = true;
    for (const width of phoneWidths) {
      const readyEntry = findWalkEntry(walk, width, "item-ready");
      const composeEntry = findWalkEntry(walk, width, "compose");
      const sprocketHidden = readyEntry && readyEntry.sprocket && readyEntry.sprocket.display === "none";
      const barRect = readyEntry && readyEntry.extra && readyEntry.extra.actionbarRect;
      const footRect = composeEntry && composeEntry.extra && composeEntry.extra.modalFootRect;
      // Only position:fixed overlays count (the plan's wording), and never the container the
      // target lives in: .actionbar is itself sticky and #composeModal is the fixed overlay
      // that holds .modal-foot, so both would trivially intersect their own target.
      const isOverlay = (f) => f.position === "fixed" && f.label !== "#composeModal" && !/^div\.modal(\.|$)/.test(f.label);
      const fixedReady = ((readyEntry && readyEntry.fixedSticky) || []).filter(isOverlay);
      const fixedCompose = ((composeEntry && composeEntry.fixedSticky) || []).filter(isOverlay);
      const intersects = (a, b) => !!a && !!b && a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y;
      const barHit = barRect ? fixedReady.filter((f) => intersects(f.rect, barRect)) : [];
      const footHit = footRect ? fixedCompose.filter((f) => intersects(f.rect, footRect)) : [];
      const ok = !!sprocketHidden && barHit.length === 0 && footHit.length === 0;
      if (!ok) pass = false;
      details.push({ width, sprocketDisplay: readyEntry && readyEntry.sprocket && readyEntry.sprocket.display, barHit, footHit });
    }
    push("sprocket-hidden-no-fixed-overlap", pass, { details });
  }

  // a4: viewport meta contains viewport-fit=cover, at 393 and 375.
  {
    const details = [];
    let pass = true;
    for (const width of phoneWidths) {
      const entry = findWalkEntry(walk, width, "queue-open");
      const content = entry && entry.extra && entry.extra.viewportMeta;
      const ok = !!content && content.includes("viewport-fit=cover");
      if (!ok) pass = false;
      details.push({ width, content: content || null });
    }
    push("viewport-fit-cover", pass, { details });
  }

  // a5: static CSS check - header, .m-back, .queue-head, .actionbar, .modal rules contain env(safe-area-inset-.
  {
    const css = fs.readFileSync(path.join(tree, "assets", "components.css"), "utf8");
    const names = ["header", ".m-back", ".queue-head", ".actionbar", ".modal"];
    const perName = {};
    let pass = true;
    for (const name of names) {
      const ok = CC.hasSafeAreaEnv(css, name);
      perName[name] = ok;
      if (!ok) pass = false;
    }
    push("safe-area-env-css", pass, { perName });
  }

  // a6: .cusdialog computed max-height equals 86% of innerHeight, at 393.
  {
    let entry = findWalkEntry(walk, w393.label, "item-customer");
    const probe = entry && entry.extra && entry.extra.cusdialog;
    const expect = w393.height * 0.86;
    const ok = !!probe && probe.open && Math.abs(probe.maxHeight - expect) < 1;
    push("cusdialog-86pct-maxheight", ok, { probe: probe || null, expectedMaxHeight: expect, width: w393.label });
  }

  // a7: no bare vh left in .cusdialog/.empty-state/.sprocket-panel except a fallback line before a dvh line.
  {
    const css = fs.readFileSync(path.join(tree, "assets", "components.css"), "utf8");
    const names = [".cusdialog", ".empty-state", ".sprocket-panel"];
    const per = CC.checkVhFallback(css, names);
    const pass = names.every((n) => per[n] && per[n].ok);
    push("vh-fallback-before-dvh", pass, { per });
  }

  // a8: queue phantom-scroll probe at 393 - scrollHeight minus lowest visible box no more
  // than main's bottom padding.
  {
    const entry = findWalkEntry(walk, w393.label, "queue-open");
    const probe = entry && entry.phantomScroll;
    const ok = !!probe && probe.phantom <= (probe.mainPaddingBottom || 0) + 0.5;
    push("phantom-scroll-queue", ok, { probe: probe || null, width: w393.label });
  }

  // a9: documentElement.scrollWidth === viewport width on every page walked at 393, 375.
  {
    const offenders = [];
    for (const width of phoneWidths) {
      for (const entry of walk.entries.filter((e) => e.width === width)) {
        if (!entry.overflow || !entry.overflow.ok) offenders.push({ width, scene: entry.scene, overflow: entry.overflow });
      }
    }
    push("scrollwidth-eq-viewport", offenders.length === 0, { offenders });
  }

  const pass = results.every((r) => r.pass);
  return { phase: 0, pass, assertions: results };
}

module.exports = { assert };
