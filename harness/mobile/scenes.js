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
  { id: "item-customer", path: "/item/1", customerModal: true },
  { id: "blocks", path: "/blocks" },
  { id: "audit", path: "/audit" },
  { id: "block-page", path: "/item/1/block" },
  { id: "sprocket-requests", path: "/sprocket/requests" },
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
