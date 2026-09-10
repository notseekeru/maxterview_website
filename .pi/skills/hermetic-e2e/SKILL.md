---
name: hermetic-e2e
description: >-
  Drive a REAL headless browser against maxterview's running frontend. Primary path is the wired
  playwright MCP server (nixpkgs playwright-mcp via .mcp.json; headless+isolated chromium, lazy) —
  call browser_navigate/browser_snapshot/browser_click by element ref, or batch multi-step work with
  mcpScript. Secondary path is the host-direct nix-store runners (playwright-core + chromium resolved
  at runtime by scripts/store.cjs — no @playwright/test, no host npm install): e2e.cjs asserts the
  journey PASS/FAIL (--feedback adds chat+Complete), inspect.cjs dumps the live DOM per stage. Keep
  the runners for DETERMINISTIC assertions — MCP tool calls have no assert/fail semantics. Covers
  onboarding -> /app -> create interview -> chat -> Complete-scoring. Hermetic when the backend runs
  CLERK_ENABLED=false (no-Clerk DEV_USER); if real Clerk, sign in headlessly first via
  clerk-stripe-operator. Use to reproduce/eyeball onboarding / new-interview / complete-scoring in a
  browser, or after frontend/backend changes.
---

# Hermetic E2E — drive a live headless browser

Browse maxterview's REAL running frontend with a real (headless) Chromium. Two paths, different
strengths — pick per task:

- **MCP (primary, interactive):** the `playwright` MCP server is wired in `.mcp.json` and exposes the
  23 `browser_*` tools. Act on **element refs from `browser_snapshot`**, not CSS selectors — you read
  the accessibility tree, then click/type by ref. Best for exploring an unfamiliar route, repro-ing a
  rendering bug, or when you want to adapt mid-run without writing a script. Batch multi-step or
  conditional work with `mcpScript` (see below).
- **Host-direct runners (secondary, deterministic):** committed journeys driven by `playwright-core`
  resolved from the nix store. `e2e.cjs` asserts onboarding + chat + Complete-scoring (PASS/FAIL).
  `inspect.cjs` dumps the live DOM at each stage so you can SEE what rendered.

**Choose by what you need:** MCP for interactivity and ref-based adaptation; the runners when you need
an actual pass/fail verdict or raw DOM. MCP tool calls cannot assert — they return observations, so a
"did onboarding work?" check still needs a runner (or an agent judging the snapshot).

Both paths hit the same target: the real frontend at `localhost:5173`, real backend at `:8000`. Real
DOM, real network, DEV_USER.

## MCP path (primary)

The server is `playwright-mcp` from **nixpkgs** (not npx), provided by the repo flake's devShell, so
pi must run inside `nix develop`/direnv for the command to resolve. `.mcp.json`:

```json
{ "mcpServers": { "playwright": { "command": "playwright-mcp",
  "args": ["--headless", "--isolated", "--browser", "chromium"], "lifecycle": "lazy" } } }
```

Typical drive, ref-based:

```
mcp({ tool: "browser_navigate", args: { url: "http://localhost:5173/" } })
mcp({ tool: "browser_snapshot", args: {} })            # read the a11y tree + refs
mcp({ tool: "browser_click", args: { target: "e8", element: "Get started button" } })
```

For multi-step/conditional runs use `mcpScript` (plain JS, loops + chaining) rather than N sequential
`mcp` calls — e.g. navigate, snapshot, decide, click, re-snapshot. `lifecycle: "lazy"` means the
browser does not spawn until the first tool call.

**Costs to know:** every `browser_snapshot` ships a YAML accessibility tree into context (token-heavy
vs. a targeted `page.locator(...)` assertion); the tool surface is a fixed 23 verbs (no `page.route`,
no request interception) — `browser_run_code_unsafe` exists and is RCE-equivalent, so only reach for
it deliberately; and nixpkgs pins `playwright-mcp` 0.0.76 (`skipBulkUpdate = true`, no auto-update), so
it lags upstream. Server writes throwaway artifacts under `.playwright-mcp/` (already gitignored).

## Host-direct runner primitive (fallback / assertions)

```js
// bespoke.cjs — CJS (playwright-core is CommonJS). Require the shared launcher:
const { openBrowser, BASE } = require("../scripts/store.cjs");

(async () => {
  const browser = await openBrowser();        // headless chromium from the nix store, no-sandbox
  const page = await browser.newPage();
  await page.goto(BASE + "/");
  console.log(await page.locator("body").innerText());   // see what actually rendered
  // ... any page.* work (including page.route / waitForResponse — note MCP cannot do this) ...
  await browser.close();
})();
```

`openBrowser()` resolves playwright-core + chromium from `/nix/store` at runtime and returns a
headless chromium Browser. Drive `page.goto / locator / fill / click / waitFor` etc. Because it is
just node + playwright-core, anything `page.*` can do you can do here — including network
interception, which the MCP tool surface does not expose.

AI HERE: MCP and the runners are deliberately both kept. MCP wins on interactivity/portability; the
runners win on determinism (assert semantics) and raw `page.*` reach. Unify only if the nixpkgs
`playwright-mcp` pin becomes a maintenance problem, or if MCP grows assert semantics — at which point
`store.cjs` + the canned journeys can retire.

`scripts/store.cjs` exports `{ NIX, BASE, pcore, CHROME_BIN, sleep, openBrowser }`. `e2e.cjs` and
`inspect.cjs` both `require()` it, so browser resolve/launch is defined once.

Run any bespoke script with the repo flake shell so nodejs + nix-store are reachable:

```bash
nix develop . -c node .pi/skills/hermetic-e2e/scripts/inspect.cjs   # see resolve/launch in action
```

## Preconditions

- Dev stack up: `make up`. Confirm `curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/usage`
  is 200 and `http://localhost:5173/` is 200.
- Auth posture FIRST:
  - **Hermetic DEV_USER:** backend `CLERK_ENABLED=false` => `/usage` returns 200 anonymously. (Fastest.)
  - **Real Clerk:** backend `CLERK_ENABLED=true` => `/usage` 401s. Sign the page in headlessly first
    (see Real-Clerk section; needs `clerk-stripe-operator`).
- A host `node` that can read `/nix/store`: `nix develop .`. CJS `require`, not ESM `import from <expr>`.
- Store artifacts present (resolved at runtime by `store.cjs` — never hardcode a hash; nix GCs old
  ones). Flake pins `playwright` + `chromium` + `playwright-mcp`, so a fresh `nix develop` provides
  them. The MCP path needs the shell on PATH (`which playwright-mcp` must succeed) or the lazy server
  will fail to launch on first call.

## Canned runners (presets for the routine path)

```bash
# onboarding + dashboard nav only (fast): 
nix develop . -c node .pi/skills/hermetic-e2e/scripts/e2e.cjs
# full assert: send answer -> Complete -> FeedbackView OR Retry-scoring notice:
nix develop . -c node .pi/skills/hermetic-e2e/scripts/e2e.cjs --feedback
# debug: same journey but dump live DOM per stage (--dom for raw innerHTML):
nix develop . -c node .pi/skills/hermetic-e2e/scripts/inspect.cjs [--dom]
# env overrides: E2E_BASE, E2E_ROLE, E2E_TOPIC, E2E_ANSWER
```

- `store.cjs` — shared resolve/launch (both runners + your bespoke scripts use it).
- `e2e.cjs` — assert run. On a real model `/complete` runs inline and can block tens of seconds; it
  uses a ~90s deadline. Assert "Your performance summary" (FeedbackView) or "scoring wasn't ready"
  (clicks Retry).
- `inspect.cjs` — the same journey but prints the rendered DOM/URL at each stage, so an ambiguous
  assert becomes visible.

Runners create a real DEV_USER interview and print its id — delete it when judging
(History / `DELETE /interviews/<id>`). Keep local storage free of host `node_modules`/`install`.

## Journey selectors (for ad-hoc or e2e runs)

Real DOM / routes (`react-router-dom`): Landing `/`, app `/app`, chat `/interviews/:id`.

1. Landing: click **"Get started"** -> `/app`.
2. `/app`: wait for `#role` input (dev-mode banner: "Dev mode (no Clerk key)…").
3. Fill `#role` + optional `#topic`, submit **"Start interview"** -> `/interviews/{uuid}`.
4. Chat: wait for `textarea`. Send an answer (**Send**); await interviewer stream; **Complete**.
5. Outcome markers: **FeedbackView** body = "Your performance summary"; **absent** = notice
   "scoring wasn't ready" + **Retry scoring** button.

Do not treat `pending → in_progress` auto-transition as a failure.

## Real-Clerk posture (NOT hermetic)

If `CLERK_ENABLED=true`, `/app` is behind a signed-out gate. Don't claim hermetic; use
`clerk-stripe-operator`: mint a throwaway user (`clerk-mint.sh --email=…`), sign in headlessly with
`@clerk/testing/playwright` (`clerk.signIn`) until a real `__session` cookie exists, drive the routes,
then tear down (`clerk-mint.sh --admin-destroy --teardown --user=<id>`). Don't mix postures in one run.

## Browser MCP (notes only — difficulties + advantages; not wired)

## Browser MCP — wired, and the traps that cost time

Wired via `.mcp.json` → nixpkgs `playwright-mcp`. Facts worth not re-deriving:

- pi has **no built-in MCP**; it works because `npm:pi-mcp-adapter` is installed (settings.json
  `packages`). The adapter is the consumer — raw `.mcp.json` alone does nothing without it.
- The adapter reads (low→high precedence): `~/.config/mcp/mcp.json`, `~/.agents/mcp.json`,
  `~/.agents/mcp/mcp.json`, `<pi agent dir>/mcp.json`, `.mcp.json`, `.pi/mcp.json`. Project
  `.mcp.json` is the right home for a repo-scoped browser server.
- Config is read at **session start**. Adding/changing `.mcp.json` mid-session shows `MCP: 0/0 servers`
  until pi restarts — that is not a config error.
- `~/.pi/agent/mcp-cache.json` caches tool metadata. A **stale cache can advertise servers that no
  longer exist** in config (and omit new tools). If status and cache disagree, delete the cache file
  and restart pi.
- `command: "playwright-mcp"` is a PATH lookup: it works only inside the flake shell. Outside
  `nix develop`, the server fails to launch on first call (lazy = fails at call time, not startup).
- Args must be object-shaped on the wire; a wrong shape surfaces as
  `expected string, received undefined` in the tool result, not as a crash.
- The nixpkgs wrapper already sets `PLAYWRIGHT_BROWSERS_PATH` to the pinned driver browsers and forces
  `PLAYWRIGHT_MCP_ISOLATED=1` when no user-data-dir is given — so **do not** add `playwright install`
  or a browser-path env var. Pin stays deliberately frozen (`skipBulkUpdate`), so it lags upstream.

Prefer MCP for interactive ref-based work; drop to the host-direct runners when you need an assertion,
a raw DOM dump, or `page.route` network control MCP does not expose.

## Why this is not a CI spec

Depends on machine-local nix store + a live dev stack; deterministic CI would be the `@playwright/test`
layer — a separate, heavier, explicit effort.

## After a run — verify then commit

```bash
make up      # ensure backend + frontend dev containers
make lint    # biome write (frontend) + ruff fix (backend)
make exec    # full gate: frontend typecheck+build+biome; backend ruff+pytest
```

- Non-zero `make exec` is a blocker. Browser runs complement (not replace) these static gates.
- Commit per AGENTS.md: atomic, `fix/feat/ref/docs(scope):`, amend-not-farm, ask before pushing.

## Guardrails

- Test data only; created interviews are real DEV_USER rows (delete via History / `DELETE`).
- Hermetic path never touches Clerk/Stripe keys. Real-Clerk leg via `clerk-stripe-operator`
  (headless sign-in; real hosted Checkout needs a human at the card step). No mixing postures.
- No host `npm install`, no committed store hashes — resolve at runtime. `.playwright-mcp/` is
  gitignored throwaway output; never commit it.
- `browser_run_code_unsafe` executes arbitrary JS in the server process (RCE-equivalent). Use only
  when the 23 typed tools genuinely cannot do the job.

## Source of truth for launching (if you don't use store.cjs)

playwright-core + chromium live at HASH-prefixed store dirs; resolve + CJS `require` at runtime,
point `executablePath` at `…/chrome-linux64/chrome` (never the bare dir, never a hardcoded hash).
`scripts/store.cjs` already does this correctly — prefer it over reimplementing.
