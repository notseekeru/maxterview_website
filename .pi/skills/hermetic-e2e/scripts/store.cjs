// Shared nix-store browser resolution for the hermetic-e2e host-direct runners (e2e.cjs,
// inspect.cjs). CJS because playwright-core is CommonJS; never hardcode a store hash (the store
// is garbage-collected over time). Resolve at runtime by pattern + existence check.
//
// Usage:
//   const b = require("./store.cjs");
//   const browser = await b.openBrowser();          // playwright chromium, headless
//   const page = await browser.newPage();
// b.BASE / b.sleep / b.CHROME_BIN / b.pcore also available for bespoke scripts.
"use strict";

const fs = require("fs");
const path = require("path");

const NIX = process.env.NIX_STORE_DIR ?? "/nix/store";
const BASE = process.env.E2E_BASE ?? "http://localhost:5173";

function resolvePcore() {
  for (const n of fs.readdirSync(NIX).filter((n) => n.includes("playwright-core-") && !n.endsWith(".drv"))) {
    const ix = path.join(NIX, n, "index.js");
    if (fs.existsSync(ix)) return ix;
  }
  throw new Error("playwright-core index.js not found under " + NIX);
}
function resolveChrome() {
  for (const n of fs.readdirSync(NIX).filter((n) => n.includes("playwright-chromium") && !n.endsWith(".drv"))) {
    const cand = path.join(NIX, n, "chrome-linux64", "chrome");
    if (fs.existsSync(cand)) return cand;
  }
  throw new Error("playwright chromium executable not found under " + NIX);
}

const pcore = require(resolvePcore());
const CHROME_BIN = resolveChrome();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openBrowser() {
  const { chromium } = pcore;
  return chromium.launch({
    executablePath: CHROME_BIN,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
}

module.exports = { NIX, BASE, pcore, CHROME_BIN, sleep, openBrowser };
