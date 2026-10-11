---
name: hermetic-e2e
description: >-
  Drive a REAL headless browser against maxterview's running frontend. Primary path is the wired
  `playwright` MCP server (element refs from `browser_snapshot`); secondary is the committed
  host-direct runners `e2e.cjs` (PASS/FAIL journeys) and `inspect.cjs` (DOM dumps per stage). Load
  when a UI change must be seen in a real browser, an onboarding/chat flow must be driven end to end,
  or a rendering bug needs repro-ing with no human at the keyboard.
---

# Hermetic E2E — drive a live headless browser

Browse maxterview's REAL running frontend with a real (headless) Chromium. Two paths, different
strengths — pick per task:

- **MCP (primary, interactive):** the `playwright` MCP server is wired in `.pi/mcp.json` and exposes
  the 23 `browser_*` tools as `mcp__playwright__*`. Act on **element refs from `browser_snapshot`**,
  not CSS selectors: you read the accessibility tree, then click/type by ref. Best for exploring an
  unfamiliar route, repro-ing a rendering bug, or when you want to adapt mid-run without writing a
  script. Batch multi-step or conditional work in one codemode script (see below).
- **Host-direct runners (secondary, deterministic):** committed journeys driven by `playwright-core`
  resolved from the nix store. `e2e.cjs` asserts onboarding + chat + Finish-scoring (PASS/FAIL).
  `inspect.cjs` dumps the live DOM at each stage so you can SEE what rendered.

**Choose by what you need:** MCP for interactivity, ref-based adaptation, and every ad-hoc verdict;
the runners for a canned PASS/FAIL line. MCP tool calls cannot assert — they return observations,
which is enough for you to judge.

## DECISION ORDER — read before you open any runner

1. **MCP is the default.** Repro, eyeball, "does this work?", "verify the feature I just changed" — all
   of it goes through the `browser_*` tools. Driving the real browser and reading the snapshot,
   `browser_wait_for` text, or `browser_evaluate` IS a verdict. That includes "did onboarding work?" —
   read the a11y tree. You do not need a script to have an opinion.
2. **Run a canned runner only when the journey you need already exists in it, unchanged.** One command
   (`--feedback`, `--resume`), read the PASS/FAIL line, done.
3. **A runner that fails, misses a selector, or lacks the leg you want is a DEAD END, not a task.**
   Stop editing the script. Switch to MCP, finish the verification there, and report the breakage
   ("`e2e.cjs --resume` regex no longer matches the chip") as a finding.
4. **Editing a runner — a new leg, a helper, a fixture builder, a selector fix — needs an explicit user
   ask.** The scripts are a convenience for repeatable journeys, not the test suite. Reworking one
   mid-verification is time burned on the wrong artifact; drift is expected and is not yours to fix
   unless asked.

Both paths hit the same target: the real frontend at `localhost:5173`, real backend at `:8000`. Real
DOM, real network, DEV_USER.

## MCP path (primary)

The server is `playwright-mcp` from **nixpkgs** (not npx), provided by the repo flake's devShell, so
pi must run inside `nix develop`/direnv for the command to resolve. Declared in `.pi/mcp.json`.

Typical drive. **Tool names are `mcp__playwright__browser_*`** — a bare `browser_navigate` fails with
"Tool not found". `target` accepts **either** a snapshot ref (`e8`) **or** a unique CSS selector, so the
journey selectors in the runners section work unchanged:

**Don't snapshot-spam.** `browser_snapshot` is the token sink; each call dumps a full YAML tree.
Snapshot once to get refs, then act, then prefer `browser_wait_for` (`{text}` / `{textGone}` /
`{time}`) to gate the next read. For multi-step/conditional runs use a codemode script calling
`tools.mcp__playwright__browser_*(...)` (loops + chaining) rather than N sequential calls. The server
process starts with the session; the browser itself spawns on the first tool call.

**Costs to know:** every `browser_snapshot` ships a YAML accessibility tree into context (token-heavy
vs. a targeted `page.locator(...)` assertion); the tool surface is a fixed 23 verbs (no `page.route`,
no request interception) — `browser_run_code_unsafe` exists and is RCE-equivalent, so only reach for
it deliberately; and nixpkgs pins `playwright-mcp` 0.0.76 (`skipBulkUpdate = true`, no auto-update), so
it lags upstream. Server writes throwaway artifacts under `.playwright-mcp/` (already gitignored).

`openBrowser()` resolves playwright-core + chromium from `/nix/store` at runtime and returns a
headless chromium Browser. Drive `page.goto / locator / fill / click / waitFor` etc. Because it is
just node + playwright-core, anything `page.*` can do you can do here — including network
interception, which the MCP tool surface does not expose.

AI HERE: MCP and the runners are deliberately both kept. MCP wins on interactivity/portability; the
runners win on determinism (assert semantics) and raw `page.*` reach. Unify only if the nixpkgs
`playwright-mcp` pin becomes a maintenance problem, or if MCP grows assert semantics — at which point
`store.cjs` + the canned journeys can retire.

## Preconditions

- Dev stack up: `make up`. Confirm `curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/api/usage`
  is 200 and `http://localhost:5173/` is 200.
- Auth posture FIRST:
  - **Hermetic DEV_USER:** backend `CLERK_ENABLED=false` => `/api/usage` returns 200 anonymously. (Fastest.)
  - **Real Clerk:** backend `CLERK_ENABLED=true` => `/api/usage` 401s. Sign the page in headlessly first
    (see Real-Clerk section; needs `paymongo-operator`).
- A host `node` that can read `/nix/store`: `nix develop .`. CJS `require`, not ESM `import from <expr>`.
- Store artifacts present (resolved at runtime by `store.cjs` — never hardcode a hash; nix GCs old
  ones). Flake pins `playwright` + `chromium` + `playwright-mcp`, so a fresh `nix develop` provides
  them. The MCP path needs the shell on PATH (`which playwright-mcp` must succeed) or the lazy server
  will fail to launch on first call.

## Journey selectors (for MCP or runner runs)

Real DOM / routes (`react-router-dom`): Landing `/`, app `/dashboard`, chat `/interviews/:id`. Selectors below
work for both paths — MCP `target` takes a CSS selector or a snapshot ref.

1. Landing: click the **"Start free"** link (real `<a href="/dashboard">`; `#` on `/`) -> `/dashboard`.
2. `/dashboard`: wait for `#role` input (dev-mode banner: "Dev mode (no Clerk key)…").
3. Fill `#role` + optional `#topic`, submit **"Start interview"** -> `/interviews/{uuid}`.
4. Chat: wait for `textarea`. Send an answer (**Send**); await interviewer stream (**Send** flips
   `disabled` when done); click **Finish** (a progress overlay covers the screen and closes itself
   when the review lands; the backdrop and Escape dismiss it without cancelling the request).
5. Outcome markers: **FeedbackView** card description = "is annotated in the transcript below";
   **absent** = notice "your review wasn't ready" + **Retry review** button. Gate on `browser_wait_for` / `waitFor`, not a
   fixed sleep — `/finish` runs inline against a real model and took ~20s in practice (~90s ceiling).

Do not treat `pending → in_progress` auto-transition as a failure.

**The landing CTAs are links, not buttons** ("Sign in" and "Start free" in the header, "Start
practicing free" in the hero and the closing section) — they are anchors because a crawler only
follows `<a href>` and a JS click handler is invisible to it. Match by LINK role:
`getByRole("link", { name: /start (practicing )?free/i })`. Do not guess from the snapshot alone.

## Real-Clerk posture (NOT hermetic)

If `CLERK_ENABLED=true`, `/dashboard` is behind a signed-out gate. Don't claim hermetic; use
`paymongo-operator`: mint a throwaway user (`clerk-mint.sh --email=…`), sign in headlessly with
`@clerk/testing/playwright` (`clerk.signIn`) until a real `__session` cookie exists, drive the routes,
then tear down (`clerk-mint.sh --admin-destroy --teardown --user=<id>`). Don't mix postures in one run.

## Browser MCP — wired, and the traps that cost time

Wired via `.pi/mcp.json` → nixpkgs `playwright-mcp`. Facts worth not re-deriving:

- MCP is built into pi. It reads user servers from `~/.pi/agent/mcp.json` and project servers from
  `.pi/mcp.json` (project config needs project trust). The `pi-mcp-adapter` package and its
  `.mcp.json` lookup order are gone; `~/.pi/agent/mcp-cache.json` is a leftover with no reader.
- Every enabled server connects in the background at session start, so the `playwright-mcp` process
  is up before any tool call. Adding or changing a server mid-session needs `/reload`.
- `exposure` decides how tools reach the model, not whether the server runs. `playwright` is
  `codemode` exposure, so reach it from a codemode script as `tools.mcp__playwright__browser_*(...)`;
  `grafana` is `direct`, so its tools are declared.
- A locator timeout on the landing page usually means the SPA never mounted, not a stale selector.
  Check before rewriting the runner: `curl -s -o /dev/null -w '%{http_code}' localhost:5173/src/pages/Landing.tsx`
  (500 = an import Vite cannot resolve, such as a dependency missing from the container), then
  `browser_evaluate` `document.getElementById('root').childElementCount`.
- `command: "playwright-mcp"` is a PATH lookup: it works only inside the flake shell. Outside
  `nix develop` the connection fails at session start.
- `args` must be an array of strings. A wrong shape is a config error that `pi mcp list` reports,
  not a runtime failure.
- The nixpkgs wrapper already sets `PLAYWRIGHT_BROWSERS_PATH` to the pinned driver browsers and forces
  `PLAYWRIGHT_MCP_ISOLATED=1` when no user-data-dir is given — so **do not** add `playwright install`
  or a browser-path env var. Pin stays deliberately frozen (`skipBulkUpdate`), so it lags upstream.

## After a run — verify then commit

```bash
make up      # ensure backend + frontend dev containers
make lint    # biome write (frontend) + ruff fix (backend)
make exec    # full gate: frontend typecheck+build+biome; backend ruff+pytest
```

## Guardrails

- Test data only; created interviews are real DEV_USER rows (delete via the **Interviews** page / `DELETE`).
- Hermetic path never touches Clerk/PayMongo keys. Real-Clerk leg via `paymongo-operator`
  (headless sign-in; real hosted Checkout needs a human at the card step). No mixing postures.
- No host `npm install`, no committed store hashes — resolve at runtime. `.playwright-mcp/` is
  gitignored throwaway output; never commit it. It is written relative to pi's **cwd**, so runs in
  other repos will litter those trees — the dir must be gitignored everywhere you use this.
- `browser_run_code_unsafe` executes arbitrary JS in the server process (RCE-equivalent). Use only
  when the 23 typed tools genuinely cannot do the job.
