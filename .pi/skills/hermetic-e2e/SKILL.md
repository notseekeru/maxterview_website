---
name: hermetic-e2e
description: >-
  Drive a REAL headless browser against maxterview's running frontend (host-direct; playwright-core
  + chromium resolved from the nix store, executed by node(js) the repo flake ships — no MCP server,
  no @playwright/test, no host npm install). Covers onboarding -> /app -> create interview -> chat ->
  Complete-scoring. Two ways: (1) live/ad-hoc — open a browser with scripts/store.cjs openBrowser()
  and drive any page bespoke with page.* calls (most "dynamic"); or (2) canned runners — e2e.cjs
  asserts the journey (PASS/FAIL; --feedback adds chat+Complete), inspect.cjs dumps the live DOM per
  stage when an assert is ambiguous. MCP/browser-MCP is only a compact notes section (difficulties +
  advantages), not wired. Hermetic when the backend runs CLERK_ENABLED=false (no-Clerk DEV_USER); if
  real Clerk, sign in headlessly first via clerk-stripe-operator. Use to reproduce/eyeball onboarding
  / new-interview / complete-scoring in a browser, or after frontend/backend changes.
---

# Hermetic E2E — drive a live headless browser (host-direct)

Browse maxterview's REAL running frontend with a real (headless) Chromium. Two usage modes:

- **Live / ad-hoc (recommended, most flexible):** open a browser and drive whatever pages you need,
  incrementally, with `page.*` (playwright-core). This is the "dynamic" way — you adapt to what the
  DOM actually shows mid-run rather than replaying a fixed script. Use it to explore, quickly repro a
  rendering/behaviour bug, or poke an unfamiliar route.
- **Canned (convenience):** committed journeys for the routine path.
  `e2e.cjs` asserts onboarding + chat + Complete-scoring (prints PASS/FAIL).
  `inspect.cjs` dumps the live DOM at each stage so you can SEE what rendered when an assert is
  ambiguous.

Both modes are **host-direct**: nothing runs as an MCP server; a `node` script drives `playwright-core`
against `localhost:5173`, talking to the real backend at `:8000`. Real DOM, real network, DEV_USER.

## Open a live browser (the ad-hoc primitive)

```js
// bespoke.cjs — CJS (playwright-core is CommonJS). Require the shared launcher:
const { openBrowser, BASE } = require("../scripts/store.cjs");

(async () => {
  const browser = await openBrowser();        // headless chromium from the nix store, no-sandbox
  const page = await browser.newPage();
  await page.goto(BASE + "/");
  console.log(await page.locator("body").innerText());   // see what actually rendered
  // ... any page.* work, interactively/as-you-observe ...
  await browser.close();
})();
```

`openBrowser()` resolves playwright-core + chromium from `/nix/store` at runtime and returns a
headless chromium Browser. You can then drive `page.goto / locator / fill / click / waitFor` etc.,
adapting to output as you go. Because it is just node + playwright-core, anything `page.*` can do you
can do here — no canned script needed.

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
  ones). Flake pins `playwright` + `chromium`, so a fresh `nix develop` provides them.

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

Our automation is host-direct node, not MCP. For context, browser-MCP is a separate mechanism: a
server (`@playwright/mcp`) exposes typed `browser_*` tools an MCP-aware client (pi) calls.

- **Advantages** (why anyone bothers): uniform, discoverable `browser_*` tool surface + page
  snapshots for any MCP agent; stateful interactivity across calls; no per-repo node boilerplate.
- **Difficulties / why not wired here:** (1) pi does NOT read raw `.mcp.json` `mcpServers` — it needs
  an **MCP-adapter extension in a pi package**, and pi-core 0.84.x disclaims core MCP / exposes no
  adapter API in its installed docs, so there's no working consumer yet; (2) it adds a browser-server
  install/service and a GC-fragile nix binary story unless containerized; (3) all the "dynamic" value
  is already available today through host-direct ad-hoc `page.*` driving — MCP adds ergonomics for
  arbitrary agents, not raw capability.

Decision for now: **host-direct (this skill) is the working path.** Browser-MCP remains an aspirational
upgrade (containerized `@playwright/mcp` + a pi-package MCP adapter) to revisit only on a pi that
exposes the adapter API.

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
- No host `npm install`, no `.playwright-mcp/`, no committed store hashes — resolve at runtime.

## Source of truth for launching (if you don't use store.cjs)

playwright-core + chromium live at HASH-prefixed store dirs; resolve + CJS `require` at runtime,
point `executablePath` at `…/chrome-linux64/chrome` (never the bare dir, never a hardcoded hash).
`scripts/store.cjs` already does this correctly — prefer it over reimplementing.
