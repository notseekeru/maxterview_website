// Drive the same hermetic onboarding journey and DUMP the live DOM at each stage so an agent
// can see what is actually rendered (not just assert on checkpoints). Host-direct playwright-core
// resolved from /nix/store at runtime (no @playwright/test, no host npm install). CJS by design.
//
// Usage (from repo root), backend must be CLERK_ENABLED=false (DEV_USER / hermetic):
//   nix develop . -c node .pi/skills/hermetic-e2e/scripts/inspect.cjs
//   nix develop . -c node .pi/skills/hermetic-e2e/scripts/inspect.cjs --dom        # raw innerHTML per stage
//   E2E_BASE=... E2E_ROLE=... E2E_TOPIC=... nix develop . -c node .pi/skills/hermetic-e2e/scripts/inspect.cjs
'use strict';
const fs = require("fs");
const path = require("path");

const BASE = process.env.E2E_BASE ?? "http://localhost:5173";
const NIX = process.env.NIX_STORE_DIR ?? "/nix/store";
const RAW_DOM = process.argv.includes("--dom");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolvePcore() {
  for (const n of fs.readdirSync(NIX).filter((n) => n.includes("playwright-core-") && !n.endsWith(".drv"))) {
    const ix = path.join(NIX, n, "index.js");
    if (fs.existsSync(ix)) return ix;
  }
  throw new Error("playwright-core index.js not found under " + NIX);
}
function resolveChrome() {
  for (const n of fs.readdirSync(NIX).filter((n) => n.includes("playwright-chromium") && !n.endsWith(".drv"))) {
    const c = path.join(NIX, n, "chrome-linux64", "chrome");
    if (fs.existsSync(c)) return c;
  }
  throw new Error("playwright chromium not found under " + NIX);
}

const pcore = require(resolvePcore());
const CHROME_BIN = resolveChrome();

async function dump(page, label) {
  console.log("\n\n========== DOM @ " + label + " ==========");
  console.log("URL:", page.url().replace(BASE, "") || "/");
  if (RAW_DOM) {
    const html = await page.content();
    console.log(html.slice(0, 4000));
  } else {
    console.log(await page.locator("body").innerText().catch(() => "(no body)"));
  }
}

async function main() {
  console.log("chromium:", CHROME_BIN);
  const browser = await pcore.chromium.launch({
    executablePath: CHROME_BIN,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let created = [];
  try {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await dump(page, "landing /");

    await page.getByText("Get started", { exact: false }).first().click();
    await page.waitForURL(/\/app/, { timeout: 15000 });
    // wait for actual dashboard chrome (role input) so we don't dump a mid-transition Landing frame
    await page.locator("#role").waitFor({ state: "visible", timeout: 15000 });
    await dump(page, "dashboard /app (role input visible)");

    // Need to type into the form before dumping the post-input structure.
    await page.fill("#role", process.env.E2E_ROLE ?? "Software Engineer Inspect Run");
    await page.fill("#topic", process.env.E2E_TOPIC ?? "dom inspection");
    await page.getByRole("button", { name: /start interview/i }).click();
    await page.waitForURL(/\/interviews\/[0-9a-f-]+/, { timeout: 15000 });
    const m = page.url().match(/\/interviews\/([0-9a-f-]+)/);
    if (m) created.push(m[1]);
    await dump(page, "interview chat /interviews/<id>");

    // Wait for the chat textarea to actually mount (auto-calls startInterview on mount).
    const ta = page.locator("textarea");
    await ta.waitFor({ state: "visible", timeout: 20000 });
    await dump(page, "interview chat (textarea mounted)");
  } finally {
    await browser.close();
  }
  if (created.length) console.log("\n\ncreated interviews (DELETE /interviews/<id> if unwanted): " + created.join(","));
}

main().catch((e) => {
  console.error("inspect failed:", e.message);
  process.exit(1);
});
