// phase-2.js - Phase 2 acceptance assertions (mobile plan section 3.6). Exports
// `async function assert(ctx)`, same shape as phase-0.js / phase-1a.js / phase-1b.js: the
// bottom action bar, the recipient line, the overflow sheet, the auto-growing reply editor,
// autosave and the keyboard tracker. ctx additionally carries `dbPath` (the temp fixture DB
// harness/mobile/boot.js seeded), needed by the autosave assertions to change the
// server-rendered draft out from under a page that already has local edits.
"use strict";
const { DatabaseSync } = require("node:sqlite");
const { newPage } = require("./pptr.js");
const { findScene, openScene } = require("./scenes.js");

function widthByPx(ctx, px) {
  const w = ctx.widths.find((w) => w.width === px);
  if (!w) throw new Error("phase-2 needs a --widths entry at " + px + "px");
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

async function gotoItem(ctx, width, id, opts) {
  const { page, consoleErrors } = await newPage(ctx.browser, {
    width: width.width, height: width.height, deviceScaleFactor: 1,
    isMobile: true, hasTouch: true, lang: (opts && opts.lang) || "en", baseUrl: ctx.baseUrl,
  });
  await page.goto(ctx.baseUrl + "/item/" + id, { waitUntil: "networkidle0" });
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

function rectOf(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
}

// Types at the end of a field's existing value (a real keyboard walk, not a value assign),
// so autosave's debounce/input listeners fire exactly the way a person typing would trigger them.
async function typeAtEnd(page, sel, text) {
  await page.focus(sel);
  await page.evaluate((s) => {
    const el = document.querySelector(s);
    el.setSelectionRange(el.value.length, el.value.length);
  }, sel);
  await page.keyboard.type(text, { delay: 5 });
}

function readKeys(page) {
  return page.evaluate(() => {
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith("axle.")) ls[k] = localStorage.getItem(k); }
    const ss = {};
    for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k.startsWith("axle.")) ss[k] = sessionStorage.getItem(k); }
    return { ls, ss };
  });
}

function readNote(page) {
  return page.evaluate(() => {
    const n = document.querySelector(".restored-note");
    if (!n) return null;
    const r = n.getBoundingClientRect();
    const txt = n.querySelector(".rn-text");
    return {
      visible: r.height > 0 && getComputedStyle(n).display !== "none",
      text: txt ? txt.textContent : "",
      hasRestore: !!n.querySelector(".rn-restore"),
      hasDiscard: !!n.querySelector(".rn-discard"),
    };
  });
}

function readReply(page) {
  return page.evaluate(() => { const r = document.getElementById("replybox"); return r ? r.value : null; });
}

async function assert(ctx) {
  const results = [];
  const push = (id, pass, detail) => results.push({ id, pass: !!pass, detail });
  const w393 = widthByPx(ctx, 393);
  const w375 = widthByPx(ctx, 375);

  // ---- 1: bottom bar - fixed, docked to viewport bottom, height cap, row 1 never clipped -----
  for (const width of [w393, w375]) {
    for (const id of [1, 4]) {
      const { page } = await gotoItem(ctx, width, id);
      try {
        const probe = await page.evaluate(() => {
          const bar = document.querySelector(".actionbar");
          const cs = bar ? getComputedStyle(bar) : null;
          const barR = bar ? bar.getBoundingClientRect() : null;
          const sum = document.querySelector(".actionbar summary.send-caret");
          return {
            position: cs ? cs.position : null,
            barBottom: barR ? barR.bottom : null,
            barHeight: barR ? barR.height : null,
            innerHeight: window.innerHeight,
            sumScrollWidth: sum ? sum.scrollWidth : null,
            sumClientWidth: sum ? sum.clientWidth : null,
          };
        });
        const posOk = probe.position === "fixed";
        const bottomOk = probe.barBottom !== null && Math.abs(probe.barBottom - probe.innerHeight) <= 1;
        const heightOk = probe.barHeight !== null && probe.barHeight <= 120;
        const noClip = probe.sumScrollWidth !== null && probe.sumScrollWidth <= probe.sumClientWidth + 1;
        push("bar-fixed-" + id + "-" + width.width, posOk && bottomOk && heightOk && noClip, { probe });
      } finally { await page.close().catch(() => {}); }
    }
  }

  // ---- 2: reading area between the item app bar and the bottom bar --------------------------
  for (const width of [w393, w375]) {
    for (const id of [1, 4]) {
      const { page } = await gotoItem(ctx, width, id);
      try {
        const probe = await page.evaluate(() => {
          const mback = document.querySelector(".pane-center > .m-back");
          const bar = document.querySelector(".actionbar");
          return {
            backBottom: mback ? mback.getBoundingClientRect().bottom : null,
            barTop: bar ? bar.getBoundingClientRect().top : null,
          };
        });
        const gap = (probe.barTop !== null && probe.backBottom !== null) ? probe.barTop - probe.backBottom : null;
        const minGap = width.width === 393 ? 684 : 644;
        push("reading-area-" + id + "-" + width.width, gap !== null && gap >= minGap, { probe, gap, minGap });
      } finally { await page.close().catch(() => {}); }
    }
  }

  // ---- 3: recipient line / Send spacing; overflow "..." size and spacing from Send ----------
  for (const width of [w393, w375]) {
    const { page } = await gotoItem(ctx, width, 1);
    try {
      const probe = await page.evaluate(() => {
        function r(el) { if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, right: b.right, bottom: b.bottom, w: b.width, h: b.height }; }
        const line = document.querySelector(".actionbar summary.send-caret .recip-line");
        const send = document.querySelector(".actionbar button.send.send-stack, .actionbar button.send-ph");
        const more = document.querySelector(".actionbar > details.menu:not(.recip-pop) > summary");
        return { line: r(line), send: r(send), more: r(more) };
      });
      const lineToSendOk = !!probe.line && !!probe.send && gapV(probe.line, probe.send) >= 8;
      const moreSizeOk = !!probe.more && Math.abs(probe.more.w - 44) < 1 && Math.abs(probe.more.h - 44) < 1;
      const moreToSendOk = !!probe.more && !!probe.send && gapH(probe.more, probe.send) >= 8;
      push("bar-spacing-" + width.width, lineToSendOk && moreSizeOk && moreToSendOk, { probe });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- 4: item 4 - needs-recipient state, disabled Send, tap opens the recipient sheet ------
  for (const width of [w393, w375]) {
    const { page } = await gotoItem(ctx, width, 4);
    try {
      const before = await page.evaluate(() => {
        const need = document.querySelector(".actionbar summary.send-caret .recip-line.need");
        const ph = document.querySelector(".actionbar button.send-ph");
        return { needText: need ? need.textContent.replace(/\s+/g, " ").trim() : null, phDisabled: ph ? ph.disabled : null };
      });
      const needOk = !!before.needText && before.needText.includes("Confirm recipient") && before.needText.includes("no recipient yet");
      const phOk = before.phDisabled === true;
      await page.click(".actionbar details.recip-pop > summary.send-caret");
      await new Promise((r) => setTimeout(r, 150));
      const after = await page.evaluate(() => {
        const d = document.querySelector("details.recip-pop");
        const list = d ? d.querySelector(".menu-list") : null;
        const r = list ? list.getBoundingClientRect() : null;
        return { open: d ? d.open : false, listW: r ? r.width : null, innerWidth: window.innerWidth };
      });
      const openOk = after.open === true;
      const spanOk = after.listW !== null && Math.abs(after.listW - after.innerWidth) <= 1;
      push("recip-needed-" + width.width, needOk && phOk && openOk && spanOk, { before, after });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- 5: item 1 - Send raises the native confirm, dismissing it sends no request -----------
  for (const width of [w393, w375]) {
    const { page } = await gotoItem(ctx, width, 1);
    try {
      let sendReqs = 0;
      page.on("request", (r) => { if (r.url().includes("/send")) sendReqs++; });
      await page.evaluate(() => { window.__conf = []; window.confirm = (t) => { window.__conf.push(t); return false; }; });
      await page.click(".actionbar button.send.send-stack");
      await new Promise((r) => setTimeout(r, 500));
      const c = await page.evaluate(() => ({ conf: window.__conf, dc: document.querySelector(".actionbar button.send").getAttribute("data-confirm") }));
      const oneCall = c.conf.length === 1;
      const sameText = oneCall && c.conf[0] === c.dc && !!c.dc;
      push("send-confirm-" + width.width, oneCall && sameText && sendReqs === 0, { conf: c.conf, dc: c.dc, sendReqs });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- 6: overflow sheet rows -----------------------------------------------------------------
  const OVERFLOW_ROWS = ["Save & redraft", "Mark done", "Save", "Resolved by phone", "Archive", "Block sender"];
  for (const width of [w393, w375]) {
    // item 1: every row present, >=44px tall, visible secondary line
    {
      const { page } = await gotoItem(ctx, width, 1);
      try {
        await page.click(".actionbar > details.menu:not(.recip-pop) > summary");
        await new Promise((r) => setTimeout(r, 150));
        const rows = await page.evaluate(() => {
          const d = document.querySelector(".actionbar > details.menu:not(.recip-pop)");
          return Array.from(d.querySelectorAll(".menu-list button")).filter((b) => b.getClientRects().length).map((b) => {
            const r = b.getBoundingClientRect();
            const bEl = b.querySelector("b"), sp = b.querySelector("span");
            const sr = sp ? sp.getBoundingClientRect() : null;
            return {
              label: bEl ? bEl.textContent.trim() : b.textContent.trim(),
              h: r.height,
              spanVisible: !!(sr && sr.height > 0 && getComputedStyle(sp).display !== "none"),
            };
          });
        });
        let ok = true;
        const missing = [];
        for (const label of OVERFLOW_ROWS) {
          const row = rows.find((r) => r.label === label);
          if (!row || row.h < 44 || !row.spanVisible) { ok = false; missing.push(label); }
        }
        push("overflow-rows-item1-" + width.width, ok, { rows, missing });
      } finally { await page.close().catch(() => {}); }
    }
    // item 5 (compose): no Block sender row
    {
      const { page } = await gotoItem(ctx, width, 5);
      try {
        await page.click(".actionbar > details.menu:not(.recip-pop) > summary");
        await new Promise((r) => setTimeout(r, 150));
        const labels = await page.evaluate(() => {
          const d = document.querySelector(".actionbar > details.menu:not(.recip-pop)");
          return Array.from(d.querySelectorAll(".menu-list button b")).map((b) => b.textContent.trim());
        });
        push("overflow-no-block-item5-" + width.width, !labels.includes("Block sender"), { labels });
      } finally { await page.close().catch(() => {}); }
    }
    // item 6 (done): Reopen button, no Send
    {
      const { page } = await gotoItem(ctx, width, 6);
      try {
        const probe = await page.evaluate(() => {
          const bar = document.querySelector(".actionbar");
          const reopen = bar ? bar.querySelector("button[value=reopen]") : null;
          const send = bar ? bar.querySelector(".send") : null;
          return { closed: bar ? bar.classList.contains("closed") : false, reopenText: reopen ? reopen.textContent.trim() : null, hasSend: !!send };
        });
        push("bar-closed-item6-" + width.width, probe.closed && probe.reopenText === "Reopen" && !probe.hasSend, { probe });
      } finally { await page.close().catch(() => {}); }
    }
    // item 3 (injection): a .note in the bar, no Send
    {
      const { page } = await gotoItem(ctx, width, 3);
      try {
        const probe = await page.evaluate(() => {
          const bar = document.querySelector(".actionbar");
          const note = bar ? bar.querySelector(".note") : null;
          const send = bar ? bar.querySelector(".send") : null;
          return { hasNote: !!note, noteVisible: !!note && note.getClientRects().length > 0, hasSend: !!send };
        });
        push("bar-injection-item3-" + width.width, probe.hasNote && probe.noteVisible && !probe.hasSend, { probe });
      } finally { await page.close().catch(() => {}); }
    }
  }

  // ---- 7: auto-growing editors - font-size, resize:none, no inner scroll after growth -------
  for (const width of [w393, w375]) {
    const { page } = await gotoItem(ctx, width, 1);
    try {
      const before = await page.evaluate(() => {
        const el = document.getElementById("replybox");
        const cs = getComputedStyle(el);
        return { fontSize: cs.fontSize, resize: cs.resize };
      });
      await page.evaluate(() => {
        const el = document.getElementById("replybox");
        el.value = Array.from({ length: 40 }, (_, i) => "Line " + (i + 1)).join("\n");
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await new Promise((r) => setTimeout(r, 100));
      const after = await page.evaluate(() => {
        const el = document.getElementById("replybox");
        return { diff: el.scrollHeight - el.clientHeight };
      });
      const ok = before.fontSize === "16px" && before.resize === "none" && after.diff <= 2;
      push("editor-grow-replybox-" + width.width, ok, { before, after });
    } finally { await page.close().catch(() => {}); }
  }
  for (const width of [w393, w375]) {
    const { page } = await gotoItem(ctx, width, 2);
    try {
      const probe = await page.evaluate(() => {
        const a = document.querySelector("textarea.ans");
        if (!a) return null;
        const cs = getComputedStyle(a);
        return { fontSize: cs.fontSize, resize: cs.resize };
      });
      let diffOk = true;
      if (probe) {
        await page.evaluate(() => {
          const a = document.querySelector("textarea.ans");
          a.value = Array.from({ length: 12 }, (_, i) => "Ans " + i).join("\n");
          a.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await new Promise((r) => setTimeout(r, 100));
        const diff = await page.evaluate(() => { const a = document.querySelector("textarea.ans"); return a.scrollHeight - a.clientHeight; });
        diffOk = diff <= 2;
      }
      const ok = !!probe && probe.fontSize === "16px" && probe.resize === "none" && diffOk;
      push("editor-grow-ans-" + width.width, ok, { probe });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- 8: autosave -----------------------------------------------------------------------------
  {
    const dbPath = ctx.dbPath;
    const sql = (q, ...p) => { const d = new DatabaseSync(dbPath); try { return d.prepare(q).run(...p); } finally { d.close(); } };

    // 8a: type, wait 1s: localStorage holds the typed text
    const { page } = await gotoItem(ctx, w393, 1);
    try {
      await typeAtEnd(page, "#replybox", " TYPED-A");
      await new Promise((r) => setTimeout(r, 1000));
      const k = await readKeys(page);
      let d1 = null;
      try { d1 = JSON.parse(k.ls["axle.draft.1"] || "null"); } catch (e) { d1 = null; }
      push("autosave-writes-key-393", !!d1 && typeof d1.reply === "string" && d1.reply.endsWith(" TYPED-A"), { keys: k });

      // 8b: reload restores text + shows the note
      await page.reload({ waitUntil: "networkidle0" });
      await new Promise((r) => setTimeout(r, 200));
      const reply1 = await readReply(page);
      const note1 = await readNote(page);
      push("autosave-restores-on-reload-393", !!reply1 && reply1.endsWith(" TYPED-A") && !!note1 && note1.visible, { reply1, note1 });
    } finally { await page.close().catch(() => {}); }

    // 8c: item 4 - type, confirm recipient via the real form, text survives the redirect
    {
      const { page } = await gotoItem(ctx, w393, 4);
      try {
        await typeAtEnd(page, "#replybox", " TYPED-CF");
        await new Promise((r) => setTimeout(r, 1000));
        await page.click(".actionbar details.recip-pop > summary.send-caret");
        await new Promise((r) => setTimeout(r, 150));
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle0" }),
          page.click("details.recip-pop form.recip-known button[name=use]"),
        ]);
        await new Promise((r) => setTimeout(r, 150));
        const reply4 = await readReply(page);
        push("autosave-survives-recipient-change-393", !!reply4 && reply4.endsWith(" TYPED-CF"), { reply4 });
      } finally { await page.close().catch(() => {}); }
    }

    // 8d/e/f: item 1 - server text changes underneath, offer appears, Restore, then Discard
    {
      const { page } = await gotoItem(ctx, w393, 1);
      try {
        await typeAtEnd(page, "#replybox", " LOCAL-B");
        await new Promise((r) => setTimeout(r, 1000));
        sql("UPDATE work_items SET draft_edit = ? WHERE id = 1", "SERVER CHANGED TEXT");
        await page.reload({ waitUntil: "networkidle0" });
        await new Promise((r) => setTimeout(r, 200));
        const field1 = await readReply(page);
        const note2 = await readNote(page);
        const offerOk = field1 === "SERVER CHANGED TEXT" && !!note2 && note2.visible && note2.hasRestore && note2.hasDiscard;
        push("autosave-conflict-offer-393", offerOk, { field1, note2 });

        await page.click(".restored-note .rn-restore");
        await new Promise((r) => setTimeout(r, 150));
        const field2 = await readReply(page);
        const noteGone = (await readNote(page)) === null;
        push("autosave-restore-click-393", !!field2 && field2.endsWith(" LOCAL-B") && noteGone, { field2 });

        // fresh conflict, then Discard
        await typeAtEnd(page, "#replybox", " LOCAL-C");
        await new Promise((r) => setTimeout(r, 1000));
        sql("UPDATE work_items SET draft_edit = ? WHERE id = 1", "SERVER CHANGED AGAIN");
        await page.reload({ waitUntil: "networkidle0" });
        await new Promise((r) => setTimeout(r, 200));
        const note3 = await readNote(page);
        if (note3 && note3.hasDiscard) {
          await page.click(".restored-note .rn-discard");
          await new Promise((r) => setTimeout(r, 150));
        }
        const k3 = await readKeys(page);
        push("autosave-discard-393", !("axle.draft.1" in k3.ls), { note3, keysAfter: k3 });
      } finally { await page.close().catch(() => {}); }
    }

    // 8g: Save (overflow mirror row) clears the key after landing
    {
      const { page } = await gotoItem(ctx, w393, 1);
      try {
        await typeAtEnd(page, "#replybox", " SAVE-ME");
        await new Promise((r) => setTimeout(r, 1000));
        const beforeKeys = await readKeys(page);
        const hadKey = "axle.draft.1" in beforeKeys.ls;
        await page.click(".actionbar > details.menu:not(.recip-pop) > summary");
        await new Promise((r) => setTimeout(r, 150));
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle0" }),
          page.click(".actionbar .menu-list button[value=save]"),
        ]);
        await new Promise((r) => setTimeout(r, 200));
        const afterKeys = await readKeys(page);
        push("autosave-save-clears-key-393", hadKey && !("axle.draft.1" in afterKeys.ls) && !("axle.pending.1" in afterKeys.ss), { hadKey, afterKeys });
      } finally { await page.close().catch(() => {}); }
    }

    // 8h: item 1's key survives landing on an item with no #workform (item 6)
    {
      const { page } = await gotoItem(ctx, w393, 1);
      try {
        await typeAtEnd(page, "#replybox", " KEEP-ME");
        await new Promise((r) => setTimeout(r, 1000));
        const before = await readKeys(page);
        const hadKey = "axle.draft.1" in before.ls;
        await page.goto(ctx.baseUrl + "/item/6", { waitUntil: "networkidle0" });
        await new Promise((r) => setTimeout(r, 100));
        const after = await readKeys(page);
        push("autosave-key-kept-no-workform-393", hadKey && ("axle.draft.1" in after.ls), { hadKey, after });
      } finally { await page.close().catch(() => {}); }
    }

    // 8i: "Draft kept" badge on the queue card after navigating back with a stored draft
    {
      const { page } = await gotoItem(ctx, w393, 1);
      try {
        await typeAtEnd(page, "#replybox", " QUEUE-DRAFT");
        await new Promise((r) => setTimeout(r, 1000));
        await page.goto(ctx.baseUrl + "/", { waitUntil: "networkidle0" });
        await new Promise((r) => setTimeout(r, 150));
        const dk = await page.evaluate(() => {
          const a = document.querySelector('a.qcard[href="/item/1"]');
          const b = a ? a.querySelector(".q-badges .draft-kept") : null;
          return { present: !!b, visible: !!(b && b.getClientRects().length) };
        });
        push("autosave-draft-kept-badge-393", dk.present && dk.visible, { dk });
      } finally { await page.close().catch(() => {}); }
    }

    // 8j: desktop (1440x900) never writes a draft key. localStorage is shared across every
    // page opened against this origin in this run (earlier phone-width pages in this same
    // browser already left axle.draft.* keys behind), so the pre-existing keys are cleared
    // first and the check is "typing added no new key", not "no key exists".
    {
      const { page } = await newPage(ctx.browser, { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false, lang: "en", baseUrl: ctx.baseUrl });
      try {
        await page.goto(ctx.baseUrl + "/item/1", { waitUntil: "networkidle0" });
        await page.evaluate(() => {
          for (const store of [localStorage, sessionStorage]) {
            Object.keys(store).filter((k) => k.startsWith("axle.")).forEach((k) => store.removeItem(k));
          }
        });
        await typeAtEnd(page, "#replybox", " DESKTOP-TYPED");
        await new Promise((r) => setTimeout(r, 1000));
        const k = await readKeys(page);
        const anyDraftKey = Object.keys(k.ls).some((key) => key.startsWith("axle.draft."));
        push("autosave-no-key-desktop-1440", !anyDraftKey, { keys: k });
      } finally { await page.close().catch(() => {}); }
    }
  }

  // ---- 9: keyboard tracker (--kb) --------------------------------------------------------------
  {
    const { page } = await gotoItem(ctx, w393, 1);
    try {
      const probe = await page.evaluate(() => {
        Object.defineProperty(window, "visualViewport", { value: { height: 552, offsetTop: 0, addEventListener() {} }, configurable: true });
        const ret = window.__axKb();
        const kb = getComputedStyle(document.documentElement).getPropertyValue("--kb").trim();
        const bar = document.querySelector(".actionbar").getBoundingClientRect();
        return { ret, kb, barBottom: bar.bottom, expect: innerHeight - 300 };
      });
      const kbOk = probe.kb === "300px";
      const barOk = Math.abs(probe.barBottom - probe.expect) <= 1;
      push("keyboard-kb-var-393", kbOk && barOk, { probe });
    } finally { await page.close().catch(() => {}); }
  }

  // ---- 10: every walked scene - no horizontal overflow, no console errors -------------------
  {
    const offenders = [];
    for (const entry of ctx.walk.entries) {
      if (entry.error) { offenders.push({ width: entry.width, scene: entry.scene, error: entry.error }); continue; }
      const okOverflow = entry.scrollWidth === entry.innerWidth;
      const okConsole = !entry.consoleErrors || entry.consoleErrors.length === 0;
      if (!okOverflow || !okConsole) offenders.push({ width: entry.width, scene: entry.scene, scrollWidth: entry.scrollWidth, innerWidth: entry.innerWidth, consoleErrors: entry.consoleErrors });
    }
    push("no-overflow-no-console-all-scenes", offenders.length === 0, { offenders: offenders.slice(0, 30) });
  }

  const pass = results.every((r) => r.pass);
  return { phase: "2", pass, assertions: results };
}

module.exports = { assert };
