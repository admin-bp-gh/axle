// pptr.js - launches puppeteer + @sparticuz/chromium from the sandbox node_modules dir
// (never the repo), and configures pages for deterministic capture.
"use strict";
const path = require("path");

const DEFAULT_PPTR_DIR = "/sessions/quirky-relaxed-franklin/chrome/node_modules";

async function launchBrowser() {
  const dir = process.env.AXLE_PPTR_DIR || DEFAULT_PPTR_DIR;
  const puppeteer = require(path.join(dir, "puppeteer"));
  // @sparticuz/chromium ships as an ESM-only package ("type": "module", exports map with
  // no "require" condition). Node's CJS require() resolves the bare/directory specifier
  // fine when it walks a real node_modules tree, but fails (MODULE_NOT_FOUND) resolving an
  // absolute directory path built from AXLE_PPTR_DIR via its "exports" map. Requiring the
  // built file directly sidesteps that resolution path (require(esm) still applies, giving
  // back the same {default, __esModule, ...} interop object as the bare specifier would).
  const chromiumMod = require(path.join(dir, "@sparticuz", "chromium", "build", "index.js"));
  const chromium = chromiumMod.default || chromiumMod;
  const exe = process.env.AXLE_CHROME || (await chromium.executablePath());
  const browser = await puppeteer.launch({
    executablePath: exe,
    args: [...chromium.args, "--no-sandbox"],
    headless: true,
  });
  return browser;
}

// A fresh page wired for deterministic, repeatable capture:
//  - identity via the Tailscale-User-Login header (admin sees /audit and /sprocket/requests)
//  - axle_lang cookie for --lang
//  - console error capture
//  - optional frozen clock (baseline/compare only: Date fixed to 2026-09-25T10:00:00Z)
//  - animations/transitions disabled so a same-tree screenshot is pixel-deterministic
//    (verify step b: a live "Live * updated" clock or a CSS transition would otherwise
//    make a same-tree compare non-zero)
async function newPage(browser, opts) {
  const { width, height, deviceScaleFactor = 1, isMobile = false, hasTouch = false, freezeClock = false, lang, baseUrl } = opts;
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (err) => consoleErrors.push(String(err && err.message || err)));

  await page.setExtraHTTPHeaders({ "Tailscale-User-Login": "admin@budget-parts.nl" });
  if (lang && baseUrl) {
    await page.setCookie({ name: "axle_lang", value: lang, url: baseUrl });
  }

  if (freezeClock) {
    await page.evaluateOnNewDocument(() => {
      const FIXED = new Date("2026-09-25T10:00:00Z").getTime();
      const RealDate = Date;
      class FrozenDate extends RealDate {
        constructor(...args) {
          if (args.length === 0) super(FIXED);
          else super(...args);
        }
        static now() { return FIXED; }
      }
      // eslint-disable-next-line no-global-assign
      Date = FrozenDate;
    });
  }
  await page.evaluateOnNewDocument(() => {
    window.addEventListener("DOMContentLoaded", function () {
      const style = document.createElement("style");
      style.textContent = "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }";
      document.head.appendChild(style);
    });
  });
  try {
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
  } catch (e) { /* older puppeteer without this API - animations still killed by the CSS above */ }

  await page.setViewport({ width, height, deviceScaleFactor, isMobile, hasTouch });
  return { page, consoleErrors };
}

module.exports = { launchBrowser, newPage, DEFAULT_PPTR_DIR };
