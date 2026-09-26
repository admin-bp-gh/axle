// scenes.js - the fixed list of screens the walk/baseline/compare commands visit, and the
// navigation/setup logic to reach each one. Item ids match harness/step0/fixtures.js:
// 1 ready(de) 2 needs-answer(nl) 3 injection 4 contact-form(no recipient) 5 compose
// 6 done+sent 7 archived 8 new 9 drachten voicemail.
"use strict";

const SCENES = [
  { id: "queue-open", path: "/" },
  { id: "queue-done", path: "/?show=done" },
  { id: "queue-filter", path: "/", open: "details.qfilter" },
  { id: "queue-search-empty", path: "/", search: "zzqqxx" },
  { id: "compose", path: "/", compose: true },
  { id: "item-needs-answer", path: "/item/2" },
  { id: "item-ready", path: "/item/1" },
  { id: "item-contact-form", path: "/item/4" },
  { id: "item-compose", path: "/item/5" },
  { id: "item-done", path: "/item/6" },
  { id: "item-injection", path: "/item/3" },
  { id: "item-new", path: "/item/8" },
  { id: "item-more-actions", path: "/item/1", open: ".actionbar details.menu:not(.recip-pop)" },
  { id: "item-recipient", path: "/item/4", open: "details.recip-pop" },
  { id: "item-language", path: "/item/1", open: "details.chipmenu" },
  // M-36: on the phone the customer card lives inside the context sheet (hidden until
  // body.ax-ctx), so the customer-modal button is only reachable after opening it first;
  // ctxOpen is a no-op at desktop widths where .ctxlink is an .m-only element (the click is
  // caught and swallowed) and .pane-context is already visible in the split layout.
  { id: "item-customer", path: "/item/1", ctxOpen: true, customerModal: true },
  { id: "blocks", path: "/blocks" },
  { id: "audit", path: "/audit" },
  { id: "block-page", path: "/item/1/block" },
  { id: "sprocket-requests", path: "/sprocket/requests" },
  // Phase 1A scenes (phase-1a.js assertions)
  { id: "queue-appmenu", path: "/", open: "details.appmenu" },
  { id: "queue-search-open", path: "/", clickSearch: true },
  // Phase 1B scenes (phase-1b.js assertions)
  { id: "item-context", path: "/item/1", ctxOpen: true },
  { id: "item-customer-page", path: "/item/1", ctxOpen: true, customerModal: true },
  { id: "item-expanded", path: "/item/1", msgMore: true },
  // Phase 2 scenes (phase-2.js assertions)
  { id: "item-overflow", path: "/item/1", open: ".actionbar > details.menu:not(.recip-pop)" },
  { id: "item-restored", path: "/item/1", typeReplyThenReload: true },
  { id: "item-keyboard", path: "/item/1", kbStub: true },
  // Phase 3 scenes (phase-3.js assertions). They need the phase-3 seed (walk --phase 3):
  // 120 extra done rows (ids 100 to 219) and the forced-500 item 300.
  { id: "queue-done-paged", path: "/?show=done" },
  { id: "queue-loaded-more", path: "/?show=done", loadMore: true },
  { id: "queue-updates-chip", path: "/", updatesChip: true },
  // The forced 500 logs "Failed to load resource ... 500" (Chromium) and "Response Status
  // Error Code 500" (htmx) in the console by design.
  { id: "item-error", path: "/", forceErrorItem: 300, expectedConsole: "status of 500|Response Status Error Code 500" },
  { id: "compose-full", path: "/", compose: true },
];

function findScene(id) {
  const s = SCENES.find((x) => x.id === id);
  if (!s) throw new Error("unknown scene: " + id);
  return s;
}

async function waitHtmxIdle(page) {
  try { await page.waitForFunction(() => !!window.htmx, { timeout: 5000 }); } catch (e) { /* not every page needs it */ }
  try { await page.waitForNetworkIdle({ idleTime: 200, timeout: 5000 }); } catch (e) { /* best effort */ }
}

// Opens a <details> menu. Tries a real click on its <summary> first (the way a user
// would); if headless click doesn't flip `.open` (menus positioned via JS have been
// unreliable in headless before), falls back to setting `.open` + dispatching `toggle`
// directly. Returns which method worked, per the brief's "record which you used".
async function openDetails(page, selector) {
  const exists = await page.$(selector);
  if (!exists) return { ok: false, method: null, selector };
  let method = "click";
  try {
    const summary = await page.$(selector + " > summary");
    if (!summary) throw new Error("no summary child");
    await summary.click();
    await new Promise((r) => setTimeout(r, 100));
    const isOpen = await page.evaluate((sel) => { const el = document.querySelector(sel); return !!(el && el.open); }, selector);
    if (!isOpen) throw new Error("click did not open it");
  } catch (e) {
    method = "evaluate";
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) { el.open = true; el.dispatchEvent(new Event("toggle")); }
    }, selector);
    await new Promise((r) => setTimeout(r, 100));
  }
  return { ok: true, method, selector };
}

// Navigates `page` to `scene` at baseUrl and performs its setup (search typing, opening a
// menu, opening compose, opening the customer modal). Returns {menu} describing any menu
// interaction performed (or null), for the walk report.
async function openScene(page, baseUrl, scene) {
  await page.goto(baseUrl + scene.path, { waitUntil: "networkidle0" });
  await waitHtmxIdle(page);

  let menu = null;

  if (scene.search) {
    await page.click("#q").catch(() => {});
    await page.type("#q", scene.search, { delay: 5 });
    await new Promise((r) => setTimeout(r, 100));
  }

  if (scene.compose) {
    await page.click("#composeBtn");
    try {
      await page.waitForFunction(() => {
        const m = document.getElementById("composeModal");
        return !!m && getComputedStyle(m).display !== "none";
      }, { timeout: 5000 });
    } catch (e) { /* recorded via the scene's own audit/screenshot */ }
    await new Promise((r) => setTimeout(r, 100));
    menu = { selector: "#composeModal", method: "click" };
  }

  if (scene.open) {
    menu = await openDetails(page, scene.open);
  }

  if (scene.clickSearch) {
    await page.click(".qsearch-btn").catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    menu = { selector: ".qsearch-btn", method: "click" };
  }

  // M-36: opens the phone context sheet (body.ax-ctx) via the "Customer & docs" link.
  if (scene.ctxOpen) {
    await page.click(".ctxlink").catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    menu = { selector: ".ctxlink", method: "click" };
  }

  // M-23: expands the clamped newest message via its "Show full message" toggle.
  if (scene.msgMore) {
    await page.click(".msgmore").catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    menu = { selector: ".msgmore", method: "click" };
  }

  // Phase 2 (M-56/M-57): type into the auto-growing reply, let autosave's 600ms debounce
  // flush to localStorage, then reload so the restore path (and its "Unsaved edits
  // restored" note) runs for the walk's screenshot.
  if (scene.typeReplyThenReload) {
    await page.click("#replybox").catch(() => {});
    await page.type("#replybox", " Autosave walk text", { delay: 5 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 150));
    menu = { selector: "#replybox", method: "typeReplyThenReload" };
  }

  // Phase 2 (M-30 / M-33): stub visualViewport, run the --kb tracker, then focus the reply
  // box so the walk's screenshot shows the bar docked above the stubbed keyboard.
  if (scene.kbStub) {
    await page.evaluate(() => {
      Object.defineProperty(window, "visualViewport", { value: { height: 552, offsetTop: 0, addEventListener() {} }, configurable: true });
      if (typeof window.__axKb === "function") window.__axKb();
    });
    await page.focus("#replybox").catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    menu = { selector: "#replybox", method: "kbStub" };
  }

  // Phase 3 (C1): tap "Load more" once and wait for the second page (100 cards).
  if (scene.loadMore) {
    await page.click("#qmore").catch(() => {});
    try {
      await page.waitForFunction(() => document.querySelectorAll("#qlist a.qcard").length >= 100, { timeout: 8000 });
    } catch (e) { /* recorded via the scene's own screenshot */ }
    await waitHtmxIdle(page);
    await new Promise((r) => setTimeout(r, 100));
    menu = { selector: "#qmore", method: "click" };
  }

  // Phase 3 (M-54): the list scrolled, then the poll armed; the tick skips and shows the
  // "Updates waiting" chip. The walk has no sync lock, so the poll is armed by hand
  // (__axQPoll.sec is 0 while idle): sec = 1 and last = 0 make the next 2 s tick due.
  if (scene.updatesChip) {
    await page.evaluate(() => {
      window.scrollTo(0, 100);
      if (window.__axQPoll) { window.__axQPoll.sec = 1; window.__axQPoll.last = 0; }
      else window.__axQPoll = { sec: 1, qs: "mailbox=info&show=open&scope=all", last: 0 };
    });
    try {
      await page.waitForFunction(() => { const u = document.getElementById("qupd"); return !!u && !u.hidden && u.getBoundingClientRect().height > 0; }, { timeout: 3500 });
    } catch (e) { /* recorded via the scene's own screenshot */ }
    await new Promise((r) => setTimeout(r, 100));
    menu = { selector: "#qupd", method: "poll" };
  }

  // Phase 3 (C4 / M-51): open the forced-500 item (harness/mobile/extra-stubs.js) through
  // its queue card, falling back to the same htmx GET the card issues.
  if (scene.forceErrorItem) {
    const sel = 'a.qcard[href="/item/' + scene.forceErrorItem + '"]';
    const clicked = await page.evaluate((s) => { const a = document.querySelector(s); if (!a) return false; a.scrollIntoView({ block: "center" }); return true; }, sel);
    if (clicked) await page.click(sel).catch(() => {});
    else await page.evaluate((id) => window.htmx.ajax("GET", "/item/" + id, { target: "#workpane", swap: "innerHTML" }), scene.forceErrorItem);
    try { await page.waitForSelector("#workpane .errbox", { timeout: 8000 }); } catch (e) { /* recorded via the screenshot */ }
    await new Promise((r) => setTimeout(r, 150));
    menu = { selector: sel, method: clicked ? "click" : "htmx.ajax" };
  }

  if (scene.customerModal) {
    await page.click("button.cusbtn");
    try {
      await page.waitForFunction(() => {
        const b = document.getElementById("cusModalBody");
        return !!b && b.querySelector(".cusmodttl");
      }, { timeout: 8000 });
    } catch (e) { /* recorded via the scene's own audit/screenshot */ }
    await new Promise((r) => setTimeout(r, 100));
    menu = { selector: "#cusModal", method: "click" };
  }

  return { menu };
}

module.exports = { SCENES, findScene, openScene, openDetails, waitHtmxIdle };
