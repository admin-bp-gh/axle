// phase-4.js - Phase 4 acceptance assertions (mobile plan section 3.8, the Acceptance table).
// Exports `async function assert(ctx)`, same shape as phase-3.js. Covers M-52 (the card-tap
// skeleton detail and its bar placeholder), M-53 (customer page, translation and upload
// skeletons), M-55 (busy item: banner, skeleton reply, bar placeholder, scroll kept across
// the busy poll, flip to ready), ESC and focus handling, NL parity at 375, and the desktop
// row that is not a pixel diff (a card tap at 1440 keeps the overlay, never the skeleton).
// The pixel/layout/DOM diff itself is the separate `compare` run.
//
// Fixtures (harness/mobile/boot.js, phase "4"): everything phase 3 seeds, plus item 301
// "Investigating fixture" (a copy of item 2, set to 'investigating' after the boot).
//
// Shortcuts, documented:
//  - The 3 s delay on GET /item/:id: a second, short-lived server booted with
//    AXLE_HARNESS_DELAY_ITEM=1 and AXLE_HARNESS_DELAY_MS=3000 (extra-stubs.js holds the
//    request 3 s in front of the app), so the shared server stays undelayed.
//  - "Within one animation frame of the tap": a capture-phase click listener installed
//    before the tap schedules a requestAnimationFrame callback, which records the DOM state
//    before the next paint. After that the state is sampled every 50 ms until the item lands.
//  - Customer page, translation and upload loading states: the request that would end the
//    loading state (/customer-modal GET, /translations POST, /attach-add POST) is intercepted
//    and never answered, so the loading markup stays on screen while it is measured.
//  - Upload: a small File is put on the real #att_file input through a DataTransfer and a
//    change event is dispatched, which runs the page's own addFiles() path.
//  - Busy poll: instead of waiting 10 s for `hx-trigger="load delay:10s"`, the assertion
//    issues the same request from the poller div itself: htmx.ajax("GET", "/item/301",
//    { source: <the poller div>, target: "#workpane", swap: "innerHTML" }). The request's
//    elt is that div, so the page's M-55 handler sees exactly what the natural poll gives it.
//  - Flip to ready: item 301's status and a new ai draft row are written straight into the
//    running server's temp DB (ctx.dbPath) with node:sqlite, then the poll is issued as above.
//    The item is set back to investigating (and the draft removed) afterwards.
//  - NL: the earlier phases' modules hard-code lang "en" in their page helpers, so the NL
//    rerun is this module's own NL checks (plan 3.8 row "375 (NL)"): STRINGS key counts, the
//    NL walk (<out>/nl/walk.json, from `walk --phase 4 --lang nl --widths 375x812`) for the
//    horizontal scroll row (a live pass over every scene if that file is missing), and live
//    NL pages for the clipped-button and tab-count rows.
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { DatabaseSync } = require("node:sqlite");
const { newPage } = require("./pptr.js");
const { bootServer } = require("./boot.js");
const { SCENES, findScene, openScene, holdRequests } = require("./scenes.js");

const HDR = { "Tailscale-User-Login": "admin@budget-parts.nl" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DELAY_MS = 3000;

function widthByPx(ctx, px) {
  const w = ctx.widths.find((x) => x.width === px);
  if (!w) throw new Error("phase-4 needs a --widths entry at " + px + "px");
  return w;
}

function httpGet(baseUrl, p, extraHeaders) {
  return new Promise((resolve, reject) => {
    const req = http.get(baseUrl + p, { headers: { ...HDR, ...(extraHeaders || {}) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, bytes: buf.length, body: buf.toString("utf8") }); });
    });
    req.on("error", reject);
  });
}

async function phonePage(ctx, width, opts) {
  return newPage(ctx.browser, {
    width: width.width, height: width.height, deviceScaleFactor: 1,
    isMobile: true, hasTouch: true, lang: (opts && opts.lang) || "en", baseUrl: (opts && opts.baseUrl) || ctx.baseUrl,
  });
}

async function deskPage(ctx, w, h, baseUrl) {
  return newPage(ctx.browser, { width: w, height: h, deviceScaleFactor: 1, isMobile: false, hasTouch: false, lang: "en", baseUrl: baseUrl || ctx.baseUrl });
}

async function idle(page) {
  try { await page.waitForNetworkIdle({ idleTime: 250, timeout: 6000 }); } catch (e) { /* best effort */ }
}

// waitUntil "networkidle0" never resolves while a request is held, so pages that hold one
// from the start load with "load" and then wait for htmx.
async function go(page, url, held) {
  await page.goto(url, { waitUntil: held ? "load" : "networkidle0" });
  try { await page.waitForFunction(() => !!window.htmx, { timeout: 5000 }); } catch (e) { /* recorded by the probe */ }
  await sleep(held ? 300 : 100);
}

// In-page helpers, injected as a string so every evaluate can use them.
const VIS_FN = "function __vis(el){ if(!el) return false; if(el.checkVisibility && !el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false; var r=el.getBoundingClientRect(); return r.width>0 && r.height>0; }"
  + "function __rect(el){ if(!el) return null; var r=el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }";
async function inject(page) { await page.evaluate(VIS_FN + "window.__vis=__vis; window.__rect=__rect;"); }

function rectEq(a, b, tol) {
  if (!a || !b) return false;
  return ["x", "y", "w", "h"].every((k) => Math.abs(a[k] - b[k]) <= tol);
}

// Arms the tap probe: on the next click, a rAF callback records the state before the next
// paint, then the state is sampled every 50 ms until the real item lands (or 8 s pass).
async function armTapProbe(page) {
  await page.evaluate(() => {
    window.__p4 = { samples: [] };
    function st() {
      const wp = document.getElementById("workpane"), qp = document.getElementById("queuepane");
      const sk = document.querySelector("#workpane .sk-detail");
      const r = sk ? sk.getBoundingClientRect() : null;
      const bar = document.querySelector("#workpane .actionbar.sk-bar");
      const br = bar ? bar.getBoundingClientRect() : null;
      return {
        sk: !!sk, skVisible: !!r && r.height > 0 && r.width > 0 && getComputedStyle(wp).display !== "none",
        real: !!document.querySelector("#workpane .has-item:not(.sk-detail)"),
        axDetail: document.body.classList.contains("ax-detail"),
        wpLoading: wp ? wp.classList.contains("ax-loading") : null,
        qpDisplay: qp ? getComputedStyle(qp).display : null,
        skBar: br ? { x: br.left, y: br.top, w: br.width, h: br.height } : null,
        title: (document.querySelector("#workpane .sk-detail .m-back-title") || { textContent: null }).textContent,
      };
    }
    document.addEventListener("click", function () {
      const t0 = performance.now();
      window.__p4.t0 = t0;
      requestAnimationFrame(function () { const s = st(); s.dt = performance.now() - t0; window.__p4.frame = s; });
      const iv = setInterval(function () {
        const s = st(); s.t = performance.now() - t0;
        window.__p4.samples.push(s);
        if (s.real || s.t > 8000) clearInterval(iv);
      }, 50);
    }, { capture: true, once: true });
  });
}

function setItem301(ctx, ready) {
  const d = new DatabaseSync(ctx.dbPath);
  try {
    if (ready) {
      d.prepare("UPDATE work_items SET status = 'ready' WHERE id = 301").run();
      d.prepare("INSERT INTO drafts (work_item_id, version, is_interim, body, source) VALUES (301, 1, 0, ?, 'ai')").run("Beste Jan,\n\nDit is de harness-flip draft.\n\nMet vriendelijke groet");
    } else {
      d.prepare("DELETE FROM drafts WHERE work_item_id = 301").run();
      d.prepare("UPDATE work_items SET status = 'investigating' WHERE id = 301").run();
    }
  } finally { d.close(); }
}

// Issues the busy poll from the poller div itself (see the header: the 10 s shortcut) and
// waits until the swap replaced the marked node.
async function busyPoll(page, itemId) {
  const fired = await page.evaluate((id) => {
    const div = document.querySelector('#workpane [hx-trigger="load delay:10s"]') || document.querySelector('[hx-trigger="load delay:10s"]');
    if (!div) return false;
    const m = document.querySelector("#workpane .pane-center");
    if (m) m.__p4old = 1;
    window.htmx.ajax("GET", "/item/" + id, { source: div, target: "#workpane", swap: "innerHTML" });
    return true;
  }, itemId);
  if (fired) {
    try { await page.waitForFunction(() => { const m = document.querySelector("#workpane .pane-center"); return !!m && !m.__p4old; }, { timeout: 8000 }); } catch (e) { /* probe */ }
  }
  await idle(page);
  await sleep(200);
  return fired;
}

const GROUPS = ["m52", "m53", "m55", "esc", "nl", "desktop"];

async function assert(ctx) {
  const results = [];
  const push = (id, pass, detail) => results.push({ id, pass: !!pass, detail });
  const want = (g) => !ctx.only || ctx.only.includes(g);
  const w393 = widthByPx(ctx, 393);
  const w375 = widthByPx(ctx, 375);

  // ================= M-52 (393, 375) and the 1440 desktop row: the delay server =================
  if (want("m52") || want("desktop")) {
    const delaySrv = await bootServer({ tree: ctx.tree, phase: "4", env: { AXLE_HARNESS_DELAY_ITEM: "1", AXLE_HARNESS_DELAY_MS: String(DELAY_MS) } });
    try {
      if (want("m52")) {
        for (const width of [w393, w375]) {
          const { page } = await phonePage(ctx, width, { baseUrl: delaySrv.baseUrl });
          try {
            await go(page, delaySrv.baseUrl + "/");
            await page.evaluate(() => { const a = document.querySelector('a.qcard[href="/item/1"]'); if (a) a.scrollIntoView({ block: "center" }); });
            await armTapProbe(page);
            const tClick = Date.now();
            await page.click('a.qcard[href="/item/1"]');
            try { await page.waitForFunction(() => !!document.querySelector("#workpane .has-item:not(.sk-detail)"), { timeout: DELAY_MS + 8000 }); } catch (e) { /* probe */ }
            const elapsed = Date.now() - tClick;
            await idle(page);
            await sleep(200);
            const p = await page.evaluate(() => {
              const b = document.querySelector("#workpane .actionbar:not(.sk-bar)");
              const r = b ? b.getBoundingClientRect() : null;
              return { p4: window.__p4, loadedBar: r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null, skLeft: !!document.querySelector("#workpane .sk-detail") };
            });
            const s = p.p4.samples;
            const firstReal = s.findIndex((x) => x.real);
            const before = firstReal < 0 ? s : s.slice(0, firstReal);
            const gaps = before.filter((x) => !x.sk || !x.skVisible || !x.axDetail);
            const landT = firstReal >= 0 ? s[firstReal].t : null;
            const f = p.p4.frame || null;
            const frameOk = !!f && f.sk && f.skVisible && f.axDetail && f.qpDisplay === "none" && f.wpLoading === false;
            push("P4-M52-skeleton-within-frame-" + width.width,
              frameOk && gaps.length === 0 && landT !== null && landT >= DELAY_MS - 150 && !p.skLeft,
              { frame: f, samplesBeforeLand: before.length, gapSamples: gaps.slice(0, 5), landedAtMs: landT, elapsedMs: elapsed, skeletonLeftAfterLand: p.skLeft });
            const skBars = before.map((x) => x.skBar).filter(Boolean);
            const skBar = skBars.length ? skBars[skBars.length - 1] : null;
            const stable = skBars.every((r) => rectEq(r, skBar, 0.5));
            push("P4-M52-bar-rect-equal-" + width.width, rectEq(skBar, p.loadedBar, 1) && stable,
              { skeletonBar: skBar, loadedBar: p.loadedBar, skeletonBarStableDuringWait: stable, samples: skBars.length });
          } finally { await page.close().catch(() => {}); }
        }
      }

      // Desktop 1440: a card tap keeps the dimmed overlay (ax-loading on #workpane) and never
      // writes the skeleton, for the full 3 s wait and after the item lands.
      if (want("desktop")) {
        const { page } = await deskPage(ctx, 1440, 900, delaySrv.baseUrl);
        try {
          await go(page, delaySrv.baseUrl + "/");
          await armTapProbe(page);
          await page.click('a.qcard[href="/item/1"]');
          try { await page.waitForFunction(() => !!document.querySelector("#workpane .has-item:not(.sk-detail)"), { timeout: DELAY_MS + 8000 }); } catch (e) { /* probe */ }
          await idle(page);
          const p = await page.evaluate(() => ({ p4: window.__p4, skNow: !!document.querySelector(".sk-detail"), wpLoadingNow: document.getElementById("workpane").classList.contains("ax-loading"), axDetail: document.body.classList.contains("ax-detail") }));
          const s = p.p4.samples;
          const firstReal = s.findIndex((x) => x.real);
          const before = firstReal < 0 ? s : s.slice(0, firstReal);
          const f = p.p4.frame || null;
          const everSk = s.some((x) => x.sk);
          const overlayHeld = before.length > 0 && before.every((x) => x.wpLoading === true);
          push("P4-desktop-no-skeleton-1440", !!f && f.wpLoading === true && !f.sk && !everSk && overlayHeld && !p.skNow && firstReal >= 0,
            { frame: f, everSkeleton: everSk, overlayHeldDuringWait: overlayHeld, samplesBeforeLand: before.length, landedAtMs: firstReal >= 0 ? s[firstReal].t : null, afterLand: { skeleton: p.skNow, wpLoading: p.wpLoadingNow, axDetail: p.axDetail } });
        } finally { await page.close().catch(() => {}); }
      }
    } finally { await delaySrv.stop(); }
  }

  // ================= M-53: skeleton blocks, not spinners (393) =================
  if (want("m53")) {
    // customer page, /customer-modal held
    {
      const { page } = await phonePage(ctx, w393);
      try {
        await go(page, ctx.baseUrl + "/item/1");
        await page.click(".ctxlink").catch(() => {});
        await sleep(200);
        const held = await holdRequests(page, "/item/1/customer-modal");
        await page.click("button.cusbtn").catch(() => {});
        await sleep(400);
        await inject(page);
        const p = await page.evaluate(() => {
          const body = document.getElementById("cusModalBody"), dlg = document.getElementById("cusModal");
          const sk = body && body.querySelector(".sk-lines"), spin = body && body.querySelector(".spin");
          return { dialogOpen: !!(dlg && dlg.open), skVisible: __vis(sk), skRect: __rect(sk), skLines: sk ? sk.querySelectorAll(".sk").length : 0, spinExists: !!spin, spinVisible: __vis(spin), dialogRect: __rect(dlg) };
        });
        push("P4-M53-customer-skeleton", held.length >= 1 && p.dialogOpen && p.skVisible && p.skLines === 3 && !p.spinVisible, { heldRequests: held.length, ...p });
      } finally { await page.close().catch(() => {}); }
    }
    // translation: item 1 is German, the harness user reads English, the translate stub's
    // cached() is always null, so the page renders the pending placeholder and POSTs
    // /item/1/translations on load; that POST is held.
    {
      const raw = await httpGet(ctx.baseUrl, "/item/1");
      const m = /<pre class="mail" id="emailtrpre"[^>]*>([\s\S]*?)<\/pre>/.exec(raw.body);
      const serverMarkup = { pendingAttr: /id="emailtrpre" data-pending="1"/.test(raw.body), spinMHide: !!m && /<span class="spin m-hide"><\/span>/.test(m[1]), skLines: !!m && /<span class="m-only sk-lines" aria-hidden="true">(<span class="sk"><\/span>){3}<\/span>/.test(m[1]) };
      const { page } = await phonePage(ctx, w393);
      try {
        const held = await holdRequests(page, "/item/1/translations");
        await go(page, ctx.baseUrl + "/item/1", true);
        const pend = await page.evaluate(() => !!document.querySelector("#emailtrpre[data-pending]"));
        await page.evaluate(() => { const b = document.getElementById("emailtrbtn"); if (b) b.scrollIntoView({ block: "center" }); });
        let how = "click";
        await page.click("#emailtrbtn").catch(() => { how = "evaluate"; });
        await sleep(150);
        let shown = await page.evaluate(() => { const e = document.getElementById("emailtr"); return !!e && e.style.display !== "none"; });
        if (!shown) { how = "toggleEmailTr()"; await page.evaluate(() => { if (typeof toggleEmailTr === "function") toggleEmailTr(); }); await sleep(150); }
        await inject(page);
        const p = await page.evaluate(() => {
          const pre = document.getElementById("emailtrpre");
          const sk = pre && pre.querySelector(".sk-lines"), spin = pre && pre.querySelector(".spin");
          return { pending: !!(pre && pre.hasAttribute("data-pending")), boxShown: getComputedStyle(document.getElementById("emailtr")).display !== "none", skVisible: __vis(sk), skRect: __rect(sk), skDisplay: sk ? getComputedStyle(sk).display : null, spinExists: !!spin, spinVisible: __vis(spin), preRect: __rect(pre) };
        });
        push("P4-M53-translation-skeleton", pend && held.length >= 1 && p.pending && p.boxShown && p.skVisible && !p.spinVisible && serverMarkup.pendingAttr && serverMarkup.skLines,
          { fixture: "/item/1 (de, viewer en)", heldRequests: held.map((r) => r.method() + " " + new URL(r.url()).pathname), toggle: how, ...p, serverMarkup });
      } finally { await page.close().catch(() => {}); }
    }
    // upload: the real #att_file change path with a small File, /attach-add held
    {
      const { page } = await phonePage(ctx, w393);
      try {
        await go(page, ctx.baseUrl + "/item/1");
        const held = await holdRequests(page, "/item/1/attach-add");
        const trig = await page.evaluate(() => {
          const inp = document.getElementById("att_file");
          if (!inp) return { input: false };
          const dt = new DataTransfer();
          dt.items.add(new File(["harness upload"], "harness-p4.txt", { type: "text/plain" }));
          inp.files = dt.files;
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          return { input: true, files: inp.files.length };
        });
        await sleep(500);
        await inject(page);
        const p = await page.evaluate(() => {
          const bz = document.getElementById("attbusy");
          if (bz) bz.scrollIntoView({ block: "center" });
          const sk = bz && bz.querySelector(".sk-lines"), spin = bz && bz.querySelector(".spin");
          return { attbusy: !!bz, skVisible: __vis(sk), skRect: __rect(sk), skLines: sk ? sk.querySelectorAll(".sk").length : 0, spinExists: !!spin, spinVisible: __vis(spin), text: bz ? bz.textContent.trim() : null, html: bz ? bz.innerHTML.slice(0, 300) : null };
        });
        push("P4-M53-upload-skeleton", trig.input && held.length >= 1 && p.attbusy && p.skVisible && !p.spinExists,
          { method: "DataTransfer File on #att_file + change event (the page's own addFiles path)", trigger: trig, heldRequests: held.length, ...p });
      } finally { await page.close().catch(() => {}); }
    }
  }

  // ================= M-55: the busy item (393) =================
  if (want("m55")) {
    setItem301(ctx, false);
    // banner + skeleton reply + a bar placeholder the height of the ready bar
    {
      const { page } = await phonePage(ctx, w393);
      try {
        await go(page, ctx.baseUrl + "/item/1");
        const ready = await page.evaluate(() => { const b = document.querySelector("#workpane .actionbar:not(.sk-bar)"); const r = b && b.getBoundingClientRect(); return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null; });
        await go(page, ctx.baseUrl + "/item/301");
        await inject(page);
        const p = await page.evaluate(() => {
          const banner = document.querySelector("#workpane .banner.busy");
          const sk = document.querySelector("#workpane .box .sk-lines");
          const bar = document.querySelector("#workpane .actionbar.sk-bar");
          const send = bar && bar.querySelector("button.send");
          return { bannerVisible: __vis(banner), skVisible: __vis(sk), skRect: __rect(sk), bar: __rect(bar), barVisible: __vis(bar), sendDisabled: !!(send && send.disabled), realBar: !!document.querySelector("#workpane .actionbar:not(.sk-bar)") };
        });
        push("P4-M55-investigating-banner-skeleton-bar", p.bannerVisible && p.skVisible && p.barVisible && p.sendDisabled && !p.realBar && !!ready && Math.abs(p.bar.h - ready.h) <= 1,
          { ...p, readyBarOnItem1: ready });
      } finally { await page.close().catch(() => {}); }
    }
    // scroll kept across a busy-poll swap
    {
      const { page } = await phonePage(ctx, w393);
      try {
        await go(page, ctx.baseUrl + "/item/301");
        await page.evaluate(() => window.scrollTo(0, 300));
        await sleep(150);
        const y0 = await page.evaluate(() => window.scrollY);
        const reqs = [];
        page.on("request", (r) => { try { if (new URL(r.url()).pathname === "/item/301") reqs.push(r.method()); } catch (e) { /* ignore */ } });
        const fired = await busyPoll(page, 301);
        const st = await page.evaluate(() => ({ y: window.scrollY, busy: !!document.querySelector("#workpane .banner.busy"), sh: document.documentElement.scrollHeight }));
        push("P4-M55-busy-poll-scroll-kept", y0 === 300 && fired && reqs.length >= 1 && st.busy && Math.abs(st.y - y0) <= 2,
          { shortcut: "htmx.ajax from the poller div (source = div)", before: y0, after: st.y, pollRequests: reqs, stillBusy: st.busy, scrollHeight: st.sh });
      } finally { await page.close().catch(() => {}); }
    }
    // flip to ready with a draft: the reply lands in the slot, everything above keeps its place
    {
      const { page } = await phonePage(ctx, w393);
      try {
        await go(page, ctx.baseUrl + "/item/301");
        const snap = () => page.evaluate(() => {
          const inner = document.querySelector("#workpane .pane-center > .pane-inner");
          const sig = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + "." + Array.from(el.classList).sort().join(".");
          const list = [];
          const back = document.querySelector("#workpane .pane-center > a.m-back");
          if (back) { const r = back.getBoundingClientRect(); list.push({ sig: "a.m-back", top: r.top + scrollY, h: r.height }); }
          if (inner) for (const c of inner.children) { const r = c.getBoundingClientRect(); if (r.height === 0) continue; list.push({ sig: sig(c), top: r.top + scrollY, h: r.height, order: getComputedStyle(c).order }); }
          const rb = document.getElementById("replybox"), sk = document.querySelector("#workpane .box .sk-lines");
          const slotEl = sk ? sk.closest(".box") : null;
          const slot = slotEl ? slotEl.getBoundingClientRect().top + scrollY : null;
          const rr = rb ? rb.getBoundingClientRect() : null;
          return { list, slotTop: slot, reply: rr ? { top: rr.top + scrollY, h: rr.height } : null, y: scrollY };
        });
        const before = await snap();
        // elements above the slot: everything that sits above it on screen, except the busy
        // banner (the plan's busy state is "banner plus skeleton reply"; the banner leaves by design)
        const above = before.list.filter((e) => before.slotTop !== null && e.top + e.h <= before.slotTop + 0.5 && !/banner/.test(e.sig));
        setItem301(ctx, true);
        let fired;
        try { fired = await busyPoll(page, 301); } finally { /* restored below */ }
        const after = await snap();
        const moved = above.map((e) => {
          const a = after.list.find((x) => x.sig === e.sig);
          return { sig: e.sig, before: e.top, after: a ? a.top : null, beforeH: e.h, afterH: a ? a.h : null, ok: !!a && Math.abs(a.top - e.top) <= 2 };
        });
        push("P4-M55-flip-to-ready-keeps-positions", fired && !!after.reply && moved.length > 0 && moved.every((m) => m.ok),
          { shortcut: "status + ai draft written to the DB, then htmx.ajax from the poller div", slotTopBefore: before.slotTop, replyAfter: after.reply, aboveSlot: moved, bannerBefore: before.list.find((e) => /banner/.test(e.sig)) || null });
        setItem301(ctx, false);
      } finally { await page.close().catch(() => {}); setItem301(ctx, false); }
    }
  }

  // ================= ESC and focus (393, 1440) =================
  if (want("esc")) {
    const MORE = ".actionbar > details.menu:not(.recip-pop)";
    // the More actions sheet: ESC closes it at 393 and 1440; focus moves in and back at 393
    for (const [label, mk] of [["393", () => phonePage(ctx, w393)], ["1440", () => deskPage(ctx, 1440, 900)]]) {
      const { page } = await mk();
      try {
        await go(page, ctx.baseUrl + "/item/1");
        await page.click(MORE + " > summary");
        await sleep(200);
        const opened = await page.evaluate((sel) => {
          const d = document.querySelector(sel), a = document.activeElement;
          return { open: !!(d && d.open), activeInside: !!(d && a && d.contains(a) && a !== d.querySelector("summary")), active: a ? (a.tagName.toLowerCase() + (a.className ? "." + String(a.className).replace(/\s+/g, ".") : "")) : null, activeText: a ? (a.textContent || "").trim().slice(0, 40) : null };
        }, MORE);
        await page.keyboard.press("Escape");
        await sleep(200);
        const closed = await page.evaluate((sel) => {
          const d = document.querySelector(sel), a = document.activeElement;
          return { open: !!(d && d.open), activeIsTrigger: !!(d && a === d.querySelector("summary")), active: a ? (a.tagName.toLowerCase() + (a.className ? "." + String(a.className).replace(/\s+/g, ".") : "")) : null };
        }, MORE);
        push("P4-ESC-closes-sheet-" + label, opened.open && !closed.open, { opened, closed });
        if (label === "393") {
          push("P4-focus-in-sheet-on-open-393", opened.open && opened.activeInside, opened);
          push("P4-focus-back-to-trigger-on-close-393", !closed.open && closed.activeIsTrigger, closed);
        }
      } finally { await page.close().catch(() => {}); }
    }
    // the context sheet (393)
    {
      const { page } = await phonePage(ctx, w393);
      try {
        await go(page, ctx.baseUrl + "/item/1");
        await page.click(".ctxlink").catch(() => {});
        await sleep(200);
        const before = await page.evaluate(() => document.body.classList.contains("ax-ctx"));
        await page.keyboard.press("Escape");
        await sleep(250);
        const after = await page.evaluate(() => ({ axCtx: document.body.classList.contains("ax-ctx"), ctxDisplay: getComputedStyle(document.querySelector("#workpane .pane-context")).display }));
        push("P4-ESC-closes-context-393", before && !after.axCtx, { before, after });
      } finally { await page.close().catch(() => {}); }
    }
    // the customer page (393): the native <dialog> closes itself on ESC
    {
      const { page } = await phonePage(ctx, w393);
      try {
        await go(page, ctx.baseUrl + "/item/1");
        await page.click(".ctxlink").catch(() => {});
        await sleep(200);
        await page.click("button.cusbtn").catch(() => {});
        try { await page.waitForFunction(() => !!document.querySelector("#cusModalBody .cusmodttl"), { timeout: 8000 }); } catch (e) { /* probe */ }
        const before = await page.evaluate(() => !!document.getElementById("cusModal").open);
        await page.keyboard.press("Escape");
        await sleep(250);
        const after = await page.evaluate(() => ({ open: !!document.getElementById("cusModal").open, axCtx: document.body.classList.contains("ax-ctx") }));
        push("P4-ESC-closes-customer-page-393", before && !after.open, { before, after });
      } finally { await page.close().catch(() => {}); }
    }
  }

  // ================= NL parity (375) =================
  if (want("nl")) {
    // STRINGS key counts
    {
      const uiPath = path.join(ctx.tree, "views", "ui.js");
      // eslint-disable-next-line global-require
      const ui = require(uiPath);
      const en = Object.keys(ui.STRINGS.en), nl = Object.keys(ui.STRINGS.nl);
      const missingNl = en.filter((k) => !nl.includes(k)), missingEn = nl.filter((k) => !en.includes(k));
      push("P4-NL-key-counts", en.length === nl.length && !missingNl.length && !missingEn.length, { en: en.length, nl: nl.length, missingNl, missingEn });
    }
    // no horizontal page scroll on every scene at 375 in NL
    {
      const nlWalk = ctx.outDir ? path.join(ctx.outDir, "nl", "walk.json") : null;
      let source, offenders = [], count = 0;
      const wantIds = SCENES.map((s) => s.id);
      let entries = null;
      if (nlWalk && fs.existsSync(nlWalk)) {
        entries = (JSON.parse(fs.readFileSync(nlWalk, "utf8")).entries || []).filter((e) => e.width === w375.label);
        const seen = new Set(entries.map((e) => e.scene));
        if (!wantIds.every((id) => seen.has(id))) entries = null;
      }
      if (entries) {
        source = nlWalk;
        for (const e of entries) {
          count++;
          if (e.error || !(e.scrollWidth <= e.innerWidth)) offenders.push({ scene: e.scene, scrollWidth: e.scrollWidth, innerWidth: e.innerWidth, error: e.error ? e.error.split("\n")[0] : undefined });
        }
      } else {
        source = "live pass (no complete " + (nlWalk || "nl walk") + ")";
        for (const scene of SCENES) {
          const { page } = await phonePage(ctx, w375, { lang: "nl" });
          try {
            await openScene(page, ctx.baseUrl, scene);
            await sleep(50);
            const p = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
            count++;
            if (!(p.sw <= p.iw)) offenders.push({ scene: scene.id, scrollWidth: p.sw, innerWidth: p.iw });
          } catch (err) {
            offenders.push({ scene: scene.id, error: String(err.message || err).split("\n")[0] });
          } finally { await page.close().catch(() => {}); }
        }
      }
      push("P4-NL-no-horizontal-scroll-375", count >= SCENES.length && offenders.length === 0, { source, scenes: count, offenders });
    }
    // no clipped button in the bar or an open sheet
    {
      const offenders = [], checked = {};
      for (const id of ["item-ready", "item-overflow", "item-recipient", "queue-filter"]) {
        const { page } = await phonePage(ctx, w375, { lang: "nl" });
        try {
          await openScene(page, ctx.baseUrl, findScene(id));
          await sleep(100);
          const p = await page.evaluate(() => {
            const sel = ".actionbar button, .actionbar summary, details[open] > .menu-list button, details[open] > .menu-list summary, details[open] > .menu-list a[href], details[open] > .chipmenu-list button, details[open] > .chipmenu-list a[href]";
            const out = [];
            for (const el of document.querySelectorAll(sel)) {
              const r = el.getBoundingClientRect();
              if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === "hidden") continue;
              // content of a closed <details> is not rendered (Chromium reports stale boxes for it)
              const cd = el.closest("details:not([open])");
              if (cd && el !== cd.querySelector(":scope > summary")) continue;
              out.push({ text: (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 50), cls: String(el.className || ""), sw: el.scrollWidth, cw: el.clientWidth, clipped: el.scrollWidth > el.clientWidth + 1 });
            }
            return out;
          });
          checked[id] = p.length;
          p.filter((x) => x.clipped).forEach((x) => offenders.push({ scene: id, ...x }));
        } finally { await page.close().catch(() => {}); }
      }
      push("P4-NL-no-clipped-buttons-375", offenders.length === 0 && Object.values(checked).every((n) => n > 0), { checkedPerScene: checked, offenders });
    }
    // tab counts visible
    {
      const { page } = await phonePage(ctx, w375, { lang: "nl" });
      try {
        await go(page, ctx.baseUrl + "/");
        await inject(page);
        const tabs = await page.evaluate(() => Array.from(document.querySelectorAll(".qtab")).map((t) => {
          const n = t.querySelector(".n"), tr = t.getBoundingClientRect(), nr = n ? n.getBoundingClientRect() : null;
          return {
            label: (t.textContent || "").replace(/\s+/g, " ").trim(), n: n ? n.textContent.trim() : null, visible: __vis(n),
            inside: !!nr && nr.left >= tr.left - 0.5 && nr.right <= tr.right + 0.5 && nr.left >= 0 && nr.right <= innerWidth + 0.5,
            clipped: !!n && n.scrollWidth > n.clientWidth + 1,
          };
        }));
        push("P4-NL-tab-counts-visible-375", tabs.length >= 4 && tabs.every((t) => t.n !== null && t.n !== "" && t.visible && t.inside && !t.clipped), { tabs });
      } finally { await page.close().catch(() => {}); }
    }
  }

  const pass = results.every((r) => r.pass);
  return { phase: "4", pass, assertions: results };
}

module.exports = { assert, GROUPS };
