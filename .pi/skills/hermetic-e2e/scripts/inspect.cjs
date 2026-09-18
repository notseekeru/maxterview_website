// Drive the hermetic onboarding journey and DUMP the live DOM at each stage so an agent/human can
// see what is actually rendered (not just assert on checkpoints). Host-direct playwright-core +
// chromium resolved by ./store.cjs (no @playwright/test, no host npm install, no hardcoded store
// hashes). CJS by design.
//
// Usage (from repo root), backend must be CLERK_ENABLED=false (DEV_USER / hermetic):
//   nix develop . -c node .pi/skills/hermetic-e2e/scripts/inspect.cjs
//   nix develop . -c node .pi/skills/hermetic-e2e/scripts/inspect.cjs --dom   # raw innerHTML per stage
//   E2E_BASE=... E2E_ROLE=... E2E_TOPIC=... nix develop . -c node .../inspect.cjs
"use strict";

const { BASE, CHROME_BIN, pcore, sleep } = require("./store.cjs");
const { chromium } = pcore;
const RAW_DOM = process.argv.includes("--dom");

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
  const browser = await chromium.launch({
    executablePath: CHROME_BIN,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let created = [];
  try {
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await dump(page, "landing /");

    await page.getByRole("link", { name: /start (practicing )?free/i }).first().click();
    await page.waitForURL(/\/dashboard/, { timeout: 15000 });
    // The create form is a panel that auto-opens only on an EMPTY dashboard
    // (AppHome: showForm = formTouched ? formOpen : dims.total === 0), so on any database that
    // already has interviews it has to be opened with the toggle first. Poll for either — the
    // same dance e2e.cjs does — so this runner stops silently depending on a pristine DB.
    const newBtn = page.getByRole("button", { name: /^New interview$/ });
    let clicked = false;
    for (let i = 0; i < 40 && !(await page.locator("#role").isVisible().catch(() => false)); i++) {
      if (!clicked && (await newBtn.isVisible().catch(() => false))) {
        clicked = true;
        await newBtn.click();
      } else await sleep(250);
    }
    // wait for actual dashboard chrome (role input) so we don't dump a mid-transition Landing frame
    await page.locator("#role").waitFor({ state: "visible", timeout: 15000 });
    await dump(page, "dashboard /dashboard (role input visible)");

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
