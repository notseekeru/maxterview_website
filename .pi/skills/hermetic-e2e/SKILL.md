---
name: hermetic-e2e
description: >-
  Drive a REAL headless browser against maxterview's running frontend through the wired `playwright`
  MCP server, called from a codemode script. Load when a UI change must be seen in a real browser, an
  onboarding/chat flow must be driven end to end, or a rendering bug needs repro-ing with no human at
  the keyboard.
---

# Hermetic E2E

One path: the `playwright` MCP server, called from codemode. No node runner, no host script, no CJS.
Target is the real frontend at `localhost:5173` and the real backend at `:8000`, real DOM and real
network.

## Call shape

`.pi/mcp.json` leaves `exposure` unset, so playwright takes pi's default, `codemode`: its 23
`browser_*` tools are neither declared to the model nor listed in the codemode description. Reach
them as `tools.mcp__playwright__browser_*(...)` inside a codemode script. Exposure semantics and the
`direct` / `deferred` alternatives: pi's own `docs/mcp.md`.

```js
await tools.mcp__playwright__browser_navigate({ url: "http://localhost:5173/dashboard" });
await tools.mcp__playwright__browser_wait_for({ time: 2 });
const res = await tools.mcp__playwright__browser_evaluate({
  function: "() => document.getElementById('root').childElementCount", // a STRING, page scope
  filename: "probe.json", // optional: saves the result to a cwd-relative file
});
```

- `function` is a string expression evaluated in the page. It cannot import, and it cannot close over
  codemode state; build multi-line JS by concatenation.
- A call returns `### Result\n"..."\n### Ran Playwright code ...`. The echoed code is not output:
  slice between `### Result` and `### Ran` before parsing, or `JSON.parse` chokes on the escaped echo.
- `filename` writes relative to pi's cwd (the repo root), not `.playwright-mcp/`. Delete the file
  before committing.
- Loop and branch inside one codemode script rather than making N calls.

## Browsing rules

- **Don't snapshot-spam.** `browser_snapshot` dumps a full YAML accessibility tree into context.
  Snapshot once for refs, act, then gate the next read on `browser_wait_for` (`{text}`, `{textGone}`,
  `{time}`) instead of a fixed delay.
- `target` takes a snapshot ref (`e8`) or a unique CSS selector.
- Tool names carry the server prefix: a bare `browser_navigate` is "Tool not found".
- The surface is fixed and typed, with no `page.route` and no request interception.
- `browser_run_code_unsafe` runs arbitrary JS in the server process (RCE-equivalent). Reach for it
  only when the typed verbs cannot do the job.
- A locator timeout on the landing page usually means the SPA never mounted, not a stale selector.
  Check that `/src/pages/Landing.tsx` answers 200 first (500 = an import Vite cannot resolve), then
  count the `#root` children with `browser_evaluate`.

## Preconditions

- Dev stack up: `make up`. Both `/api/usage` and `/` must answer 200.
- Auth posture FIRST, and ask the endpoint rather than reading `.env`:
  - **Hermetic DEV_USER:** `CLERK_ENABLED=false`, so `/api/usage` is 200 anonymously. The only posture
    this skill drives on its own.
  - **Real Clerk:** `CLERK_ENABLED=true`, so `/api/usage` 401s. Hand the sign-in to `paymongo-operator`.
- `playwright-mcp` must resolve on PATH, which means pi running inside the flake shell
  (`nix develop`/direnv). When it does not, the server fails at session start and `pi mcp list` says so.
- `args` must be an array of strings. A wrong shape is a config error, not a runtime failure.
- The nixpkgs wrapper sets `PLAYWRIGHT_BROWSERS_PATH` to its own pinned driver browsers and forces
  `PLAYWRIGHT_MCP_ISOLATED=1` when no user-data-dir is given: never add `playwright install` or a
  browser-path env var. The pin is frozen (`skipBulkUpdate`), so it lags upstream.
- Adding or changing a server mid-session needs `/reload`.

## Journey selectors

Routes (`react-router-dom`): Landing `/`, app `/dashboard`, chat `/interviews/:id`.

1. Landing: click the **"Start free"** link (an `<a>` to `/sign-up`; with Clerk off that route
   redirects to `/dashboard`).
2. `/dashboard`: wait for `#role`. The rail footer carries a `DEV` badge while Clerk is off.
3. Fill `#role` and optional `#topic`, submit **"Start interview"** to reach `/interviews/{uuid}`.
4. Chat: wait for `textarea`, send an answer through the composer's icon button (`aria-label` "Send
   your answer", disabled unless the status is `ready`, so wait for it to come back from `disabled`),
   then click the header's end control: "End this interview" while questions remain, which opens a
   modal titled "End early?" with **Keep going** / **End it**, or "Finish and get your feedback" at
   the cap. A progress overlay then covers the screen and closes itself when the review lands; the
   backdrop and Escape dismiss it without cancelling the request.
5. Outcome markers: the **FeedbackView** card description reads "is annotated in the transcript
   below". When it is absent instead, the notice reads "your review wasn't ready" with a **Retry
   review** button. Gate on `browser_wait_for`, not a sleep: `/finish` runs inline against a real
   model, about 20s in practice with a 90s ceiling.

Do not treat `pending -> in_progress` auto-transition as a failure.

**The landing CTAs are links, not buttons** ("Sign in", "Start free", and the hero's "Start practicing
free"). They are anchors so a crawler can follow them, and a JS click handler would be invisible to
it: match by LINK role (`start (practicing )?free`) rather than guessing from the snapshot.

## Real-Clerk posture (NOT hermetic)

With `CLERK_ENABLED=true`, `/dashboard` sits behind a signed-out gate. Do not call that run hermetic:
`paymongo-operator` mints a throwaway user and signs the session in, then the same MCP tools drive the
routes. Do not mix postures in one run.

## After a run

```bash
make up      # ensure backend + frontend dev containers
make lint    # biome write (frontend) + ruff fix (backend)
make exec    # full gate: frontend typecheck+build+biome; backend ruff+pytest
```

## Guardrails

- Test data only: created interviews are real DEV_USER rows. Delete them from the **Interviews** page.
- Hermetic runs never touch Clerk or PayMongo keys. Real-Clerk work goes through `paymongo-operator`,
  and real hosted Checkout needs a human at the card step.
- No host `npm install`. `.playwright-mcp/` and any `filename` result file are throwaway and
  gitignored: never commit them. Artifacts land relative to pi's cwd, so a run from another repo
  litters that tree.
