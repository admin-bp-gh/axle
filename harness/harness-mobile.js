#!/usr/bin/env node
// harness-mobile.js - repo-only test harness for the Axle mobile redesign (mobile plan
// section 4.4, K5). Boots the real box-code routes on the Step-0 stub kit against a temp
// fixture DB (harness/step0), drives Chromium from AXLE_PPTR_DIR with puppeteer, and
// writes screenshots + JSON reports to design-reference/mobile-audit/. Never touches
// box-code, never a project dependency, never deployed.
//
// Usage: node harness/harness-mobile.js <command> [options]
//   hash                          print the data-confirm capture handler's sha256 (K7 item 4)
//   walk    [--widths] [--out] [--tree] [--lang] [--only] [--keep]
//   baseline[--widths] [--out] [--tree] [--lang] [--only] [--keep]
//   compare --baseline <dir> [--widths] [--out] [--tree] [--lang] [--only] [--mask] [--keep]
//   phase   --n <N> [--out] [--widths] [--tree] [--lang] [--keep]
"use strict";
const fs = require("fs");
const path = require("path");

const ENV = require("./mobile/env.js");
const { bootServer } = require("./mobile/boot.js");
const { launchBrowser, newPage } = require("./mobile/pptr.js");
const { SCENES, findScene, openScene } = require("./mobile/scenes.js");
const AUDITS = require("./mobile/audits.js");
const LAYOUT = require("./mobile/layout.js");

// ---- arg parsing -------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { args[key] = next; i++; }
      else args[key] = true;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function resolveTree(opts) {
  return opts.tree ? path.resolve(process.cwd(), opts.tree) : ENV.DEFAULT_TREE;
}

function isPhoneWidth(w) {
  return w.width <= 700;
}

function onlyFilter(opts) {
  return opts.only ? String(opts.only).split(",").map((s) => s.trim()).filter(Boolean) : null;
}

// ---- hash: K7 item 4 fingerprint -----------------------------------------------------
function cmdHash(opts) {
  const tree = resolveTree(opts);
  const file = path.join(tree, "views", "ui.js");
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const startMarker = "// Confirmation prompts. The text lives in the button's data-confirm attribute";
  const startIdx = lines.findIndex((l) => l.startsWith(startMarker));
  if (startIdx === -1) throw new Error("could not find the data-confirm block start (looking for a line starting with: " + startMarker + ") in " + file);
  let endIdx = -1;
  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].trim() === "})();") { endIdx = i; break; }
  }
  if (endIdx === -1) throw new Error("could not find the closing })(); for the data-confirm block");
  const block = lines.slice(startIdx, endIdx + 1).join("\n");
  const hash = ENV.sha256Hex(block);
  console.log("data-confirm capture handler (K7 item 4 fingerprint)");
  console.log("file:      " + file);
  console.log("lines:     " + (startIdx + 1) + "-" + (endIdx + 1) + " (1-based, inclusive)");
  console.log("sha256:    " + hash);
  return 0;
}

// ---- shared: the K5 headless walk ----------------------------------------------------
async function runWalk({ tree, outDir, widths, lang, only, browser, baseUrl }) {
  fs.mkdirSync(outDir, { recursive: true });
  const scenesToRun = only ? SCENES.filter((s) => only.includes(s.id)) : SCENES;
  const entries = [];
  for (const width of widths) {
    const phone = isPhoneWidth(width);
    for (const scene of scenesToRun) {
      const entry = { width: width.label, scene: scene.id };
      let page, consoleErrors;
      try {
        ({ page, consoleErrors } = await newPage(browser, {
          width: width.width, height: width.height,
          deviceScaleFactor: phone ? 3 : 1, isMobile: phone, hasTouch: phone,
          lang, baseUrl,
        }));
        const { menu } = await openScene(page, baseUrl, scene);
        await new Promise((r) => setTimeout(r, 50));

        const scrollInfo = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
        }));
        const tapAudit = await AUDITS.tapAudit(page);
        const overflow = await AUDITS.overflowAudit(page);
        const fontSize = await AUDITS.fontSizeAudit(page);
        const fixedSticky = await AUDITS.fixedStickyAudit(page);
        const sprocket = await AUDITS.sprocketRect(page);
        const phantomScroll = scene.id === "queue-open" ? await AUDITS.phantomScrollProbe(page) : null;
        const extra = {
          viewportMeta: await AUDITS.viewportMetaProbe(page),
          attachByNumber: scene.id === "item-ready" ? await AUDITS.attachByNumberProbe(page) : null,
          cusdialog: scene.id === "item-customer" ? await AUDITS.cusdialogProbe(page) : null,
          actionbarRect: scene.id === "item-ready" ? await AUDITS.rectOf(page, ".actionbar") : null,
          modalFootRect: scene.id === "compose" ? await AUDITS.rectOf(page, ".modal-foot") : null,
        };
        const pngFull = await page.screenshot({ fullPage: true });
        const pngViewport = await page.screenshot({ fullPage: false });
        fs.writeFileSync(path.join(outDir, width.label + "-" + scene.id + ".png"), pngFull);
        fs.writeFileSync(path.join(outDir, width.label + "-" + scene.id + "-viewport.png"), pngViewport);

        Object.assign(entry, scrollInfo, { tapAudit, overflow, fontSize, fixedSticky, sprocket, phantomScroll, extra, consoleErrors: consoleErrors.slice(), menu });
      } catch (err) {
        entry.error = String((err && err.stack) || err);
      } finally {
        if (page) await page.close().catch(() => {});
      }
      entries.push(entry);
    }
  }
  const walk = { generatedAt: new Date().toISOString(), tree, widths: widths.map((w) => w.label), scenes: scenesToRun.map((s) => s.id), entries };
  fs.writeFileSync(path.join(outDir, "walk.json"), JSON.stringify(walk, null, 1));
  return walk;
}

function printWalkSummary(walk) {
  console.log("\nWalk summary (" + walk.entries.length + " width x scene captures)");
  console.log("width       scene                    tap-viol  overflow  font-viol  console-err  menu");
  for (const e of walk.entries) {
    if (e.error) {
      console.log(pad(e.width, 11) + pad(e.scene, 25) + "ERROR: " + e.error.split("\n")[0]);
      continue;
    }
    const tapV = e.tapAudit ? e.tapAudit.violations.length : "-";
    const ovf = e.overflow ? (e.overflow.ok ? "ok" : "OVERFLOW") : "-";
    const fontV = e.fontSize ? e.fontSize.length : "-";
    const cerr = e.consoleErrors ? e.consoleErrors.length : "-";
    const menu = e.menu ? e.menu.method : "-";
    console.log(pad(e.width, 11) + pad(e.scene, 25) + pad(String(tapV), 10) + pad(String(ovf), 10) + pad(String(fontV), 11) + pad(String(cerr), 13) + menu);
  }
}

function pad(s, n) { s = String(s); return s + " ".repeat(Math.max(1, n - s.length)); }

async function cmdWalk(opts) {
  const tree = resolveTree(opts);
  const outDir = ENV.outDir(opts.out || "design-reference/mobile-audit/phase-pre");
  const widths = ENV.parseWidths(opts.widths || "393x852,375x812,430x932");
  const lang = opts.lang || "en";
  const only = onlyFilter(opts);
  const server = await bootServer({ tree, keep: !!opts.keep });
  const browser = await launchBrowser();
  try {
    const walk = await runWalk({ tree, outDir, widths, lang, only, browser, baseUrl: server.baseUrl });
    printWalkSummary(walk);
    console.log("\nwritten to " + outDir);
    return 0;
  } finally {
    await browser.close();
    await server.stop();
  }
}

// ---- baseline: desktop capture for 4.2 -----------------------------------------------
async function cmdBaseline(opts) {
  const tree = resolveTree(opts);
  const outDir = ENV.outDir(opts.out || "design-reference/mobile-audit/baseline-desktop");
  const widths = ENV.parseWidths(opts.widths || "1440x900,1101x900");
  const lang = opts.lang || "en";
  const only = onlyFilter(opts);
  const scenesToRun = only ? SCENES.filter((s) => only.includes(s.id)) : SCENES;
  const server = await bootServer({ tree, keep: !!opts.keep });
  const browser = await launchBrowser();
  try {
    fs.mkdirSync(outDir, { recursive: true });
    for (const width of widths) {
      for (const scene of scenesToRun) {
        const { page } = await newPage(browser, {
          width: width.width, height: width.height, deviceScaleFactor: 1, isMobile: false, hasTouch: false,
          freezeClock: true, lang, baseUrl: server.baseUrl,
        });
        try {
          await openScene(page, server.baseUrl, scene);
          // Extra settle beyond the walk's 100ms menu wait: baseline/compare are pixel-
          // critical (4.2/K6), so give any late layout/paint (e.g. a JS menu positioner)
          // time to finish before the screenshot.
          await new Promise((r) => setTimeout(r, 300));
          const png = await page.screenshot({ fullPage: true });
          const layout = await LAYOUT.layoutSnapshot(page);
          const dom = await LAYOUT.domSnapshot(page);
          fs.writeFileSync(path.join(outDir, width.label + "-" + scene.id + ".png"), png);
          fs.writeFileSync(path.join(outDir, width.label + "-" + scene.id + ".layout.json"), JSON.stringify(layout, null, 1));
          fs.writeFileSync(path.join(outDir, width.label + "-" + scene.id + ".dom.html"), dom);
          console.log("captured " + width.label + " " + scene.id);
        } finally {
          await page.close().catch(() => {});
        }
      }
    }
    const manifest = { generatedAt: new Date().toISOString(), tree, widths: widths.map((w) => w.label), scenes: scenesToRun.map((s) => s.id) };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));
    console.log("\nbaseline written to " + outDir);
    return 0;
  } finally {
    await browser.close();
    await server.stop();
  }
}

// ---- compare: re-capture + diff against a baseline ------------------------------------
async function cmdCompare(opts) {
  if (!opts.baseline) throw new Error("compare requires --baseline <dir>");
  const tree = resolveTree(opts);
  const baselineDir = ENV.outDir(opts.baseline);
  const outDir = ENV.outDir(opts.out || "design-reference/mobile-audit/compare");
  const manifest = JSON.parse(fs.readFileSync(path.join(baselineDir, "manifest.json"), "utf8"));
  const widths = ENV.parseWidths(opts.widths || manifest.widths.join(","));
  const lang = opts.lang || "en";
  const maskSelectors = opts.mask ? String(opts.mask).split(",").map((s) => s.trim()).filter(Boolean) : [".qlive"];
  const only = onlyFilter(opts);
  const scenesToRun = only ? manifest.scenes.filter((id) => only.includes(id)) : manifest.scenes;

  const server = await bootServer({ tree, keep: !!opts.keep });
  const browser = await launchBrowser();
  try {
    fs.mkdirSync(outDir, { recursive: true });
    const report = { generatedAt: new Date().toISOString(), tree, baselineDir, results: [] };
    let anyDiff = false;

    for (const width of widths) {
      for (const sceneId of scenesToRun) {
        const scene = findScene(sceneId);
        const basePngPath = path.join(baselineDir, width.label + "-" + sceneId + ".png");
        const baseLayoutPath = path.join(baselineDir, width.label + "-" + sceneId + ".layout.json");
        const baseDomPath = path.join(baselineDir, width.label + "-" + sceneId + ".dom.html");
        if (!fs.existsSync(basePngPath)) {
          report.results.push({ width: width.label, scene: sceneId, error: "no baseline capture at this width/scene" });
          anyDiff = true;
          continue;
        }

        const { page } = await newPage(browser, {
          width: width.width, height: width.height, deviceScaleFactor: 1, isMobile: false, hasTouch: false,
          freezeClock: true, lang, baseUrl: server.baseUrl,
        });
        let curPng, curLayout, curDom, maskRects;
        try {
          await openScene(page, server.baseUrl, scene);
          await new Promise((r) => setTimeout(r, 300));
          curPng = await page.screenshot({ fullPage: true });
          curLayout = await LAYOUT.layoutSnapshot(page);
          curDom = await LAYOUT.domSnapshot(page);
          maskRects = await LAYOUT.maskRectsFor(page, maskSelectors);
        } finally {
          await page.close().catch(() => {});
        }

        const baseBuf = fs.readFileSync(basePngPath);
        const baseLayout = JSON.parse(fs.readFileSync(baseLayoutPath, "utf8"));
        // K6: a baseline captured by the pre-fix code has no normalisation marker - bring it
        // up to date in Chromium (real stylesheets, capture width) rather than recapturing it.
        const baseDomRaw = fs.readFileSync(baseDomPath, "utf8");
        const baseDom = await LAYOUT.renormaliseBaselineDom(browser, server.baseUrl, width, baseDomRaw);

        let pixelDiffCount = 0;
        if (!baseBuf.equals(curPng)) {
          const pixel = await LAYOUT.pixelDiff(browser, baseBuf, curPng, maskRects);
          pixelDiffCount = pixel.diffCount;
          if (pixel.diffCount > 0) {
            fs.writeFileSync(path.join(outDir, "diff-" + width.label + "-" + sceneId + ".png"), pixel.pngBuffer);
          }
        }
        const layoutDiffs = LAYOUT.diffLayout(baseLayout, curLayout);
        const domDiffs = LAYOUT.diffDom(baseDom, curDom);
        const hasDiff = pixelDiffCount > 0 || layoutDiffs.length > 0 || domDiffs.length > 0;
        if (hasDiff) anyDiff = true;
        report.results.push({ width: width.label, scene: sceneId, pixelDiffCount, layoutDiffCount: layoutDiffs.length, domDiffCount: domDiffs.length, layoutDiffs: layoutDiffs.slice(0, 30), domDiffs: domDiffs.slice(0, 30) });
        console.log((hasDiff ? "DIFF " : "ok   ") + width.label + " " + sceneId + " pixel=" + pixelDiffCount + " layout=" + layoutDiffs.length + " dom=" + domDiffs.length);
      }
    }
    fs.writeFileSync(path.join(outDir, "compare.json"), JSON.stringify(report, null, 1));
    console.log("\n" + (anyDiff ? "RESULT: DIFFERENCES FOUND" : "RESULT: identical") + " - report written to " + path.join(outDir, "compare.json"));
    return anyDiff ? 1 : 0;
  } finally {
    await browser.close();
    await server.stop();
  }
}

// ---- phase: walk + phase-N acceptance assertions ---------------------------------------
async function cmdPhase(opts) {
  const tree = resolveTree(opts);
  const n = opts.n !== undefined ? String(opts.n) : "0";
  const outDir = ENV.outDir(opts.out || ("design-reference/mobile-audit/phase-" + n));
  const widths = ENV.parseWidths(opts.widths || "393x852,375x812,430x932");
  const lang = opts.lang || "en";

  let phaseModule;
  try {
    // eslint-disable-next-line global-require
    phaseModule = require("./mobile/phase-" + n + ".js");
  } catch (e) {
    throw new Error("no assertion module harness/mobile/phase-" + n + ".js for phase " + n + " (" + e.message + ")");
  }

  const server = await bootServer({ tree, keep: !!opts.keep, phase: n });
  const browser = await launchBrowser();
  try {
    const walk = await runWalk({ tree, outDir, widths, lang, only: null, browser, baseUrl: server.baseUrl });
    printWalkSummary(walk);

    const ctx = { tree, baseUrl: server.baseUrl, browser, walk, widths };
    let result = await phaseModule.assert(ctx);
    // Phase 1A: "phase --n 1a" runs the walk plus BOTH phase-0 and phase-1a assertions -
    // phase 0 must still pass on top of the new phase-1a work.
    if (n === "1a") {
      // eslint-disable-next-line global-require
      const phase0 = require("./mobile/phase-0.js");
      const r0 = await phase0.assert(ctx);
      result = { phase: n, pass: r0.pass && result.pass, assertions: r0.assertions.concat(result.assertions) };
    }
    fs.writeFileSync(path.join(outDir, "phase-" + n + ".json"), JSON.stringify(result, null, 1));

    console.log("\nPhase " + n + " acceptance assertions:");
    for (const a of result.assertions) console.log((a.pass ? "PASS " : "FAIL ") + a.id);
    console.log("\nRESULT: " + (result.pass ? "PASS" : "FAIL") + " - report written to " + path.join(outDir, "phase-" + n + ".json"));
    return result.pass ? 0 : 1;
  } finally {
    await browser.close();
    await server.stop();
  }
}

// ---- main -----------------------------------------------------------------------------
async function main() {
  const argv = process.argv.slice(2);
  const opts = parseArgs(argv);
  const command = opts._[0];
  const commands = { hash: cmdHash, walk: cmdWalk, baseline: cmdBaseline, compare: cmdCompare, phase: cmdPhase };
  if (!command || !commands[command]) {
    console.error("usage: node harness/harness-mobile.js <hash|walk|baseline|compare|phase> [options]");
    process.exitCode = 2;
    return;
  }
  try {
    const code = await commands[command](opts);
    process.exitCode = code || 0;
  } catch (err) {
    console.error("HARNESS ERROR:", (err && err.stack) || err);
    process.exitCode = 2;
  }
}

main();
