// phase-1a.js - Phase 1A acceptance assertions (mobile plan section 3.4). Exports
// `async function assert(ctx)`, same shape as phase-0.js. Unlike phase-0 (which mostly
// reuses the walk's captured audits), most of these assertions need to interact with an
// open sheet or a live search/sort, so this module opens its own pages via pptr's
// newPage() + scenes.js's openScene()/openDetails() rather than reading the walk report.
"use strict";
const { newPage } = require("./pptr.js");
const { findScene, openScene, openDetails } = require("./scenes.js");

function widthByPx(ctx, px) {
  const w = ctx.widths.find((w) => w.width === px);
  if (!w) throw new Error("phase-1a needs a --widths entry at " + px + "px");
  return w;
}

async function openPage(ctx, width, sceneId, opts) {
  const scene = findScene(sceneId);
  const { page } = await newPage(ctx.browser, {
    width: width.width, height: width.height, deviceScaleFactor: 1,
    isMobile: true, hasTouch: true, lang: (opts && opts.lang) || "en", baseUrl: ctx.baseUrl,
  });
  await openScene(page, ctx.baseUrl, scene);
  await new Promise((r) => setTimeout(r, 100));
  return page;
}

// Rect helper, mirrors audits.js's shape (left/top/width/height/right/bottom).
async function rectOf(page, selectorOrHandle) {
  if (typeof selectorOrHandle === "string") {
    return page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    }, selectorOrHandle);
  }
  return selectorOrHandle.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  });
}

async function assert(ctx) {
  const results = [];
  const push = (id, pass, detail) => results.push({ id, pass: !!pass, detail });
  const w393 = widthByPx(ctx, 393);
  const w375 = widthByPx(ctx, 375);

  // ---- 1: app bar, at 393 and 375 --------------------------------------------------
  for (const width of [w393, w375]) {
    const page = await openPage(ctx, width, "queue-open");
    try {
      const probe = await page.evaluate(() => {
        const header = document.querySelector("header");
        const r = header.getBoundingClientRect();
        const cs = getComputedStyle(header);
        const btn = document.querySelector(".appmenu-btn");
        const btnR = btn ? btn.getBoundingClientRect() : null;
        const hiddenBoxes = Array.from(document.querySelectorAll("header > a, header .who")).map((el) => {
          const rr = el.getBoundingClientRect();
          return { w: rr.width, h: rr.height };
        });
        return {
          headerHeight: r.height, headerTop: r.top, flexWrap: cs.flexWrap,
          btn: btnR ? { w: btnR.width, h: btnR.height } : null,
          hiddenBoxes,
        };
      });
      const okHeight = Math.abs(probe.headerHeight - 48) < 1;
      const oneRow = probe.flexWrap === "nowrap";
      const okBtn = probe.btn && probe.btn.w >= 44 && probe.btn.h >= 44;
      const okHidden = probe.hiddenBoxes.every((b) => b.w === 0 || b.h === 0 || (b.w === 0 && b.h === 0));
      const zeroSize = probe.hiddenBoxes.every((b) => b.w === 0 && b.h === 0);
      push("appbar-" + width.width, okHeight && oneRow && okBtn && zeroSize, { probe });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- 2: app menu sheet, at 393 and 375 -------------------------------------------
  for (const width of [w393, w375]) {
    const page = await openPage(ctx, width, "queue-appmenu");
    try {
      const rows = await page.evaluate(() => {
        const gap = (a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          return ra.right <= rb.left ? rb.left - ra.right : rb.right <= ra.left ? ra.left - rb.right : 0;
        };
        const mitems = Array.from(document.querySelectorAll("details.appmenu a.mitem")).map((el) => {
          const r = el.getBoundingClientRect(); return { w: r.width, h: r.height };
        });
        const closes = Array.from(document.querySelectorAll("details.appmenu [data-close]")).map((el) => {
          const r = el.getBoundingClientRect(); return { w: r.width, h: r.height };
        });
        const segs = Array.from(document.querySelectorAll("details.appmenu .segrow .seg"));
        const segBoxes = segs.map((el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height }; });
        const segGap = segs.length >= 2 ? gap(segs[0], segs[1]) : null;
        const whoRow = document.querySelector("details.appmenu .who-row");
        const whoR = whoRow ? whoRow.getBoundingClientRect() : null;
        return { innerWidth: window.innerWidth, mitems, closes, segBoxes, segGap, whoVisible: !!whoR && whoR.width > 0 && whoR.height > 0 };
      });
      const minRowW = rows.innerWidth - 32;
      const mitemsOk = rows.mitems.length > 0 && rows.mitems.every((b) => b.h >= 44 && b.w >= minRowW);
      const closesOk = rows.closes.length > 0 && rows.closes.every((b) => b.h >= 44 && b.w >= minRowW);
      const segsOk = rows.segBoxes.length > 0 && rows.segBoxes.every((b) => b.h >= 44 && b.w >= 44) && (rows.segGap === null || rows.segGap >= 8);

      const scrimPos = await page.evaluate(() => {
        const s = document.querySelector("details.appmenu[open] > summary");
        return s ? getComputedStyle(s, "::before").position : null;
      });
      const iw = await page.evaluate(() => window.innerWidth);
      await page.mouse.click(iw / 2, 60);
      await new Promise((r) => setTimeout(r, 100));
      const closedByScrim = await page.evaluate(() => !document.querySelector("details.appmenu").open);

      await openDetails(page, "details.appmenu");
      await page.evaluate(() => { const b = document.querySelector("details.appmenu [data-close]"); if (b) b.click(); });
      await new Promise((r) => setTimeout(r, 100));
      const closedByDataClose = await page.evaluate(() => !document.querySelector("details.appmenu").open);

      push("menu-sheet-" + width.width, mitemsOk && closesOk && segsOk && rows.whoVisible && scrimPos === "fixed" && closedByScrim && closedByDataClose,
        { rows, scrimPos, closedByScrim, closedByDataClose });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- 3: queue sticky block, 393 only ----------------------------------------------
  {
    const page = await openPage(ctx, w393, "queue-open");
    try {
      const probe = await page.evaluate(() => {
        const qh = document.querySelector(".queue-head");
        const first = document.querySelector("a.qcard");
        return { qhHeight: qh ? qh.getBoundingClientRect().height : null, firstTop: first ? first.getBoundingClientRect().top : null };
      });
      const ok = probe.qhHeight !== null && probe.qhHeight <= 112 && probe.firstTop !== null && probe.firstTop <= 172;
      push("queue-sticky-393", ok, { probe });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- 4: qtabs, 375 only -------------------------------------------------------------
  {
    const page = await openPage(ctx, w375, "queue-open");
    try {
      const probe = await page.evaluate(() => {
        const gap = (a, b) => {
          const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
          if (ra.right <= rb.left) return rb.left - ra.right;
          if (rb.right <= ra.left) return ra.left - rb.right;
          const overlapTop = Math.max(ra.top, rb.top), overlapBottom = Math.min(ra.bottom, rb.bottom);
          if (overlapBottom - overlapTop > 0) return -1; // overlapping, not a gap case
          return ra.top <= rb.top ? rb.top - ra.bottom : ra.top - rb.bottom;
        };
        const tabs = Array.from(document.querySelectorAll(".qtab")).map((el) => {
          const r = el.getBoundingClientRect(); return { w: r.width, h: r.height };
        });
        const search = document.querySelector(".qsearch-btn");
        const filters = document.querySelector(".qfilter > summary");
        const rowEls = Array.from(document.querySelectorAll(".qtab")).concat(search ? [search] : []);
        const gaps = [];
        for (let i = 0; i + 1 < rowEls.length; i++) gaps.push(gap(rowEls[i], rowEls[i + 1]));
        if (search && filters) gaps.push(gap(search, filters));
        return { tabs, gaps };
      });
      const tabsOk = probe.tabs.length > 0 && probe.tabs.every((t) => t.w >= 44 && t.h >= 44);
      const gapsOk = probe.gaps.every((g) => g < 0 || g >= 8);
      push("qtabs-375", tabsOk && gapsOk, { probe });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- 5: search, 393 and 375 --------------------------------------------------------
  for (const width of [w393, w375]) {
    const page = await openPage(ctx, width, "queue-search-open");
    try {
      const before = await page.evaluate(() => {
        const q = document.getElementById("q");
        const cs = getComputedStyle(q);
        const r = q.getBoundingClientRect();
        return { fontSize: parseFloat(cs.fontSize), h: r.height, focused: document.activeElement === q, initialCount: document.querySelectorAll("#qlist a.qcard").length };
      });
      await page.type("#q", "zzqqxx", { delay: 5 });
      await new Promise((r) => setTimeout(r, 150));
      const afterType = await page.evaluate(() => {
        const es = document.getElementById("qemptySearch");
        const qc = document.getElementById("qclear");
        const esVisible = es && !es.hidden;
        const esText = es ? es.querySelector("p").textContent : "";
        const qcH = qc ? qc.getBoundingClientRect().height : 0;
        return { esVisible, esText, qcH };
      });
      await page.click("#qclear");
      await new Promise((r) => setTimeout(r, 150));
      const afterClear = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll("#qlist a.qcard"));
        return { visibleCount: cards.filter((c) => c.style.display !== "none").length };
      });
      const ok = before.fontSize === 16 && before.h >= 44 && before.focused
        && afterType.esVisible && afterType.esText.includes("zzqqxx") && afterType.qcH >= 44
        && afterClear.visibleCount === before.initialCount;
      push("search-" + width.width, ok, { before, afterType, afterClear });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- 6: filters sheet, 393 and 375, plus a 1440 order capture ----------------------
  {
    const desktop = await newPage(ctx.browser, { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false, lang: "en", baseUrl: ctx.baseUrl });
    let order1440 = [];
    try {
      await openScene(desktop.page, ctx.baseUrl, findScene("queue-open"));
      await desktop.page.select("#qsort", "new");
      await desktop.page.evaluate(() => document.getElementById("qsort").dispatchEvent(new Event("change")));
      await new Promise((r) => setTimeout(r, 150));
      order1440 = await desktop.page.evaluate(() => Array.from(document.querySelectorAll("#qlist a.qcard")).map((a) => a.getAttribute("href")));
    } finally { await desktop.page.close().catch(() => {}); }

    for (const width of [w393, w375]) {
      const page = await openPage(ctx, width, "queue-filter");
      try {
        const rowsProbe = await page.evaluate(() => {
          const qfilter = document.querySelector("details.qfilter .menu-list");
          const rowH = (sel) => { const el = qfilter.querySelector(sel); return el ? el.getBoundingClientRect().height : null; };
          const sortSel = document.getElementById("qsortm");
          return {
            mailboxRow: rowH(".mlabel"),
            scopeRow: rowH(".segrow"),
            sortH: sortSel ? sortSel.getBoundingClientRect().height : null,
            sortOptions: sortSel ? sortSel.options.length : 0,
            syncH: (() => { const b = qfilter.querySelector('form[action="/sync"] button'); return b ? b.getBoundingClientRect().height : null; })(),
          };
        });
        await page.select("#qsortm", "new");
        await page.evaluate(() => document.getElementById("qsortm").dispatchEvent(new Event("change")));
        await new Promise((r) => setTimeout(r, 150));
        const orderMobile = await page.evaluate(() => Array.from(document.querySelectorAll("#qlist a.qcard")).map((a) => a.getAttribute("href")));
        const sameOrder = JSON.stringify(orderMobile) === JSON.stringify(order1440);
        const ok = rowsProbe.sortOptions === 4 && (rowsProbe.sortH || 0) >= 44 && (rowsProbe.syncH || 0) >= 44 && sameOrder;
        push("filters-sheet-" + width.width, ok, { rowsProbe, order1440, orderMobile });
      } finally { await page.close().catch(() => {}); }
    }
  }

  // ---- 7: new email button, 393 and 375 ----------------------------------------------
  for (const width of [w393, w375]) {
    const page = await openPage(ctx, width, "queue-open");
    try {
      const before = await page.evaluate(() => {
        const btn = document.getElementById("composeBtn");
        const cs = getComputedStyle(btn);
        const r = btn.getBoundingClientRect();
        return { position: cs.position, height: r.height, rightGap: window.innerWidth - r.right };
      });
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await new Promise((r) => setTimeout(r, 100));
      const after = await page.evaluate(() => {
        const btn = document.getElementById("composeBtn");
        const cards = document.querySelectorAll("#qlist a.qcard");
        const last = cards[cards.length - 1];
        if (!btn || !last) return { intersects: null };
        const a = btn.getBoundingClientRect(), b = last.getBoundingClientRect();
        const intersects = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        return { intersects };
      });
      const ok = before.position === "fixed" && Math.abs(before.height - 56) < 1 && Math.abs(before.rightGap - 16) < 1 && after.intersects === false;
      push("compose-btn-" + width.width, ok, { before, after });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- 8: every open sheet's list fills the viewport, 393 and 375 --------------------
  const sheetScenes = ["queue-filter", "queue-appmenu", "item-more-actions", "item-recipient", "item-language"];
  for (const width of [w393, w375]) {
    for (const sceneId of sheetScenes) {
      const page = await openPage(ctx, width, sceneId);
      try {
        const probe = await page.evaluate(() => {
          const list = document.querySelector("details[open] > .menu-list, details[open] > .chipmenu-list");
          if (!list) return null;
          const r = list.getBoundingClientRect();
          return { left: r.left, right: r.right, bottom: r.bottom, innerWidth: window.innerWidth, innerHeight: window.innerHeight, inlinePosition: list.style.position };
        });
        const ok = !!probe && Math.abs(probe.left - 0) <= 1 && Math.abs(probe.right - probe.innerWidth) <= 1
          && Math.abs(probe.bottom - probe.innerHeight) <= 1 && probe.inlinePosition === "";
        push("sheet-fills-viewport-" + sceneId + "-" + width.width, ok, { probe });
      } finally { await page.close().catch(() => {}); }
    }
  }

  // ---- 9: recipient sheet, 393 and 375 -------------------------------------------------
  for (const width of [w393, w375]) {
    const page = await openPage(ctx, width, "item-recipient");
    try {
      await openDetails(page, "details.recip-other");
      const probe = await page.evaluate(() => {
        const opts = Array.from(document.querySelectorAll(".recip-pop .cfopt")).map((el) => {
          const r = el.getBoundingClientRect();
          const radio = el.querySelector('input[type=radio]');
          const rr = radio ? radio.getBoundingClientRect() : null;
          return { h: r.height, radio: rr ? { w: rr.width, h: rr.height } : null };
        });
        const email = document.querySelector(".recip-other input[type=email]");
        const emailR = email ? email.getBoundingClientRect() : null;
        const emailCs = email ? getComputedStyle(email) : null;
        const list = document.querySelector("details.recip-pop .menu-list");
        const listR = list ? list.getBoundingClientRect() : null;
        return {
          opts,
          email: email ? { fontSize: parseFloat(emailCs.fontSize), h: emailR.height } : null,
          listWidth: listR ? listR.width : null,
          innerWidth: window.innerWidth,
        };
      });
      const optsOk = probe.opts.length > 0 && probe.opts.every((o) => o.h >= 44 && o.radio && o.radio.w >= 20 && o.radio.h >= 20);
      const emailOk = !!probe.email && probe.email.fontSize === 16 && probe.email.h >= 44;
      const listOk = probe.listWidth !== null && Math.abs(probe.listWidth - probe.innerWidth) <= 1;
      push("recipient-sheet-" + width.width, optsOk && emailOk && listOk, { probe });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- 10: more actions sheet close row, 393 and 375 -----------------------------------
  for (const width of [w393, w375]) {
    const page = await openPage(ctx, width, "item-more-actions");
    try {
      const before = await page.evaluate(() => {
        const btn = document.querySelector("details.menu[open] [data-close]");
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        const cs = getComputedStyle(btn);
        return { h: r.height, visible: cs.display !== "none" && cs.visibility !== "hidden" };
      });
      await page.evaluate(() => { const b = document.querySelector("details.menu[open] [data-close]"); if (b) b.click(); });
      await new Promise((r) => setTimeout(r, 100));
      const closed = await page.evaluate(() => {
        const open = document.querySelector(".actionbar details.menu[open]:not(.recip-pop)");
        return !open;
      });
      const ok = !!before && before.h >= 44 && before.visible && closed;
      push("more-actions-close-" + width.width, ok, { before, closed });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- 11: /blocks, /audit, /sprocket/requests, 393 and 375 ---------------------------
  for (const width of [w393, w375]) {
    for (const scenePath of [{ id: "blocks", path: "/blocks", hasTable: true }, { id: "audit", path: "/audit", hasTable: true }, { id: "sprocket-requests", path: "/sprocket/requests", hasTable: false }]) {
      const { page } = await newPage(ctx.browser, { width: width.width, height: width.height, deviceScaleFactor: 1, isMobile: true, hasTouch: true, lang: "en", baseUrl: ctx.baseUrl });
      try {
        await page.goto(ctx.baseUrl + scenePath.path, { waitUntil: "networkidle0" });
        await new Promise((r) => setTimeout(r, 100));
        const probe = await page.evaluate((hasTable) => {
          const note = document.querySelector(".desktop-note");
          const noteR = note ? note.getBoundingClientRect() : null;
          const out = {
            scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth,
            noteVisible: !!noteR && noteR.width > 0 && noteR.height > 0,
          };
          if (hasTable) {
            const hs = document.querySelector(".hscroll");
            out.hscroll = hs ? { scrollWidth: hs.scrollWidth, clientWidth: hs.clientWidth } : null;
          }
          return out;
        }, scenePath.hasTable);
        const ok = probe.scrollWidth === probe.innerWidth && probe.noteVisible
          && (!scenePath.hasTable || (probe.hscroll && probe.hscroll.scrollWidth > probe.hscroll.clientWidth));
        push(scenePath.id + "-desktop-note-" + width.width, ok, { probe });
      } finally { await page.close().catch(() => {}); }
    }
  }

  // ---- 12: block page, 393 and 375 -----------------------------------------------------
  for (const width of [w393, w375]) {
    const { page } = await newPage(ctx.browser, { width: width.width, height: width.height, deviceScaleFactor: 1, isMobile: true, hasTouch: true, lang: "en", baseUrl: ctx.baseUrl });
    try {
      await page.goto(ctx.baseUrl + "/item/1/block", { waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 100));
      const probe = await page.evaluate(() => {
        const back = document.querySelector("a.m-back");
        const backR = back ? back.getBoundingClientRect() : null;
        const backCs = back ? getComputedStyle(back) : null;
        const cancel = document.querySelector(".block-cancel");
        const cancelR = cancel ? cancel.getBoundingClientRect() : null;
        const primary = document.querySelector("button.primary");
        const primaryR = primary ? primary.getBoundingClientRect() : null;
        let gap = null, sameRow = false;
        if (cancelR && primaryR) {
          const overlapTop = Math.max(cancelR.top, primaryR.top), overlapBottom = Math.min(cancelR.bottom, primaryR.bottom);
          sameRow = (overlapBottom - overlapTop) > 0.5 * Math.min(cancelR.height, primaryR.height);
          if (sameRow) {
            gap = primaryR.right <= cancelR.left ? cancelR.left - primaryR.right
              : cancelR.right <= primaryR.left ? primaryR.left - cancelR.right : 0;
          }
        }
        return {
          back: back ? { h: backR.height, top: backR.top, position: backCs.position, href: back.getAttribute("href") } : null,
          cancelH: cancelR ? cancelR.height : null,
          sameRow, gap,
        };
      });
      const backOk = !!probe.back && probe.back.h >= 44 && probe.back.top <= 100 && probe.back.position === "sticky" && probe.back.href === "/item/1";
      const cancelOk = probe.cancelH !== null && probe.cancelH >= 44;
      const spacingOk = !probe.sameRow || (probe.gap !== null && probe.gap >= 8);
      push("block-page-" + width.width, backOk && cancelOk && spacingOk, { probe });
    } finally { await page.close().catch(() => {}); }
  }

  const pass = results.every((r) => r.pass);
  return { phase: "1a", pass, assertions: results };
}

module.exports = { assert };
