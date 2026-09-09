// Hermetic host-direct browser runner (no MCP server, no @playwright/test, no host npm install).
//
// Resolves chromium + playwright-core from the immutable nix store at runtime — NEVER hardcode a
// store hash (they are garbage-collected over time). Targets the no-Clerk DEV_USER stack:
// frontend :5173, backend :8000 (CLERK_ENABLED=false). Requires a host node that can read
// /nix/store (repo flake: `nix develop .`).
//
// CJS by design: playwright-core is a CommonJS package and ESM cannot `import ... from <expr>`.
//
// Usage (from repo root):
//   nix develop . -c node .pi/skills/hermetic-e2e/scripts/e2e.cjs             # onboarding nav only
//   nix develop . -c node .pi/skills/hermetic-e2e/scripts/e2e.cjs --feedback  # + send turn + Complete
//   E2E_BASE=http://localhost:5173 node .pi/skills/hermetic-e2e/scripts/e2e.cjs --feedback
//
// Cleanup: created interviews are real DEV_USER rows; the script prints their ids.
'use strict';
const fs = require("fs");
const path = require("path");

const BASE = process.env.E2E_BASE ?? "http://localhost:5173";
const NIX = process.env.NIX_STORE_DIR ?? "/nix/store";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolvePcore() {
  for (const name of fs.readdirSync(NIX).filter((n) => n.includes("playwright-core-") && !n.endsWith(".drv"))) {
    const ix = path.join(NIX, name, "index.js");
    if (fs.existsSync(ix)) return ix;
  }
  throw new Error("playwright-core index.js not found under " + NIX);
}
function resolveChrome() {
  for (const name of fs.readdirSync(NIX).filter((n) => n.includes("playwright-chromium") && !n.endsWith(".drv"))) {
    const cand = path.join(NIX, name, "chrome-linux64", "chrome");
    if (fs.existsSync(cand)) return cand;
  }
  throw new Error("playwright chromium executable not found under " + NIX);
}

const pcore = require(resolvePcore());
const CHROME_BIN = resolveChrome();

async function main() {
  const wantFeedback = process.argv.includes("--feedback");
  console.log("chromium:", CHROME_BIN);
  const browser = await pcore.chromium.launch({
    executablePath: CHROME_BIN,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage();
  const createdIds = [];

  try {
    // Landing -> Get started -> /app.
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.getByText("Get started", { exact: false }).first().click();
    await page.waitForURL(/\/app/, { timeout: 15000 });
    console.log("  \u2713 Landing -> /app");

    // New interview.
    await page.fill("#role", process.env.E2E_ROLE ?? "Software Engineer QA Walkthrough");
    await page.fill("#topic", process.env.E2E_TOPIC ?? "host-direct feedback e2e");
    await page.getByRole("button", { name: /start interview/i }).click();
    await page.waitForURL(/\/interviews\/[0-9a-f-]+/, { timeout: 15000 });
    const m = page.url().match(/\/interviews\/([0-9a-f-]+)/);
    if (m) createdIds.push(m[1]);
    console.log("  \u2713 created interview", page.url().replace(BASE, ""));

    if (!wantFeedback) {
      console.log("  \u2013 navigation-only (pass --feedback to exercise Complete/scoring).");
      return;
    }

    // Chat ready (textarea visible), then send a substantive first answer.
    const ta = page.locator("textarea");
    await ta.waitFor({ state: "visible", timeout: 20000 });
    await ta.fill(
      process.env.E2E_ANSWER ??
        "I built a distributed scoring service for an interview coach. I used a two-stage pipeline to keep live chat low-latency while deep analysis ran offline, trading consistency for latency with an event-driven read model.",
    );
    await page.getByRole("button", { name: /^Send$/ }).click();

    // Wait until the interviewer finishes streaming and Complete is enabled again.
    const completeBtn = page.getByRole("button", { name: /^Complete/ });
    await completeBtn.waitFor({ state: "visible", timeout: 20000 });
    for (let i = 0; i < 200 && (await completeBtn.isDisabled()); i++) await sleep(500);
    await completeBtn.click();
    console.log("  \u2713 clicked Complete");

    // Outcome A: FeedbackView (its card body reads "Your performance summary").
    // Outcome B: retry notice ("scoring wasn't ready") -> click Retry scoring and re-poll.
    // 90s deadline: on qwen/llama, /complete runs inline and blocks across the calls.
    const deadline = Date.now() + 90_000;
    let state = null;
    while (Date.now() < deadline) {
      const body = await page.locator("body").innerText().catch(() => "");
      if (body.includes("Your performance summary")) {
        state = "feedback";
        break;
      }
      if (body.includes("scoring wasn't ready")) {
        const retryBtn = page.getByRole("button", { name: /retry scoring/i });
        if ((await retryBtn.count()) > 0 && (await retryBtn.isVisible())) {
          console.log("  \u2713 feedback absent -> clicked Retry scoring");
          await retryBtn.click();
          await page.waitForTimeout(1500);
        }
      }
      await sleep(700);
    }
    if (!state) state = "timed-out";

    const body = await page.locator("body").innerText();
    console.log("\n[result excerpt]\n" + body.slice(0, 900).replace(/\n+/g, "\n"));
    if (state === "feedback") console.log("PASS feedback rendered after Complete");
    else if (state === "timed-out") console.log("FAIL timed out waiting for feedback/retry state");
    else console.log("unknown state:", state);
    if (createdIds.length) console.log("created interviews (DELETE /interviews/<id> if unwanted): " + createdIds.join(","));
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error("e2e failed:", e.message);
  process.exit(1);
});
