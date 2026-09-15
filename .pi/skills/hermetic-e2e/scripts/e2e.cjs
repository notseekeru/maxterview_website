// Hermetic host-direct browser journey runner — onboarding, chat + Complete scoring.
//
// No MCP server, no @playwright/test, no host npm install. Requires the nix-store chromium +
// playwright resolved by ./store.cjs (do not hardcode store hashes). Backend must be
// CLERK_ENABLED=false (DEV_USER / hermetic). Needs a host node that reads /nix/store
// (repo flake: `nix develop .`). CJS by design (playwright-core is CommonJS).
//
// Usage (from repo root):
//   nix develop . -c node .pi/skills/hermetic-e2e/scripts/e2e.cjs            # onboarding nav only
//   nix develop . -c node .pi/skills/hermetic-e2e/scripts/e2e.cjs --feedback # + send turn + Complete
//   E2E_ANSWER=... nix develop . -c node .pi/skills/hermetic-e2e/scripts/e2e.cjs --feedback
//
// Cleanup: created interviews are real DEV_USER rows; the script prints their ids.
"use strict";

const { BASE, CHROME_BIN, sleep, openBrowser } = require("./store.cjs");

async function main() {
  const wantFeedback = process.argv.includes("--feedback");
  console.log("chromium:", CHROME_BIN);
  const browser = await openBrowser();
  const page = await browser.newPage();
  const createdIds = [];

  try {
    // Landing -> Start practicing free -> /app. (The CTA is a real button, not a "Get started" link:
    // match the label by role so a hero copy tweak fails loudly here instead of timing out.)
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /start (practicing )?free/i }).first().click();
    await page.waitForURL(/\/app/, { timeout: 15000 });
    // The create form is behind a toggle whenever the owner already has interviews (it auto-opens
    // only on an empty dashboard). The toggle is not there yet on the first frame after the route
    // change, so poll for EITHER the form or the toggle: checking too early silently skips the
    // click, and clicking twice closes the form again.
    const newBtn = page.getByRole("button", { name: /^New interview$/ });
    let clicked = false;
    for (let i = 0; i < 40 && !(await page.locator("#role").isVisible().catch(() => false)); i++) {
      if (!clicked && (await newBtn.isVisible().catch(() => false))) {
        clicked = true;
        await newBtn.click();
      } else await sleep(250);
    }
    await page.locator("#role").waitFor({ state: "visible", timeout: 15000 });
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

    // Outcome A: FeedbackView (its card body reads "Every answer you gave is annotated ...").
    // Outcome B: retry notice ("your review wasn't ready") -> click Retry review and re-poll.
    // 90s deadline: on qwen/llama, /complete runs inline and blocks across the calls.
    const deadline = Date.now() + 90_000;
    let state = null;
    while (Date.now() < deadline) {
      const body = await page.locator("body").innerText().catch(() => "");
      if (body.includes("is annotated in the transcript below")) {
        state = "feedback";
        break;
      }
      if (body.includes("your review wasn't ready")) {
        const retryBtn = page.getByRole("button", { name: /retry review/i });
        if ((await retryBtn.count()) > 0 && (await retryBtn.isVisible())) {
          console.log("  \u2713 review absent -> clicked Retry review");
          await retryBtn.click();
          await page.waitForTimeout(1500);
        }
      }
      await sleep(700);
    }
    if (!state) state = "timed-out";

    const body = await page.locator("body").innerText();
    console.log("\n[result excerpt]\n" + body.slice(0, 900).replace(/\n+/g, "\n"));
    if (state === "feedback") {
      // The review and the annotations are written by the same pass, so an accuracy with no badges
      // means the transcript on screen is stale (that regression shipped once).
      const badges = await page.locator("div.justify-end span[title]").count();
      const rated = await page.getByText("accuracy", { exact: true }).count();
      if (rated && badges === 0) console.log("FAIL review reports an accuracy but shows no per-answer annotations");
      else console.log(`PASS review rendered after Complete (${rated ? `${badges} annotation(s)` : "ungraded — annotator returned nothing"})`);
    } else if (state === "timed-out") console.log("FAIL timed out waiting for review/retry state");
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
