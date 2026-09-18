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
//   nix develop . -c node .pi/skills/hermetic-e2e/scripts/e2e.cjs --resume   # + PDF drop import/attach
//   E2E_ANSWER=... nix develop . -c node .pi/skills/hermetic-e2e/scripts/e2e.cjs --feedback
//
// Cleanup: created interviews are real DEV_USER rows; the script prints their ids. The --resume leg
// deletes the resume it imported (the interview it created is left to the caller, like the nav leg).
"use strict";

const { BASE, CHROME_BIN, sleep, openBrowser } = require("./store.cjs");

/** A real, xref-correct one-page PDF carrying `lines` — the same offsets-are-computed trick as
 *  backend/tests/test_resumes.py::mini_pdf, so the repo keeps no binary fixture. */
function miniPdf(lines) {
  const content = lines.map((line, i) => `BT /F1 12 Tf 20 ${160 - i * 20} Td (${line.replace(/([()\\])/g, "\\$1")}) Tj ET`).join("\n");
  const parts = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];
  const out = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets = [];
  let at = out[0].length;
  for (const [i, body] of parts.entries()) {
    offsets.push(at);
    const chunk = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, "latin1");
    out.push(chunk);
    at += chunk.length;
  }
  const xref = `xref\n0 ${parts.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${parts.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`;
  return Buffer.concat([...out, Buffer.from(xref, "latin1")]);
}

/** Opens the /app create form: it is behind a toggle whenever the owner already has interviews, and
 *  the toggle is not painted yet on the frame after the route change (clicking too early is a no-op,
 *  clicking twice closes it again). */
async function openNewInterviewForm(page) {
  const newBtn = page.getByRole("button", { name: /^New interview$/ });
  let clicked = false;
  for (let i = 0; i < 40 && !(await page.locator("#role").isVisible().catch(() => false)); i++) {
    if (!clicked && (await newBtn.isVisible().catch(() => false))) {
      clicked = true;
      await newBtn.click();
    } else await sleep(250);
  }
  await page.locator("#role").waitFor({ state: "visible", timeout: 15000 });
}

/** Drop `name`/`bytes` on the resume page's import dropdown, opening it first. */
async function dropOnImportPanel(page, name, bytes, type) {
  const summary = page.locator("summary", { hasText: /Import PDF/ });
  const target = page.locator("label:has(input[type=file])");
  // Click once, then re-click if the panel was already open (the run tests the reject path first,
  // which deliberately leaves it open) - this way the call does not care about the panel's state.
  await summary.click();
  if (!(await target.isVisible().catch(() => false))) await summary.click();
  await target.waitFor({ state: "visible", timeout: 10000 });
  const dt = await page.evaluateHandle(
    ({ b64, name, type }) => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type }));
      return dt;
    },
    { b64: bytes.toString("base64"), name, type },
  );
  await target.dispatchEvent("drop", { dataTransfer: dt });
}

// The resume journey: import a PDF through the dropdown DROPPER (not the hidden input's picker),
// attach it to an interview, and prove the attach is what the thread and the server see.
//
// The server stores the file name's STEM (`e2e-cv`, not `e2e-cv.pdf`) - the chip is matched on it.
async function resumeLeg(page, createdIds) {
  const stem = "e2e-cv";
  // Matched unanchored: the chip's accessible name is the stem hard against the char count
  // ("e2e-cv94 chars" - the gap between them is margin, not text).
  const chip = () => page.getByRole("button", { name: new RegExp(stem) });
  const listed = resumesLoaded(page);
  await page.goto(BASE + "/app/resume", { waitUntil: "domcontentloaded" });
  await page.locator("#resume-name").waitFor({ state: "visible", timeout: 15000 });
  // The rows are painted from the response's promise callback, so one frame after it is the first
  // frame that can hold them — without this, a leftover row from a failed run reads as "no row"
  // and the delete below is skipped.
  await listed;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve())));
  // A rerun must not stack rows against the tier's cap: start from no `stem` row either way.
  await deleteResumeNamed(page, chip);
  console.log("  \u2713 /app/resume loaded");

  // The drop target bypasses the input's `accept` attribute, so the client-side filter is what makes
  // a stray .txt a readable error instead of a 400 from the extract endpoint.
  await dropOnImportPanel(page, "e2e-notes.txt", Buffer.from("not a resume", "latin1"), "text/plain");
  if ((await page.getByText(/isn't a PDF/).count()) === 0) {
    console.log("  \u2717 dropping a non-PDF showed no error");
    return;
  }
  console.log("  \u2713 non-PDF drop rejected in the panel");

  // "...or click to browse" is a claim about the label: the panel is the only path to the picker now.
  const chooser = page.waitForEvent("filechooser", { timeout: 5000 });
  await page.getByText(/click to browse/).click();
  await chooser;
  console.log("  \u2713 panel opens the native picker");

  const pdf = miniPdf(["Alex Mender - Platform Engineer", "Karada: Kafka streaming backfill", "Postgres, 1.2B events per day"]);
  await dropOnImportPanel(page, `${stem}.pdf`, pdf, "application/pdf");
  await chip().first().waitFor({ state: "visible", timeout: 20000 });
  const text = await page.locator("#resume-text").inputValue();
  if (!text.includes("Karada")) {
    console.log(`  \u2717 PDF text did not reach the editor (${text.length} chars): ${JSON.stringify(text.slice(0, 120))}`);
    return;
  }
  console.log(`  \u2713 PDF dropped -> extracted ${text.length} chars, saved as "${stem}"`);

  // Attach it from the create form and check the thread the attach produces: OPENING_HAS_RESUME is
  // chosen from `resume_id` only, so its copy is the UI's proof that the FK landed.
  await page.goto(BASE + "/app", { waitUntil: "domcontentloaded" });
  await openNewInterviewForm(page);
  if ((await chip().count()) === 0) {
    console.log("  \u2717 the create form shows no resume picker");
    return;
  }
  await chip().first().click();
  await page.fill("#role", process.env.E2E_ROLE ?? "Software Engineer QA Walkthrough");
  await page.fill("#topic", "resume-aware interview e2e");
  await page.getByRole("button", { name: /start interview/i }).click();
  await page.waitForURL(/\/interviews\/[0-9a-f-]+/, { timeout: 15000 });
  const m = page.url().match(/\/interviews\/([0-9a-f-]+)/);
  if (m) createdIds.push(m[1]);
  await page.getByText(/I've read your resume/).waitFor({ state: "visible", timeout: 20000 });
  console.log("  \u2713 attached resume -> thread opens resume-aware", page.url().replace(BASE, ""));

  // Delete the imported row so reruns stay inside the tier's cap. The row MUST be there after a
  // successful import, so its absence after the reload is a real failure (not a paint race).
  const reloaded = resumesLoaded(page);
  await page.goto(BASE + "/app/resume", { waitUntil: "domcontentloaded" });
  await page.locator("#resume-name").waitFor({ state: "visible", timeout: 15000 });
  await reloaded;
  await chip().first().waitFor({ state: "visible", timeout: 15000 });
  await deleteResumeNamed(page, chip);
  console.log("  \u2713 resume deleted");
}

/** Delete the row `chip()` names, if the library holds one. `confirm()` is the platform's, so it is
 *  answered through the dialog event, not a click. Callers must have awaited `resumesLoaded` first —
 *  "no chip" has to mean "no row", never "not painted yet". */
async function deleteResumeNamed(page, chip) {
  if ((await chip().count()) === 0) return false;
  await chip().first().click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: /^Delete$/ }).click();
  await chip().first().waitFor({ state: "detached", timeout: 10000 });
  return true;
}

/** The library paints from GET /resumes: wait for that response, not for a paint (the empty state and
 *  a not-yet-rendered list look identical on screen). */
function resumesLoaded(page) {
  return page.waitForResponse((r) => /\/api\/resumes$/.test(r.url()) && r.request().method() === "GET", { timeout: 15000 });
}

async function main() {
  const wantFeedback = process.argv.includes("--feedback");
  const wantResume = process.argv.includes("--resume");
  console.log("chromium:", CHROME_BIN);
  const browser = await openBrowser();
  const page = await browser.newPage();
  const createdIds = [];

  try {
    // Landing -> Start free -> /app. (The CTA is an anchor, not a button: a crawler only follows
    // links — so match it by LINK role: a hero copy tweak fails loudly here instead of timing out.)
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.getByRole("link", { name: /start (practicing )?free/i }).first().click();
    await page.waitForURL(/\/app/, { timeout: 15000 });
    // The create form is behind a toggle whenever the owner already has interviews (it auto-opens
    // only on an empty dashboard).
    await openNewInterviewForm(page);
    console.log("  \u2713 Landing -> /app");

    if (wantResume) {
      await resumeLeg(page, createdIds);
      return;
    }

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
