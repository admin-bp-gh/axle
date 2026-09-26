// phase-3.js - Phase 3 acceptance assertions (mobile plan section 3.7, the Acceptance table).
// Exports `async function assert(ctx)`, same shape as phase-2.js. Covers C1 (pagination),
// C2 (fragment tabs), C3 (compose relocation, full screen compose), C4 (the detail-shaped
// error screen), C5 (the ax-detail class), the in-app Back (M-07, M-17, M-18, M-20) and the
// poll pause rules (M-12, M-54), at 393 and/or 375 as the table names, plus the desktop rows
// (1440 and 1101) that are not pixel/layout diffs: a tab switch ends on the empty work pane
// without a document load, the queue still refreshes with the sync lock set, and a Load
// more'd list never swaps. The pixel/layout/DOM diff itself is the separate `compare` run.
//
// Fixtures (harness/mobile/boot.js seed(dbPath, "3")): 120 extra done items (ids 100 to 219),
// item 300 "Forced 500 fixture" (GET /item/300 throws via harness/mobile/extra-stubs.js).
//
// Shortcuts, documented:
//  - Sync lock: server.js clears sync_state.running at startup, so the lock cannot be seeded
//    before the boot. setSync() below writes sync_state.running straight into the running
//    server's temp DB (ctx.dbPath) around the assertions that need it and clears it after.
//  - 30 s poll windows: instead of waiting 30 s, the assertions set `__axQPoll.sec = 1` and
//    `__axQPoll.last = 0` (the next 2 s tick is then due) and watch for 5 s. A tick that
//    would have fired in 30 s at sec 8 fires within 5 s here, so "no request in 5 s" with
//    those settings covers the same skip rules.
//  - document.hidden: Object.defineProperty(document, "hidden", { get: () => true }) plus a
//    dispatched visibilitychange (page.emulateVisibility is not available in every version).
//  - "No document load": `window.__axMarker = 1` before the action, checked afterwards, plus
//    no navigation request seen.
"use strict";
const http = require("http");
const { DatabaseSync } = require("node:sqlite");
const { newPage } = require("./pptr.js");
const { bootServer } = require("./boot.js");

const HDR = { "Tailscale-User-Login": "admin@budget-parts.nl" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function widthByPx(ctx, px) {
  const w = ctx.widths.find((x) => x.width === px);
  if (!w) throw new Error("phase-3 needs a --widths entry at " + px + "px");
  return w;
}

function setSync(ctx, on) {
  const d = new DatabaseSync(ctx.dbPath);
  try {
    if (on) d.prepare("UPDATE sync_state SET running = 1, started_at = datetime('now'), finished_at = NULL, trigger = 'harness' WHERE id = 1").run();
    else d.prepare("UPDATE sync_state SET running = 0, finished_at = datetime('now') WHERE id = 1").run();
  } finally { d.close(); }
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

async function phonePage(ctx, width, baseUrl) {
  const { page, consoleErrors } = await newPage(ctx.browser, {
    width: width.width, height: width.height, deviceScaleFactor: 1,
    isMobile: true, hasTouch: true, lang: "en", baseUrl: baseUrl || ctx.baseUrl,
  });
  return { page, consoleErrors };
}

async function deskPage(ctx, w, h) {
  const { page, consoleErrors } = await newPage(ctx.browser, {
    width: w, height: h, deviceScaleFactor: 1, isMobile: false, hasTouch: false, lang: "en", baseUrl: ctx.baseUrl,
  });
  return { page, consoleErrors };
}

async function idle(page) {
  try { await page.waitForNetworkIdle({ idleTime: 250, timeout: 6000 }); } catch (e) { /* best effort */ }
}

async function go(page, url) {
  await page.goto(url, { waitUntil: "networkidle0" });
  try { await page.waitForFunction(() => !!window.htmx, { timeout: 5000 }); } catch (e) { /* recorded by the probe */ }
  await sleep(100);
}

// Records every request the page issues from now on.
function track(page) {
  const log = [];
  const h = (r) => log.push({ url: r.url(), method: r.method(), type: r.resourceType(), nav: r.isNavigationRequest() });
  page.on("request", h);
  return {
    log,
    since(n) { return log.slice(n); },
    navs(from) { return log.slice(from || 0).filter((x) => x.nav); },
    stop() { page.off("request", h); },
  };
}
function isQueue(x) { const u = new URL(x.url); return u.pathname === "/queue"; }

function cardCount(page) {
  return page.evaluate(() => document.querySelectorAll("#qlist a.qcard").length);
}

// Taps a card (a real click on a visible card) and waits for the item detail.
async function tapCard(page, href) {
  const sel = 'a.qcard[href="' + href + '"]';
  await page.evaluate((s) => { const a = document.querySelector(s); if (a) { const r = a.getBoundingClientRect(); if (r.top < 60 || r.bottom > innerHeight - 20) a.scrollIntoView({ block: "center" }); } }, sel);
  await page.click(sel);
  try { await page.waitForFunction(() => !!document.querySelector("#workpane .has-item"), { timeout: 8000 }); } catch (e) { /* probe records it */ }
  await idle(page);
  await sleep(150);
}

function gapH(a, b) { if (a.right <= b.x) return b.x - a.right; if (b.right <= a.x) return a.x - b.right; return 0; }
function gapV(a, b) { if (a.bottom <= b.y) return b.y - a.bottom; if (b.bottom <= a.y) return a.y - b.bottom; return 0; }
// "At least 8px apart": separated by at least 8px on one axis.
function minSeparation(rects) {
  let min = Infinity, pair = null;
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const s = Math.max(gapH(rects[i], rects[j]), gapV(rects[i], rects[j]));
    if (s < min) { min = s; pair = [rects[i].label, rects[j].label]; }
  }
  return { min: rects.length > 1 ? min : null, pair };
}

const GROUPS = ["c1", "c2", "c3", "compose", "c4", "c5", "nav", "poll", "desktop"];

async function assert(ctx) {
  const results = [];
  const push = (id, pass, detail) => results.push({ id, pass: !!pass, detail });
  const want = (g) => !ctx.only || ctx.only.includes(g);
  const w393 = widthByPx(ctx, 393);
  const w375 = widthByPx(ctx, 375);
  setSync(ctx, false);

  // ================= C1: pagination (393) =================
  if (want("c1")) {
    // response size, straight over http (the phone's first document)
    {
      const r = await httpGet(ctx.baseUrl, "/?show=done");
      push("P3-C1-size-under-250k", r.status === 200 && r.bytes < 250 * 1024, { status: r.status, bytes: r.bytes, limit: 250 * 1024 });
    }
    const { page } = await phonePage(ctx, w393);
    try {
      await go(page, ctx.baseUrl + "/?show=done");
      const p1 = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll("#qlist a.qcard"));
        const b = document.getElementById("qmore");
        const r = b ? b.getBoundingClientRect() : null;
        const tab = document.querySelector('.qtab.on .n');
        return {
          n: cards.length, hrefs: cards.map((a) => a.getAttribute("href")),
          ranks: cards.map((a) => +a.getAttribute("data-rank")),
          btn: b ? { text: b.textContent.trim(), h: r.height, w: r.width, outsideList: !document.getElementById("qlist").contains(b), total: b.getAttribute("data-total") } : null,
          tabN: tab ? tab.textContent.trim() : null,
        };
      });
      push("P3-C1-done-50-cards", p1.n === 50, { n: p1.n });
      const labelOk = !!p1.btn && p1.btn.text === "Load more (50 of " + p1.tabN + ")";
      push("P3-C1-load-more-44", !!p1.btn && p1.btn.h >= 44 && labelOk && p1.btn.outsideList, { btn: p1.btn, tabN: p1.tabN, labelOk });

      const tr = track(page);
      await page.click("#qmore");
      try { await page.waitForFunction(() => document.querySelectorAll("#qlist a.qcard").length >= 100, { timeout: 8000 }); } catch (e) { /* probe */ }
      await idle(page);
      const p2 = await page.evaluate(() => {
        const cards = Array.from(document.querySelectorAll("#qlist a.qcard"));
        return { n: cards.length, hrefs: cards.map((a) => a.getAttribute("href")), ranks: cards.map((a) => +a.getAttribute("data-rank")), dataPage: document.getElementById("qlist").getAttribute("data-page"), btn: !!document.getElementById("qmore"), btnHx: document.getElementById("qmore") && document.getElementById("qmore").getAttribute("hx-get") };
      });
      const xhr = tr.log.filter((x) => (x.type === "xhr" || x.type === "fetch") && new URL(x.url).pathname === "/queue");
      const firstKept = p1.hrefs.every((h, i) => p2.hrefs[i] === h);
      const noDupes = new Set(p2.hrefs).size === p2.hrefs.length;
      const ranksOk = p2.ranks.every((r, i) => r === i);
      push("P3-C1-append-not-replace", p2.n === 100 && firstKept && noDupes && ranksOk && xhr.length === 1 && /page=2/.test(xhr[0].url) && tr.navs().length === 0,
        { n: p2.n, firstKept, noDupes, ranksOk, dataPage: p2.dataPage, xhr: xhr.map((x) => x.url), navs: tr.navs().length, nextHx: p2.btnHx });

      await page.click("#qmore").catch(() => {});
      try { await page.waitForFunction(() => document.querySelectorAll("#qlist a.qcard").length > 100, { timeout: 8000 }); } catch (e) { /* probe */ }
      await idle(page);
      const p3 = await page.evaluate(() => ({ n: document.querySelectorAll("#qlist a.qcard").length, btn: !!document.getElementById("qmore"), row: !!document.getElementById("qmoreRow") }));
      push("P3-C1-last-page-no-control", p3.n === +p1.tabN && !p3.btn && !p3.row, { n: p3.n, expected: p1.tabN, btn: p3.btn, row: p3.row });
      tr.stop();
    } finally { await page.close().catch(() => {}); }

    // All tab: same behaviour
    {
      const { page: pg } = await phonePage(ctx, w393);
      try {
        await go(pg, ctx.baseUrl + "/?show=all");
        const a1 = await pg.evaluate(() => {
          const b = document.getElementById("qmore"); const tab = document.querySelector(".qtab.on .n");
          return { n: document.querySelectorAll("#qlist a.qcard").length, hrefs: Array.from(document.querySelectorAll("#qlist a.qcard")).map((a) => a.getAttribute("href")), text: b ? b.textContent.trim() : null, h: b ? b.getBoundingClientRect().height : null, tabN: tab ? tab.textContent.trim() : null };
        });
        await pg.click("#qmore").catch(() => {});
        try { await pg.waitForFunction(() => document.querySelectorAll("#qlist a.qcard").length >= 100, { timeout: 8000 }); } catch (e) { /* probe */ }
        await idle(pg);
        const a2 = await pg.evaluate(() => Array.from(document.querySelectorAll("#qlist a.qcard")).map((a) => a.getAttribute("href")));
        const kept = a1.hrefs.every((h, i) => a2[i] === h);
        push("P3-C1-all-tab-same", a1.n === 50 && a1.text === "Load more (50 of " + a1.tabN + ")" && a1.h >= 44 && a2.length === 100 && kept,
          { first: { n: a1.n, text: a1.text, h: a1.h, tabN: a1.tabN }, afterLoadMore: a2.length, kept });
      } finally { await pg.close().catch(() => {}); }
    }

    // Open and Archived unchanged: whole list, no Load more
    {
      const { page: pg } = await phonePage(ctx, w393);
      try {
        const out = {};
        for (const show of ["open", "archived"]) {
          await go(pg, ctx.baseUrl + "/?show=" + show);
          out[show] = await pg.evaluate(() => {
            const tab = document.querySelector(".qtab.on .n");
            return { n: document.querySelectorAll("#qlist a.qcard").length, tabN: tab ? +tab.textContent.trim() : null, more: !!document.getElementById("qmore"), paged: document.getElementById("qlist").getAttribute("data-paged") };
          });
        }
        const ok = ["open", "archived"].every((k) => out[k].n === out[k].tabN && !out[k].more && out[k].paged == null);
        push("P3-C1-open-unchanged", ok, out);
      } finally { await pg.close().catch(() => {}); }
    }
  }

  // ================= C2: fragment tabs (393) =================
  if (want("c2")) {
    const { page } = await phonePage(ctx, w393);
    try {
      await go(page, ctx.baseUrl + "/");
      await page.evaluate(() => { window.__axMarker = 1; });
      const tr = track(page);
      await page.click('a.qtab[href*="show=done"]');
      try { await page.waitForFunction(() => { const t = document.querySelector(".qtab.on"); return !!t && /show=done/.test(t.getAttribute("href")); }, { timeout: 8000 }); } catch (e) { /* probe */ }
      await idle(page);
      const st = await page.evaluate(() => ({ marker: window.__axMarker, url: location.pathname + location.search, n: document.querySelectorAll("#qlist a.qcard").length, empty: !!document.querySelector("#workpane .empty-state") }));
      const xhr = tr.log.filter((x) => x.type === "xhr" || x.type === "fetch");
      const qx = xhr.filter(isQueue);
      push("P3-C2-tab-one-xhr-no-load", qx.length === 1 && xhr.length === 1 && tr.navs().length === 0 && st.marker === 1,
        { xhr: xhr.map((x) => x.method + " " + x.url), navs: tr.navs().map((x) => x.url), marker: st.marker, cards: st.n });
      tr.stop();
      const urlOk = st.url === "/?mailbox=info&show=done&scope=all";
      // Back: htmx has historyCacheSize 0 and refreshOnHistoryMiss, so the popstate reloads the
      // URL it lands on; the content must match that URL.
      await page.evaluate(() => history.back());
      await sleep(1500);
      try { await page.waitForFunction(() => document.readyState === "complete" && !!window.htmx && !!document.querySelector(".qtab.on"), { timeout: 8000 }); } catch (e) { /* probe */ }
      await idle(page);
      const back = await page.evaluate(() => {
        const t = document.querySelector(".qtab.on");
        const urlShow = new URLSearchParams(location.search).get("show") || "open";
        const tabShow = t ? new URLSearchParams(t.getAttribute("href").split("?")[1] || "").get("show") : null;
        return { url: location.pathname + location.search, urlShow, tabShow, cards: document.querySelectorAll("#qlist a.qcard").length };
      });
      push("P3-C2-url-and-back", urlOk && back.urlShow === back.tabShow && back.cards > 0, { afterTab: st.url, back });
    } finally { await page.close().catch(() => {}); }
  }

  // ================= C3: compose markup placement (393, 375) =================
  if (want("c3")) {
    for (const width of [w393, w375]) {
      const { page } = await phonePage(ctx, width);
      try {
        await go(page, ctx.baseUrl + "/");
        const root = await page.evaluate(() => {
          const m = document.getElementById("composeModal"), qp = document.getElementById("queuepane");
          return { count: document.querySelectorAll("#composeModal").length, inQueue: !!(m && qp && qp.contains(m)) };
        });
        push("P3-C3-compose-outside-queuepane-" + width.width, root.count === 1 && !root.inQueue, root);
        await go(page, ctx.baseUrl + "/item/1");
        try { await page.waitForSelector("#queuepane .qtab", { timeout: 8000 }); } catch (e) { /* probe */ }
        await idle(page);
        const deep = await page.evaluate(() => {
          const m = document.getElementById("composeModal"), qp = document.getElementById("queuepane");
          return { count: document.querySelectorAll("#composeModal").length, inQueue: !!(m && qp && qp.contains(m)), lazyQueueLoaded: !!document.querySelector("#queuepane .qtab") };
        });
        const rawRoot = await httpGet(ctx.baseUrl, "/");
        const rawDeep = await httpGet(ctx.baseUrl, "/item/1");
        const cnt = (s) => (s.match(/id="composeModal"/g) || []).length;
        push("P3-C3-compose-once-deep-link-" + width.width, root.count === 1 && deep.count === 1 && !deep.inQueue && deep.lazyQueueLoaded && cnt(rawRoot.body) === 1 && cnt(rawDeep.body) === 1,
          { root, deep, rawRoot: cnt(rawRoot.body), rawDeep: cnt(rawDeep.body) });
      } finally { await page.close().catch(() => {}); }
    }
    {
      const r = await httpGet(ctx.baseUrl, "/queue?mailbox=info&show=open&scope=all", { "HX-Request": "true" });
      const r2 = await httpGet(ctx.baseUrl, "/queue?mailbox=info&show=done&scope=all&page=2", { "HX-Request": "true" });
      push("P3-C3-queue-fragment-no-compose", r.status === 200 && !/composeModal/.test(r.body) && r2.status === 200 && !/composeModal/.test(r2.body),
        { status: r.status, bytes: r.bytes, page2Status: r2.status, hasCompose: /composeModal/.test(r.body), page2HasCompose: /composeModal/.test(r2.body) });
    }
  }

  // ================= Compose full screen (393, 375) + M-59 =================
  if (want("compose")) {
    // M-41 names Cancel / Draft / Send now. "Send now" renders only with
    // AXLE_ACTION_COMPOSE_SEND=on, which the shared harness server does not set, so the
    // compose geometry checks run against a second, short-lived server booted with it on.
    const prevEnv = process.env.AXLE_ACTION_COMPOSE_SEND;
    process.env.AXLE_ACTION_COMPOSE_SEND = "on";
    let sendSrv = null;
    try { sendSrv = await bootServer({ tree: ctx.tree, phase: "3" }); }
    finally { if (prevEnv === undefined) delete process.env.AXLE_ACTION_COMPOSE_SEND; else process.env.AXLE_ACTION_COMPOSE_SEND = prevEnv; }
    try {
      for (const width of [w393, w375]) {
        const { page } = await phonePage(ctx, width, sendSrv.baseUrl);
        try {
          await go(page, sendSrv.baseUrl + "/");
          await page.click("#composeBtn");
          try { await page.waitForFunction(() => getComputedStyle(document.getElementById("composeModal")).display !== "none", { timeout: 5000 }); } catch (e) { /* probe */ }
          await sleep(150);
          const pr = await page.evaluate(() => {
            function r(el, label) { if (!el) return null; const b = el.getBoundingClientRect(); return { label, x: b.left, y: b.top, right: b.right, bottom: b.bottom, w: b.width, h: b.height }; }
            const modal = document.getElementById("composeModal");
            return {
              vw: window.innerWidth, vh: window.innerHeight,
              modal: r(modal, "modal"), card: r(document.querySelector("#composeModal .modal-card"), "card"),
              close: r(document.getElementById("composeClose"), "close"),
              foot: ["composeCancel", "composeSubmit", "composeSendBtn"].map((id) => r(document.getElementById(id), id)),
              chips: Array.from(document.querySelectorAll("#composeModal .schip")).map((c, i) => r(c, "schip" + i)),
              active: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
              modalScrollTop: modal.scrollTop,
            };
          });
          const fillOk = !!pr.card && Math.abs(pr.card.x) <= 0.5 && Math.abs(pr.card.y) <= 0.5 && Math.abs(pr.card.w - pr.vw) <= 0.5 && pr.card.h >= pr.vh - 0.5
            && !!pr.modal && Math.abs(pr.modal.x) <= 0.5 && Math.abs(pr.modal.y) <= 0.5 && Math.abs(pr.modal.w - pr.vw) <= 0.5 && Math.abs(pr.modal.h - pr.vh) <= 0.5;
          push("P3-M40-modal-fills-viewport-" + width.width, fillOk, { vw: pr.vw, vh: pr.vh, modal: pr.modal, card: pr.card });
          push("P3-M42-close-44-" + width.width, !!pr.close && pr.close.w >= 44 && pr.close.h >= 44, { close: pr.close });
          const foot = pr.foot.filter(Boolean);
          const allThree = pr.foot.every(Boolean);
          const visible = foot.every((b) => b.y >= 0 && b.bottom <= pr.vh + 0.5 && b.w > 0);
          const tall = foot.every((b) => b.h >= 44 && b.w >= 44);
          const sep = minSeparation(foot);
          push("P3-M41-foot-visible-44-gap8-" + width.width, allThree && visible && tall && sep.min !== null && sep.min >= 8,
            { allThree, visible, tall, minGap: sep.min, pair: sep.pair, foot, vh: pr.vh });
          const chipsTall = pr.chips.length > 0 && pr.chips.every((c) => c.h >= 44);
          const csep = minSeparation(pr.chips);
          push("P3-M42-chips-44-gap8-" + width.width, chipsTall && csep.min !== null && csep.min >= 8,
            { count: pr.chips.length, minH: Math.min(...pr.chips.map((c) => c.h)), minGap: csep.min, pair: csep.pair });
          push("P3-M43-no-autofocus-" + width.width, pr.active !== "who", { activeElement: pr.active });
        } finally { await page.close().catch(() => {}); }
      }
    } finally { if (sendSrv) await sendSrv.stop(); }

    // M-41 in the draft-only configuration (AXLE_ACTION_COMPOSE_SEND unset, today's live
    // setting until Gate D): the foot holds the "Draft only" note, Cancel and Draft.
    for (const width of [w393, w375]) {
      const { page } = await phonePage(ctx, width);
      try {
        await go(page, ctx.baseUrl + "/");
        await page.click("#composeBtn");
        await sleep(200);
        const pr = await page.evaluate(() => {
          function r(el, label) { if (!el) return null; const b = el.getBoundingClientRect(); return { label, x: b.left, y: b.top, right: b.right, bottom: b.bottom, w: b.width, h: b.height, clipped: el.scrollWidth > el.clientWidth + 1 }; }
          return { vh: window.innerHeight, note: r(document.querySelector(".modal-foot > span.muted"), "note"), foot: ["composeCancel", "composeSubmit"].map((id) => r(document.getElementById(id), id)), footWrap: getComputedStyle(document.querySelector(".modal-foot")).flexWrap };
        });
        const foot = pr.foot.filter(Boolean);
        const ok = foot.length === 2 && foot.every((b) => b.y >= 0 && b.bottom <= pr.vh + 0.5 && b.h >= 44 && b.w >= 44 && !b.clipped) && minSeparation(foot).min >= 8;
        push("P3-M41-foot-draft-only-44-gap8-" + width.width, ok, { foot, note: pr.note, modalFootFlexWrap: pr.footWrap, minGap: minSeparation(foot).min });
      } finally { await page.close().catch(() => {}); }
    }

    // M-59 (393): compose open with typed text while a sync-driven poll swaps #queuepane
    setSync(ctx, true);
    try {
      const { page } = await phonePage(ctx, w393);
      try {
        await go(page, ctx.baseUrl + "/");
        const sec = await page.evaluate(() => window.__axQPoll && window.__axQPoll.sec);
        await page.click("#composeBtn");
        await sleep(150);
        await page.type("#who", "M59 typed recipient", { delay: 5 });
        await page.type("#csubject", "M59 typed subject", { delay: 5 });
        const tr = track(page);
        // make the sync-driven tick (sec 8, from the server render) due on the next 2 s tick
        await page.evaluate(() => { window.__axQPoll.last = 0; });
        let fired = false;
        for (let i = 0; i < 24 && !fired; i++) { await sleep(250); fired = tr.log.some(isQueue); }
        await idle(page);
        await sleep(300);
        const st = await page.evaluate(() => {
          const m = document.getElementById("composeModal");
          return { display: getComputedStyle(m).display, who: document.getElementById("who").value, subj: document.getElementById("csubject").value, count: document.querySelectorAll("#composeModal").length, inQueue: document.getElementById("queuepane").contains(m) };
        });
        tr.stop();
        push("P3-M59-compose-survives-poll", sec === 8 && fired && st.display !== "none" && st.who === "M59 typed recipient" && st.subj === "M59 typed subject" && st.count === 1,
          { pollSecFromServer: sec, pollFired: fired, queueRequests: tr.log.filter(isQueue).map((x) => x.url), state: st });
      } finally { await page.close().catch(() => {}); }
    } finally { setSync(ctx, false); }
  }

  // ================= C4: error screen (393, 375) =================
  if (want("c4")) {
    const probeErr = (page) => page.evaluate(() => {
      const wp = document.getElementById("workpane"), qp = document.getElementById("queuepane");
      const back = document.querySelector("#workpane .pane-center.has-item > a.m-back");
      const retry = document.querySelector("#workpane .errbox .retry");
      const br = back ? back.getBoundingClientRect() : null, rr = retry ? retry.getBoundingClientRect() : null;
      return {
        errbox: !!document.querySelector("#workpane .errbox"),
        wpDisplay: getComputedStyle(wp).display, qpDisplay: getComputedStyle(qp).display,
        back: br ? { h: br.height, w: br.width, display: getComputedStyle(back).display } : null,
        retry: rr ? { h: rr.height, w: rr.width, hxGet: retry.getAttribute("hx-get") } : null,
        axDetail: document.body.classList.contains("ax-detail"),
        text: (document.querySelector("#workpane .errbox") || { textContent: "" }).textContent.replace(/\s+/g, " ").trim().slice(0, 200),
      };
    });
    const screenOk = (p) => p.errbox && p.wpDisplay !== "none" && p.qpDisplay === "none" && !!p.back && p.back.h > 0 && p.back.display !== "none" && !!p.retry && p.retry.h >= 44 && p.axDetail;
    for (const width of [w393, w375]) {
      // forced 500 via the card tap
      {
        const { page } = await phonePage(ctx, width);
        try {
          await go(page, ctx.baseUrl + "/");
          const statuses = [];
          page.on("response", (r) => { if (new URL(r.url()).pathname === "/item/300") statuses.push(r.status()); });
          await page.evaluate(() => { const a = document.querySelector('a.qcard[href="/item/300"]'); if (a) a.scrollIntoView({ block: "center" }); });
          await page.click('a.qcard[href="/item/300"]');
          try { await page.waitForSelector("#workpane .errbox", { timeout: 8000 }); } catch (e) { /* probe */ }
          await idle(page);
          const p = await probeErr(page);
          push("P3-C4-500-detail-screen-" + width.width, statuses[0] === 500 && screenOk(p), { statuses, probe: p });
          const tr = track(page);
          await page.click("#workpane .errbox .retry").catch(() => {});
          await sleep(1000);
          await idle(page);
          const again = tr.log.filter((x) => new URL(x.url).pathname === "/item/300");
          const p2 = await probeErr(page);
          tr.stop();
          push("P3-C4-retry-reissues-get-" + width.width, again.length >= 1 && again.every((x) => x.method === "GET") && screenOk(p2),
            { requests: again.map((x) => x.method + " " + x.url), statusesAfter: statuses.slice(1), probe: p2 });
        } finally { await page.close().catch(() => {}); }
      }
      // forced network failure (the first /item/300 request aborted)
      {
        const { page } = await phonePage(ctx, width);
        try {
          await go(page, ctx.baseUrl + "/");
          await page.setRequestInterception(true);
          let aborted = 0;
          page.on("request", (r) => {
            if (r.isInterceptResolutionHandled && r.isInterceptResolutionHandled()) return;
            if (!aborted && new URL(r.url()).pathname === "/item/300") { aborted++; r.abort("failed").catch(() => {}); }
            else r.continue().catch(() => {});
          });
          await page.evaluate(() => { const a = document.querySelector('a.qcard[href="/item/300"]'); if (a) a.scrollIntoView({ block: "center" }); });
          await page.click('a.qcard[href="/item/300"]');
          try { await page.waitForSelector("#workpane .errbox", { timeout: 8000 }); } catch (e) { /* probe */ }
          await sleep(300);
          const p = await probeErr(page);
          push("P3-C4-network-failure-same-screen-" + width.width, aborted === 1 && screenOk(p), { aborted, probe: p });
        } finally { await page.close().catch(() => {}); }
      }
      // a failed POST never offers Retry: (a) an error response, (b) a network failure
      {
        const { page } = await phonePage(ctx, width);
        try {
          await go(page, ctx.baseUrl + "/");
          const statuses = [];
          page.on("response", (r) => { if (r.request().method() === "POST" && /\/item\/300\//.test(r.url())) statuses.push(r.status()); });
          await page.evaluate(() => window.htmx.ajax("POST", "/item/300/nonexistent", { target: "#workpane", swap: "innerHTML" }).catch(() => {}));
          await sleep(800);
          await idle(page);
          const a = await page.evaluate(() => ({ retry: !!document.querySelector("#workpane .retry"), html: document.getElementById("workpane").innerHTML.replace(/\s+/g, " ").slice(0, 300), axDetail: document.body.classList.contains("ax-detail") }));
          await page.setRequestInterception(true);
          page.on("request", (r) => {
            if (r.isInterceptResolutionHandled && r.isInterceptResolutionHandled()) return;
            if (r.method() === "POST" && /\/item\/300\//.test(r.url())) r.abort("failed").catch(() => {});
            else r.continue().catch(() => {});
          });
          await page.evaluate(() => window.htmx.ajax("POST", "/item/300/nonexistent-2", { target: "#workpane", swap: "innerHTML" }).catch(() => {}));
          try { await page.waitForSelector("#workpane .errbox", { timeout: 5000 }); } catch (e) { /* probe */ }
          await sleep(300);
          const b = await page.evaluate(() => ({ errbox: !!document.querySelector("#workpane .errbox"), retry: !!document.querySelector("#workpane .retry"), text: (document.querySelector("#workpane .errbox") || { textContent: "" }).textContent.replace(/\s+/g, " ").trim() }));
          push("P3-C4-post-no-retry-" + width.width, statuses.length >= 1 && statuses[0] >= 400 && !a.retry && b.errbox && !b.retry,
            { responseCase: { status: statuses[0], retry: a.retry, axDetail: a.axDetail, workpane: a.html }, networkCase: b });
        } finally { await page.close().catch(() => {}); }
      }
    }
  }

  // ================= C5: ax-detail (393) =================
  if (want("c5")) {
    {
      const { page } = await phonePage(ctx, w393);
      try {
        await go(page, ctx.baseUrl + "/");
        const before = await page.evaluate(() => document.body.classList.contains("ax-detail"));
        await tapCard(page, "/item/1");
        const open = await page.evaluate(() => document.body.classList.contains("ax-detail"));
        await page.click("#workpane .pane-center > a.m-back");
        await sleep(300);
        const after = await page.evaluate(() => document.body.classList.contains("ax-detail"));
        push("P3-C5-ax-detail-set-and-cleared", !before && open && !after, { before, open, after });
      } finally { await page.close().catch(() => {}); }
    }
    {
      const { page } = await phonePage(ctx, w393);
      try {
        await go(page, ctx.baseUrl + "/");
        const removed = await page.evaluate(() => {
          let n = 0;
          function walk(list) {
            for (let i = list.cssRules.length - 1; i >= 0; i--) {
              const r = list.cssRules[i];
              if (r.selectorText && r.selectorText.includes(":has(")) { list.deleteRule(i); n++; }
              else if (r.cssRules) walk(r);
            }
          }
          for (const s of Array.from(document.styleSheets)) { try { walk(s); } catch (e) { /* cross-origin */ } }
          return n;
        });
        await tapCard(page, "/item/1");
        const st = await page.evaluate(() => {
          const wp = document.getElementById("workpane"), qp = document.getElementById("queuepane"), r = wp.getBoundingClientRect();
          return { wpDisplay: getComputedStyle(wp).display, wpH: r.height, qpDisplay: getComputedStyle(qp).display, axDetail: document.body.classList.contains("ax-detail"), headerDisplay: getComputedStyle(document.querySelector("body > header")).display };
        });
        push("P3-M07-works-without-has", removed > 0 && st.wpDisplay === "block" && st.wpH > 0 && st.qpDisplay === "none" && st.headerDisplay === "none", { hasRulesRemoved: removed, state: st });
      } finally { await page.close().catch(() => {}); }
    }
  }

  // ================= Navigation: M-17, M-20, M-18 (393) =================
  if (want("nav")) {
    {
      const { page } = await phonePage(ctx, w393);
      try {
        await go(page, ctx.baseUrl + "/?show=done");
        await page.evaluate(() => { window.__axMarker = 1; window.scrollTo(0, 600); });
        await sleep(150);
        const pick = await page.evaluate(() => {
          const c = Array.from(document.querySelectorAll("#qlist a.qcard")).find((a) => { const r = a.getBoundingClientRect(); return r.top >= 80 && r.bottom <= innerHeight - 80; });
          return { y: window.scrollY, href: c ? c.getAttribute("href") : null, url: location.pathname + location.search };
        });
        const tr = track(page);
        await page.click('a.qcard[href="' + pick.href + '"]');
        try { await page.waitForFunction(() => !!document.querySelector("#workpane .has-item"), { timeout: 8000 }); } catch (e) { /* probe */ }
        await idle(page);
        const saved = await page.evaluate(() => window.__axList || null);
        await page.click("#workpane .pane-center > a.m-back");
        await sleep(400);
        const st = await page.evaluate(() => ({
          marker: window.__axMarker, y: window.scrollY, url: location.pathname + location.search,
          qpDisplay: getComputedStyle(document.getElementById("queuepane")).display,
          cards: document.querySelectorAll("#qlist a.qcard").length, hasItem: !!document.querySelector("#workpane .has-item"),
        }));
        const navs = tr.navs();
        tr.stop();
        push("P3-M17-back-no-reload-scroll-url", st.marker === 1 && navs.length === 0 && st.qpDisplay !== "none" && !st.hasItem && Math.abs(st.y - pick.y) <= 2 && st.url === pick.url && !!saved && saved.url === pick.url,
          { before: pick, saved, after: st, navs: navs.map((x) => x.url) });
      } finally { await page.close().catch(() => {}); }
    }
    {
      const { page } = await phonePage(ctx, w393);
      try {
        await go(page, ctx.baseUrl + "/item/1");
        try { await page.waitForSelector("#queuepane .qtab", { timeout: 8000 }); } catch (e) { /* probe */ }
        await idle(page);
        await page.click("#workpane .pane-center > a.m-back");
        await sleep(600);
        await idle(page);
        const st = await page.evaluate(() => ({
          url: location.pathname + location.search, qpDisplay: getComputedStyle(document.getElementById("queuepane")).display,
          cards: document.querySelectorAll("#qlist a.qcard").length, axDetail: document.body.classList.contains("ax-detail"),
        }));
        push("P3-M20-deep-link-back-to-root", st.url === "/" && st.qpDisplay !== "none" && st.cards > 0 && !st.axDetail, st);
      } finally { await page.close().catch(() => {}); }
    }
    {
      const { page } = await phonePage(ctx, w393);
      try {
        await go(page, ctx.baseUrl + "/?show=done");
        await page.evaluate(() => window.scrollTo(0, 2000));
        await sleep(150);
        const pick = await page.evaluate(() => {
          const c = Array.from(document.querySelectorAll("#qlist a.qcard")).find((a) => { const r = a.getBoundingClientRect(); return r.top >= 80 && r.bottom <= innerHeight - 80; });
          return { y: window.scrollY, href: c ? c.getAttribute("href") : null };
        });
        await page.click('a.qcard[href="' + pick.href + '"]');
        try { await page.waitForFunction(() => !!document.querySelector("#workpane .has-item"), { timeout: 8000 }); } catch (e) { /* probe */ }
        await idle(page);
        await sleep(150);
        const y = await page.evaluate(() => window.scrollY);
        push("P3-M18-card-from-2000-opens-at-0", Math.abs(pick.y - 2000) <= 2 && y === 0, { before: pick, after: y });
      } finally { await page.close().catch(() => {}); }
    }
  }

  // ================= Poll pause rules: M-12, M-54 (393), sync lock set =================
  if (want("poll")) {
    setSync(ctx, true);
    try {
      // item open: no /queue request
      {
        const { page } = await phonePage(ctx, w393);
        try {
          await go(page, ctx.baseUrl + "/");
          const sec = await page.evaluate(() => window.__axQPoll && window.__axQPoll.sec);
          await tapCard(page, "/item/1");
          const tr = track(page);
          await page.evaluate(() => { window.__axQPoll.sec = 1; window.__axQPoll.last = 0; });
          await sleep(5000);
          const q = tr.log.filter(isQueue);
          tr.stop();
          push("P3-M12-item-open-no-queue-30s", sec === 8 && q.length === 0, { pollSecFromServer: sec, queueRequests: q.map((x) => x.url), window: "5 s at sec 1 (shortcut for 30 s at sec 8)" });
        } finally { await page.close().catch(() => {}); }
      }
      // list scrolled, then touched: no swap, the chip appears; then tapping the chip refreshes
      {
        const { page } = await phonePage(ctx, w393);
        try {
          await go(page, ctx.baseUrl + "/");
          await page.evaluate(() => window.scrollTo(0, 100));
          await sleep(100);
          const y = await page.evaluate(() => window.scrollY);
          const chipVis = () => page.evaluate(() => { const u = document.getElementById("qupd"); if (!u || u.hidden) return null; const r = u.getBoundingClientRect(); return r.height > 0 ? { h: r.height, w: r.width } : null; });
          const chipRaw = () => page.evaluate(() => { const u = document.getElementById("qupd"); return u ? { hiddenAttr: u.hidden, display: getComputedStyle(u).display } : null; });
          let tr = track(page);
          await page.evaluate(() => { window.__axQPoll.sec = 1; window.__axQPoll.last = 0; });
          await sleep(5000);
          const scrolled = { y, queue: tr.log.filter(isQueue).map((x) => x.url), chip: await chipVis(), chipRaw: await chipRaw() };
          tr.stop();
          // touched: back at the top, chip hidden again, a touchstart on the list
          await page.evaluate(() => { window.scrollTo(0, 0); const u = document.getElementById("qupd"); if (u) u.hidden = true; });
          await sleep(100);
          tr = track(page);
          await page.evaluate(() => {
            const c = document.querySelector("#qlist a.qcard");
            let ev; try { ev = new TouchEvent("touchstart", { bubbles: true, cancelable: true }); } catch (e) { ev = new Event("touchstart", { bubbles: true }); }
            c.dispatchEvent(ev);
            window.__axQPoll.last = 0;
          });
          await sleep(5000);
          const touched = { y: await page.evaluate(() => window.scrollY), touchT: await page.evaluate(() => !!window.__axQTouch), queue: tr.log.filter(isQueue).map((x) => x.url), chip: await chipVis(), chipRaw: await chipRaw() };
          tr.stop();
          push("P3-M54-scrolled-no-swap-chip", y > 0 && scrolled.queue.length === 0 && !!scrolled.chip && scrolled.chip.h >= 44 && touched.touchT && touched.queue.length === 0 && !!touched.chip,
            { scrolled, touched });
          // the chip: one tap refreshes the queue and scrolls to the top
          await page.evaluate(() => { window.__axQPoll.sec = 0; window.scrollTo(0, 100); });
          await sleep(100);
          // the chip must be un-hidden and tappable first (the tick's phone skip shows it)
          await page.evaluate(() => { window.__axQPoll.sec = 1; window.__axQPoll.last = 0; window.__axQTouch = 0; });
          try { await page.waitForFunction(() => { const u = document.getElementById("qupd"); return !!u && !u.hidden; }, { timeout: 5000 }); } catch (e) { /* probe */ }
          await page.evaluate(() => { window.__axQPoll.sec = 0; });
          const chipState = await page.evaluate(() => { const u = document.getElementById("qupd"); const r = u.getBoundingClientRect(); return { hiddenAttr: u.hidden, display: getComputedStyle(u).display, w: r.width, h: r.height, y: window.scrollY }; });
          tr = track(page);
          let tapError = null;
          await page.click("#qupd").catch((e) => { tapError = String(e.message || e).split("\n")[0]; });
          await sleep(1500);
          await idle(page);
          const tap = { chipState, tapError, queue: tr.log.filter(isQueue).map((x) => x.url), y: await page.evaluate(() => window.scrollY) };
          tr.stop();
          // Diagnostic only (not part of the pass condition): does the chip's click handler
          // itself refresh when invoked from script, even if a finger cannot reach it?
          if (!tap.queue.length) {
            await page.evaluate(() => window.scrollTo(0, 100));
            const tr2 = track(page);
            await page.evaluate(() => document.getElementById("qupd").click());
            await sleep(1500);
            tap.scriptClickDiagnostic = { queue: tr2.log.filter(isQueue).map((x) => x.url), y: await page.evaluate(() => window.scrollY) };
            tr2.stop();
          }
          push("P3-M54-chip-tap-refreshes", !tapError && tap.queue.length >= 1 && tap.y === 0, tap);
        } finally { await page.close().catch(() => {}); }
      }
      // document.hidden: no requests at all
      {
        const { page } = await phonePage(ctx, w393);
        try {
          await go(page, ctx.baseUrl + "/");
          await page.evaluate(() => {
            Object.defineProperty(document, "hidden", { get: () => true, configurable: true });
            Object.defineProperty(document, "visibilityState", { get: () => "hidden", configurable: true });
            document.dispatchEvent(new Event("visibilitychange"));
          });
          const tr = track(page);
          await page.evaluate(() => { window.__axQPoll.sec = 1; window.__axQPoll.last = 0; });
          await sleep(5000);
          const all = tr.log.slice();
          tr.stop();
          push("P3-M12-hidden-no-requests", all.length === 0, { requests: all.map((x) => x.method + " " + x.url) });
        } finally { await page.close().catch(() => {}); }
      }
      // after Load more: no swap (phone; desktop 1440 below)
      {
        const { page } = await phonePage(ctx, w393);
        try {
          await go(page, ctx.baseUrl + "/?show=done");
          await page.click("#qmore");
          try { await page.waitForFunction(() => document.querySelectorAll("#qlist a.qcard").length >= 100, { timeout: 8000 }); } catch (e) { /* probe */ }
          await idle(page);
          await page.evaluate(() => window.scrollTo(0, 0));
          await sleep(100);
          const tr = track(page);
          await page.evaluate(() => { window.__axQPoll.sec = 1; window.__axQPoll.last = 0; });
          await sleep(5000);
          const q = tr.log.filter(isQueue);
          const st = await page.evaluate(() => ({ n: document.querySelectorAll("#qlist a.qcard").length, dataPage: document.getElementById("qlist").getAttribute("data-page"), y: window.scrollY }));
          tr.stop();
          push("P3-M12-after-load-more-no-swap-393", q.length === 0 && st.n === 100, { queueRequests: q.map((x) => x.url), state: st });
        } finally { await page.close().catch(() => {}); }
      }
    } finally { setSync(ctx, false); }
  }

  // ================= Desktop (1440, 1101) =================
  if (want("desktop")) {
    for (const [dw, dh] of [[1440, 900], [1101, 900]]) {
      // a tab switch: one XHR, no document load, ends on the empty work pane and the new tab
      {
        const { page } = await deskPage(ctx, dw, dh);
        try {
          await go(page, ctx.baseUrl + "/item/1");
          try { await page.waitForSelector("#queuepane .qtab", { timeout: 8000 }); } catch (e) { /* probe */ }
          await idle(page);
          await page.evaluate(() => { window.__axMarker = 1; });
          const tr = track(page);
          await page.click('a.qtab[href*="show=done"]');
          try { await page.waitForFunction(() => { const t = document.querySelector(".qtab.on"); return !!t && /show=done/.test(t.getAttribute("href")); }, { timeout: 8000 }); } catch (e) { /* probe */ }
          await idle(page);
          const st = await page.evaluate(() => ({
            marker: window.__axMarker, url: location.pathname + location.search,
            empty: !!document.querySelector("#workpane .empty-state"), hasItem: !!document.querySelector("#workpane .has-item"),
            axDetail: document.body.classList.contains("ax-detail"), title: document.title,
            cards: document.querySelectorAll("#qlist a.qcard").length,
          }));
          const xhr = tr.log.filter((x) => x.type === "xhr" || x.type === "fetch");
          const navs = tr.navs();
          tr.stop();
          push("P3-D-tab-swap-empty-pane-" + dw, xhr.length === 1 && isQueue(xhr[0]) && navs.length === 0 && st.marker === 1 && st.empty && !st.hasItem && !st.axDetail && /show=done/.test(st.url),
            { xhr: xhr.map((x) => x.method + " " + x.url), navs: navs.map((x) => x.url), state: st });
        } finally { await page.close().catch(() => {}); }
      }
      setSync(ctx, true);
      try {
        // with the sync lock set, the visible unpaged list still refreshes (sec 8)
        {
          const { page } = await deskPage(ctx, dw, dh);
          try {
            await go(page, ctx.baseUrl + "/");
            const sec = await page.evaluate(() => window.__axQPoll && window.__axQPoll.sec);
            const tr = track(page);
            // keep the server's sec (8); last = 0 makes the next 2 s tick due
            await page.evaluate(() => { window.__axQPoll.last = 0; });
            await sleep(5000);
            const q = tr.log.filter(isQueue);
            tr.stop();
            push("P3-D-sync-refresh-" + dw, sec === 8 && q.length >= 1, { pollSecFromServer: sec, queueRequests: q.map((x) => x.url) });
          } finally { await page.close().catch(() => {}); }
        }
        // a Load more'd list never swaps
        {
          const { page } = await deskPage(ctx, dw, dh);
          try {
            await go(page, ctx.baseUrl + "/?show=done");
            await page.click("#qmore");
            try { await page.waitForFunction(() => document.querySelectorAll("#qlist a.qcard").length >= 100, { timeout: 8000 }); } catch (e) { /* probe */ }
            await idle(page);
            const tr = track(page);
            await page.evaluate(() => { window.__axQPoll.sec = 1; window.__axQPoll.last = 0; });
            await sleep(5000);
            const q = tr.log.filter(isQueue);
            const n = await cardCount(page);
            tr.stop();
            push("P3-M12-after-load-more-no-swap-" + dw, q.length === 0 && n === 100, { queueRequests: q.map((x) => x.url), cards: n });
          } finally { await page.close().catch(() => {}); }
        }
      } finally { setSync(ctx, false); }
    }
  }

  const pass = results.every((r) => r.pass);
  return { phase: "3", pass, assertions: results };
}

module.exports = { assert, GROUPS };
