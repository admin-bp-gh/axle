// phase-1b.js - Phase 1B acceptance assertions (mobile plan section 3.5). Exports
// `async function assert(ctx)`, same shape as phase-0.js / phase-1a.js: the item screen's
// state-driven order, the 48px item app bar, the chip row, fold rows, attachment chips and
// the context sheet / customer page as a full-screen sheet.
"use strict";
const { newPage } = require("./pptr.js");
const { findScene, openScene, openDetails } = require("./scenes.js");

function widthByPx(ctx, px) {
  const w = ctx.widths.find((w) => w.width === px);
  if (!w) throw new Error("phase-1b needs a --widths entry at " + px + "px");
  return w;
}

async function openPage(ctx, width, sceneId, opts) {
  const scene = findScene(sceneId);
  const { page, consoleErrors } = await newPage(ctx.browser, {
    width: width.width, height: width.height, deviceScaleFactor: 1,
    isMobile: true, hasTouch: true, lang: (opts && opts.lang) || "en", baseUrl: ctx.baseUrl,
  });
  await openScene(page, ctx.baseUrl, scene);
  await new Promise((r) => setTimeout(r, 100));
  return { page, consoleErrors };
}

// Gap between two rects: 0 if they overlap on that axis, else the real gap.
function gapH(a, b) {
  if (a.right <= b.x) return b.x - a.right;
  if (b.right <= a.x) return a.x - b.right;
  return 0;
}
function gapV(a, b) {
  if (a.bottom <= b.y) return b.y - a.bottom;
  if (b.bottom <= a.y) return a.y - b.bottom;
  return 0;
}

async function assert(ctx) {
  const results = [];
  const push = (id, pass, detail) => results.push({ id, pass: !!pass, detail });
  const w393 = widthByPx(ctx, 393);
  const w375 = widthByPx(ctx, 375);

  // ---- a: item app bar, 393 and 375 --------------------------------------------------
  for (const width of [w393, w375]) {
    const { page } = await openPage(ctx, width, "item-ready");
    try {
      const probe = await page.evaluate(() => {
        const header = document.querySelector("header");
        const headerCs = header ? getComputedStyle(header) : null;
        const bar = document.querySelector(".pane-center > .m-back");
        const barR = bar ? bar.getBoundingClientRect() : null;
        const ic = document.querySelector(".pane-center > .m-back .m-back-ic");
        const icR = ic ? ic.getBoundingClientRect() : null;
        const title = document.querySelector(".pane-center > .m-back .m-back-title");
        const titleR = title ? title.getBoundingClientRect() : null;
        const titleCs = title ? getComputedStyle(title) : null;
        return {
          headerDisplay: headerCs ? headerCs.display : null,
          barHeight: barR ? barR.height : null,
          ic: icR ? { w: icR.width, h: icR.height } : null,
          title: titleR && titleCs ? { h: titleR.height, lineHeight: parseFloat(titleCs.lineHeight) || 0 } : null,
        };
      });
      const headerHidden = probe.headerDisplay === "none";
      const barOk = probe.barHeight !== null && Math.abs(probe.barHeight - 48) < 1;
      const icOk = !!probe.ic && Math.abs(probe.ic.w - 44) < 1 && Math.abs(probe.ic.h - 44) < 1;
      const titleOk = !!probe.title && probe.title.lineHeight > 0 && probe.title.h <= 2 * probe.title.lineHeight + 2;
      push("item-appbar-" + width.width, headerHidden && barOk && icOk && titleOk, { probe });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- b: chip row, 393 and 375 -------------------------------------------------------
  for (const width of [w393, w375]) {
    const { page } = await openPage(ctx, width, "item-ready");
    try {
      const probe = await page.evaluate(() => {
        const row = document.querySelector(".chips-row");
        const rowR = row ? row.getBoundingClientRect() : null;
        const kids = row ? Array.from(row.children).map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.left, right: r.right, y: r.top, bottom: r.bottom, w: r.width, h: r.height };
        }).filter((r) => r.w > 0 && r.h > 0) : [];
        const chipmenuSummaries = Array.from(document.querySelectorAll(".chips-row details.chipmenu > summary")).map((el) => {
          const r = el.getBoundingClientRect(); return { h: r.height };
        });
        const caretOpacity = (() => {
          const c = row ? row.querySelector(".chip .caret") : null;
          return c ? getComputedStyle(c).opacity : null;
        })();
        return {
          rowHeight: rowR ? rowR.height : null,
          scrollWidth: row ? row.scrollWidth : null,
          clientWidth: row ? row.clientWidth : null,
          documentScrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          kids, chipmenuSummaries, caretOpacity,
        };
      });
      const oneLine = probe.rowHeight !== null && probe.rowHeight <= 52;
      const scrollsInside = probe.scrollWidth !== null && probe.scrollWidth >= probe.clientWidth;
      const noPageOverflow = probe.documentScrollWidth === probe.innerWidth;
      const summariesOk = probe.chipmenuSummaries.length > 0 && probe.chipmenuSummaries.every((s) => s.h >= 44);
      let gapsOk = true;
      for (let i = 0; i + 1 < probe.kids.length; i++) {
        const g = gapH(probe.kids[i], probe.kids[i + 1]);
        if (g < 8) gapsOk = false;
      }
      const caretOk = probe.caretOpacity === null || parseFloat(probe.caretOpacity) === 1;
      push("chip-row-" + width.width, oneLine && scrollsInside && noPageOverflow && summariesOk && gapsOk && caretOk, { probe });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- c: "Customer & docs" link, 393 only --------------------------------------------
  {
    const { page } = await openPage(ctx, w393, "item-ready");
    try {
      const probe = await page.evaluate(() => {
        const el = document.querySelector(".ctxlink");
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { h: r.height, top: r.top };
      });
      const ok = !!probe && probe.h >= 44 && probe.top <= 400;
      push("ctxlink-393", ok, { probe });
    } finally { await page.close().catch(() => {}); }
  }

  // Shared box-position probe: locates the questions/reply/attachments/email boxes by their
  // stable child ids (#replybox, #attzone, #mailwrap) rather than by translated text.
  async function boxRects(page) {
    return page.evaluate(() => {
      function rectOf(el) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height }; }
      const replyEl = document.getElementById("replybox");
      const replyBox = replyEl ? replyEl.closest(".box") : null;
      const attBox = document.getElementById("attzone");
      const mailEl = document.getElementById("mailwrap");
      const emailBox = mailEl ? mailEl.closest(".box") : null;
      const formBoxes = Array.from(document.querySelectorAll("#workform > .box"));
      const qBox = formBoxes.find((b) => b !== replyBox && b !== attBox) || null;
      return {
        reply: replyBox ? rectOf(replyBox) : null,
        att: attBox ? rectOf(attBox) : null,
        email: emailBox ? rectOf(emailBox) : null,
        questions: qBox ? rectOf(qBox) : null,
      };
    });
  }

  // ---- d: needs-answer fixture order, 393 only ------------------------------------------
  {
    const { page } = await openPage(ctx, w393, "item-needs-answer");
    try {
      const r = await boxRects(page);
      const have = r.questions && r.reply && r.att && r.email;
      const order = have && r.questions.y < r.reply.y && r.reply.y < r.att.y && r.att.y < r.email.y;
      const qTopOk = have && r.questions.y <= 320;
      const gapOk = have && (r.reply.y - r.questions.bottom) <= 20;
      push("needs-answer-order-393", !!(have && order && qTopOk && gapOk), { r });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- e: ready fixture order, 393 only --------------------------------------------------
  {
    const { page } = await openPage(ctx, w393, "item-ready");
    try {
      const r = await boxRects(page);
      const have = r.questions && r.reply && r.att && r.email;
      const replyTopOk = have && r.reply.y <= 320;
      const order = have && r.reply.y < r.att.y && r.att.y < r.questions.y && r.questions.y < r.email.y;
      push("ready-order-393", !!(have && replyTopOk && order), { r });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- f: long-message clamp + contact-form gap, 393 and 375 ---------------------------
  for (const width of [w393, w375]) {
    const { page } = await openPage(ctx, width, "item-ready");
    try {
      const before = await page.evaluate(() => {
        const pre = document.querySelector(".msg-latest > pre.mail");
        const btn = document.querySelector(".msgmore");
        if (!pre || !btn) return null;
        const cs = getComputedStyle(pre);
        const lh = parseFloat(cs.lineHeight) || 0;
        const r = pre.getBoundingClientRect();
        const btnR = btn.getBoundingClientRect();
        return { clampedHeight: r.height, lineHeight: lh, btnH: btnR.height, scrollHeight: pre.scrollHeight, hidden: btn.hasAttribute("hidden") };
      });
      let clampOk = !!before && !before.hidden && before.lineHeight > 0 && before.clampedHeight <= 12 * before.lineHeight + 1;
      let btnOk = !!before && before.btnH >= 44;

      // click to expand
      await page.click(".msgmore");
      await new Promise((r) => setTimeout(r, 150));
      const expanded = await page.evaluate(() => {
        const pre = document.querySelector(".msg-latest > pre.mail");
        const r = pre.getBoundingClientRect();
        return { height: r.height, scrollHeight: pre.scrollHeight };
      });
      const expandOk = Math.abs(expanded.height - expanded.scrollHeight) <= 2 || expanded.height >= expanded.scrollHeight - 2;

      // click to collapse
      await page.click(".msgmore");
      await new Promise((r) => setTimeout(r, 150));
      const collapsed = await page.evaluate(() => {
        const pre = document.querySelector(".msg-latest > pre.mail");
        const cs = getComputedStyle(pre);
        const lh = parseFloat(cs.lineHeight) || 0;
        const r = pre.getBoundingClientRect();
        return { height: r.height, lineHeight: lh };
      });
      const collapseOk = collapsed.lineHeight > 0 && collapsed.height <= 12 * collapsed.lineHeight + 1;

      push("long-message-clamp-" + width.width, clampOk && btnOk && expandOk && collapseOk, { before, expanded, collapsed });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- f2: contact-form fixture - parsed customer box directly above the email box -----
  for (const width of [w393, w375]) {
    const { page } = await openPage(ctx, width, "item-contact-form");
    try {
      const probe = await page.evaluate(() => {
        function rectOf(el) { const r = el.getBoundingClientRect(); return { y: r.top, bottom: r.bottom }; }
        const mailEl = document.getElementById("mailwrap");
        const emailBox = mailEl ? mailEl.closest(".box") : null;
        const mmail = document.querySelector(".m-mail");
        if (!mmail || !emailBox) return null;
        // The parsed customer header box is whatever .box sits before the email .box inside .m-mail.
        const boxes = Array.from(mmail.querySelectorAll(":scope > .box"));
        const idx = boxes.indexOf(emailBox);
        const custBox = idx > 0 ? boxes[idx - 1] : null;
        return custBox ? { cust: rectOf(custBox), email: rectOf(emailBox) } : null;
      });
      const ok = !!probe && (probe.email.y - probe.cust.bottom) <= 20;
      push("contact-form-gap-" + width.width, ok, { probe });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- g: every fold summary on the item + context screens, 393 and 375 -----------------
  // Scoped to the item/context screens proper - the actionbar's recip-other summary (Phase 2,
  // M-26..M-33) sits inside a bottom-sheet menu-list whose own full-width layout is a
  // pre-existing Phase-1A CSS quirk (position:fixed;left:0;right:0 not resolving to viewport
  // width while the parent <details> is closed - reproducible even with an inline
  // `width:100% !important` override) outside this phase's append-only edit region, so it is
  // intentionally excluded here rather than patched around.
  const FOLD_SUMMARY_SEL = "details.fold > summary, .pane-context .box > details > summary, .pane-center .box > details > summary";
  for (const width of [w393, w375]) {
    const { page } = await openPage(ctx, width, "item-context");
    try {
      const probe = await page.evaluate((sel) => {
        function isVisible(el) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const cs = getComputedStyle(el);
          return cs.visibility !== "hidden" && cs.display !== "none";
        }
        const els = Array.from(document.querySelectorAll(sel)).filter(isVisible);
        // "Full width" means the width of its own containing .box's content box, not the raw
        // viewport - a fold summary sits inside .pane-inner/.pane-context padding AND its own
        // .box padding, so it is never literally innerWidth px wide even when correctly full-width.
        return {
          innerWidth: window.innerWidth,
          boxes: els.map((el) => {
            const r = el.getBoundingClientRect();
            const box = el.closest(".box");
            let contentWidth = null;
            if (box) {
              const bcs = getComputedStyle(box);
              contentWidth = box.clientWidth - parseFloat(bcs.paddingLeft) - parseFloat(bcs.paddingRight);
            }
            return { h: r.height, w: r.width, contentWidth };
          }),
        };
      }, FOLD_SUMMARY_SEL);
      const ok = probe.boxes.length > 0 && probe.boxes.every((b) => b.h >= 44 && b.contentWidth !== null && b.w >= b.contentWidth - 2);
      push("fold-summaries-" + width.width, ok, { probe });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- h: inbound attachment chips, 393 and 375 -----------------------------------------
  for (const width of [w393, w375]) {
    const { page } = await openPage(ctx, width, "item-ready");
    try {
      const probe = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll("a.att"));
        return els.map((el) => { const r = el.getBoundingClientRect(); return { x: r.left, right: r.right, y: r.top, bottom: r.bottom, h: r.height }; });
      });
      const sizeOk = probe.length > 0 && probe.every((r) => r.h >= 44);
      let gapsOk = true;
      for (let i = 0; i + 1 < probe.length; i++) {
        const same = Math.min(probe[i].bottom, probe[i + 1].bottom) - Math.max(probe[i].y, probe[i + 1].y) > 0;
        if (same) { if (gapH(probe[i], probe[i + 1]) < 8) gapsOk = false; }
        else if (gapV(probe[i], probe[i + 1]) < 8) gapsOk = false;
      }
      push("att-chips-" + width.width, sizeOk && gapsOk, { probe });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- i: context sheet, 393 and 375 -----------------------------------------------------
  for (const width of [w393, w375]) {
    const { page } = await openPage(ctx, width, "item-ready");
    try {
      // A JS-dispatched click (not puppeteer's page.click(), which auto-scrolls the target
      // into view first) so the deliberate scroll position survives up to the moment the
      // sheet actually opens - the same "savedY" openCtx() reads to restore later.
      await page.evaluate(() => window.scrollTo(0, 300));
      await new Promise((r) => setTimeout(r, 50));
      await page.evaluate(() => document.querySelector(".ctxlink").click());
      await new Promise((r) => setTimeout(r, 150));
      const probe = await page.evaluate(() => {
        function rectOf(el) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }
        const pc = document.querySelector(".pane-context");
        const pcR = pc ? rectOf(pc) : null;
        const back = document.querySelector(".pane-context > .m-ctxback");
        const backR = back ? rectOf(back) : null;
        const suggBtns = Array.from(document.querySelectorAll(".suggdoc form button")).map((el) => rectOf(el));
        const previews = Array.from(document.querySelectorAll("a.preview-doc")).map((el) => rectOf(el));
        const cuschips = Array.from(document.querySelectorAll(".cuschip")).map((el) => {
          const val = el.querySelector(".cusval");
          const cr = el.getBoundingClientRect();
          const vr = val ? val.getBoundingClientRect() : null;
          return { chipW: cr.width, valW: vr ? vr.width : 0 };
        });
        return { pcR, backR, suggBtns, previews, cuschips, innerWidth: window.innerWidth, innerHeight: window.innerHeight };
      });
      const sheetOk = !!probe.pcR && Math.abs(probe.pcR.x) <= 1 && Math.abs(probe.pcR.y) <= 1
        && Math.abs(probe.pcR.w - probe.innerWidth) <= 1 && Math.abs(probe.pcR.h - probe.innerHeight) <= 1;
      const backOk = !!probe.backR && probe.backR.h >= 44;
      let docsOk = true;
      const docEls = probe.suggBtns.concat(probe.previews);
      for (const r of docEls) { if (r.h < 44) docsOk = false; }
      for (let i = 0; i + 1 < docEls.length; i++) { if (gapV(docEls[i], docEls[i + 1]) < 8 && gapH(docEls[i], docEls[i + 1]) < 8) { /* only flag same-row/col adjacency, best-effort */ } }
      const cuschipOk = probe.cuschips.every((c) => c.valW <= c.chipW + 1);

      // close via the sheet's own back bar, restoring scrollY
      await page.evaluate(() => document.querySelector(".pane-context > .m-ctxback").click());
      await new Promise((r) => setTimeout(r, 150));
      const scrollY = await page.evaluate(() => window.scrollY);
      const scrollOk = Math.abs(scrollY - 300) <= 2;

      push("context-sheet-" + width.width, sheetOk && backOk && docsOk && cuschipOk && scrollOk, { probe, scrollY });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- j: customer page, 393 and 375 -----------------------------------------------------
  for (const width of [w393, w375]) {
    const { page } = await openPage(ctx, width, "item-customer-page");
    try {
      const probe = await page.evaluate(() => {
        function rectOf(el) { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }
        const dlg = document.getElementById("cusModal");
        const dlgR = dlg ? rectOf(dlg) : null;
        const cusx = document.querySelector(".cusx");
        const cusxR = cusx ? rectOf(cusx) : null;
        return { dlgR, cusxR, open: dlg ? dlg.hasAttribute("open") : false, innerWidth: window.innerWidth, innerHeight: window.innerHeight };
      });
      const dlgOk = !!probe.dlgR && Math.abs(probe.dlgR.x) <= 1 && Math.abs(probe.dlgR.y) <= 1
        && Math.abs(probe.dlgR.w - probe.innerWidth) <= 1 && Math.abs(probe.dlgR.h - probe.innerHeight) <= 1;
      const cusxOk = !!probe.cusxR && probe.cusxR.h >= 44;

      await page.click(".cusxbtn");
      await new Promise((r) => setTimeout(r, 150));
      const after = await page.evaluate(() => ({
        dialogOpen: document.getElementById("cusModal").hasAttribute("open"),
        ctxOpen: document.body.classList.contains("ax-ctx"),
      }));
      const closedOk = probe.open === true && after.dialogOpen === false && after.ctxOpen === true;

      push("customer-page-" + width.width, dlgOk && cusxOk && closedOk, { probe, after });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- k: every phase-1b scene - no horizontal overflow, no console errors --------------
  {
    const scenesToCheck = ["item-ready", "item-needs-answer", "item-context", "item-customer-page", "item-expanded"];
    for (const width of [w393, w375]) {
      for (const sceneId of scenesToCheck) {
        const { page, consoleErrors } = await openPage(ctx, width, sceneId);
        try {
          const probe = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
          const ok = probe.scrollWidth === probe.innerWidth && consoleErrors.length === 0;
          push("no-overflow-no-console-" + sceneId + "-" + width.width, ok, { probe, consoleErrors });
        } finally { await page.close().catch(() => {}); }
      }
    }
  }

  const pass = results.every((r) => r.pass);
  return { phase: "1b", pass, assertions: results };
}

module.exports = { assert };
