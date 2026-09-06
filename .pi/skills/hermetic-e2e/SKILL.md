---
name: hermetic-e2e
description: >-
  Lean browser walkthrough of maxterview onboarding + dashboard navigation (Landing -> /app ->
  create interview -> /interviews/:id). NOTE: there is NO browser MCP server anymore — the old
  .mcp.json "playwright" entry pointed at a dead nix-store binary that no longer exists and has
  been removed (mcpServers is empty). Drive the browser HOST-DIRECT instead: playwright-core +
  chromium resolved from the immutable /nix/store, executed by the node(js) the repo flake ships.
  This needs NO npm install on the host, so it keeps zero node_modules in local storage. Hermetic
  when the backend runs with CLERK_ENABLED=false (no-Clerk DEV_USER). If the stack runs real Clerk,
  sign in headlessly first via the clerk-stripe-operator skill. Not a deterministic CI spec. Use to
  reproduce or eyeball the onboarding/new-interview flow in a browser, or after applying
  frontend/backend changes (run `make lint`/`make exec`, then commit) without touching real
  Clerk/Stripe accounts.
---

# Hermetic E2E — onboarding & dashboard navigation (host-direct, no MCP)

A walkthrough an agent follows to simulate a **user onboarding** and **dashboard navigation** in the
frontend, driving a **real browser** through `playwright-core` — NOT through the Playwright MCP
(mcp__playwright tools are gone; no `@playwright/test`, no host npm install).

Follows the real DOM, not a fake: routes are `react-router-dom` in `frontend/src/App.tsx`.

**Hermetic by design:** run the dev stack against the **no-Clerk dev fallback** — backend started
WITHOUT `CLERK_ENABLED=true` so it returns `DEV_USER`, and frontend without a usable publishable key
so `clerkEnabled=false` renders the gated routes directly. No Clerk or Stripe keys needed for this
path. It exercises onboarding + navigation only; it does not place a real Stripe payment.

## Why "host-direct" and not the old "Playwright MCP"

Historically the repo declared a `playwright` MCP server in `.mcp.json` pointing at a
`/nix/store/...-playwright-mcp-.../bin/playwright-mcp` binary. That binary **no longer exists in any
form** in the nix store (verified) and the repo flake never provisioned it. The MCP route is dead.
The working substitute, verified against the live stack, is to launch a browser directly from the
immutable nix store:

- `playwright-core` is a store package you `require()` without installing.
- `playwright-chromium` ships the chromium executable in a store path.
- The repo flake (`nix develop .`) puts `nodejs` on PATH, so a host `node script.mjs` can drive it.
- No `npm install` happens on the host: playwright-core + chromium are read from the nix store, so
  nothing lands in `.playwright-mcp/` or any host `node_modules`.

This is a Nix-only, machine-local mechanism (not reproducible for non-Nix users). If the whole team
needs MCP-style browser driving, that requires a real (containerized, glibc) `@playwright/mcp` server
to be built and re-added to `.mcp.json` — out of scope here.

## Preconditions

- Dev stack up: `make up` (backend healthy at 8000, frontend at 5173). Confirm:
  `curl -s http://localhost:8000/health` -> 200, `curl -s -o /dev/null -w "%{http_code}" localhost:5173/` -> 200.
- Decide the auth posture FIRST — the driving mechanism differs:
  - **Hermetic DEV_USER:** backend `CLERK_ENABLED=false`. Check: `curl -s -w "%{http_code}" localhost:8000/usage`
    returns 200 for an unauthenticated caller (DEV_USER). If it returns **401 "Missing credentials"**,
    the backend is in real-Clerk mode -> you are NOT hermetic; use the real-Clerk path below.
  - **Real Clerk:** backend `CLERK_ENABLED=true`. `/usage` returns 401 to an anonymous caller. You must
    sign the browser in headlessly first (see below / clerk-stripe-operator skill).
- Base URL `http://localhost:5173` (override with `E2E_BASE`).
- A host node that can run ESM and reach the nix store. `nix develop .` (or have `nodejs` on PATH).
- A store-provided `playwright-core` INDEX.js and `chromium` executable. Resolve them dynamically
  (paths change per rebuild — never hardcode a store hash):

```bash
# playwright-core index (CJS; there may be several, prefer the one without node_modules deps issue)
PCORE=$(find /nix/store -maxdepth 1 -type d -name 'playwright-core-*' | head -1)
GCORE=/nix/store/$(basename "$CHROME" 2>/dev/null)  # see below
CHROME_DIR=$(find /nix/store -maxdepth 1 -type d -name 'playwright-chromium' | head -1)
```

## Pre-flight: verify the browser launches from the store

Before the full journey, confirm the two store artifacts resolve and launch (fast sanity gate):

```js
// launch-check.mjs — run with: node launch-check.mjs  (CHROME + PCORE from env)
import pw from process.env.PCORE_INDEX;           // CJS -> default import
const { chromium } = pw;
const b = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true, args: ["--no-sandbox", "--disable-gpu"],
});
console.log("launch OK");
await b.close();
```

If this fails, resolve fresh paths and retry; do not proceed to the journey blind.

## The journey (simulates an onboarding user)

Issue these as real `page.*` calls in one node script that drives the SAME chromium. The labelled
checkpoint array lives in `scripts/checkpoints.mjs`; reuse those selectors/assertions.

1. **Landing loads** — `page.goto(BASE + "/")`. Assert the marketing hero and CTA(s)
   ("Get started" / "Start practicing").
2. **Enter the app** — click **"Get started"** (header). Assert `page.url()` ends in `/app`.
3. **Dashboard + banner** — on `/app` assert the **dev-mode banner** ("Dev mode (no Clerk key)…")
   and the "New interview" form with `#role` + `#topic (optional)` inputs.
4. **Create interview** — fill `#role` and `#topic`, submit "Start interview".
5. **Route to detail** — after create the SPA navigates to `/interviews/${id}`. Assert the URL
   matches `/interviews/{uuid}` and `InterviewChat`/interview header loads (it auto-calls
   `startInterview` on mount).
6. (Optional) use the exit/Home control back to `/app` and see the new interview in History.

Do not treat a pending interview (`status=pending→in_progress` auto-transition client-side) as a
failure. The chat fires only when a turn is sent; this lean journey does not send one.

## Real-Clerk posture (NOT hermetic) — sign in first, then run the journey

If the backend is `CLERK_ENABLED=true`, `/app` renders a signed-out gate and the steps above fail
at banner/history. Do NOT lie to yourself that it is hermetic. Instead:

1. Read `clerk-stripe-operator` SKILL.md → "Fully-headless Clerk auth". Use `@clerk/testing/playwright`
   (`clerkSetup` + `clerk.signIn`) with a throwaway test user:
   - mint the user: `.pi/skills/clerk-stripe-operator/scripts/clerk-mint.sh --email=<addr>`
   - sign the page in headlessly as that address, confirm a real `__session` cookie appears.
   - tear it down after: `clerk-mint.sh --admin-destroy --teardown --user=<user_id>`.
2. Now run the journey's `/app` assertions; you are exercising the real-Clerk auth path.
3. If you only need to eyeball a component behind the gate on an auth-gated route, you can often do
   the hermetic route instead by toggling the backend to DEV_USER — but that mutates auth state and
   container env: ask / get explicit go-ahead first (AGENTS.md zero-touch).

## Effective source of truth for launching a browser

This proven snippet (CJS default-import of store playwright-core) is the pattern to reproduce:

```js
import pw from PCORE_INDEX;                 // '/nix/store/.../playwright-core-1.61.1/index.js'
const { chromium } = pw;
const b = await chromium.launch({ executablePath: CHROME_PATH, headless: true,
                                  args: ["--no-sandbox", "--disable-gpu"] });
const p = await b.newPage();
p.on("request", (r) => { /* count r.url() hits, e.g. /usage */ });
await p.goto(BASE, { waitUntil: "domcontentloaded" });
// ... assert ...
await b.close();
```

Pass `CHROME_PATH` and `PCORE_INDEX` as env vars; resolve each via `find /nix/store` at runtime.

## Why this is not a CI spec

This is a **scripted walkthrough** that finishes/succeeds live as you watch it run step by step. It
has **no pass/fail exit code and no CI gate** (not `@playwright/test`; depends on machine-local nix
store paths you still have to resolve). If you later want a deterministic CI regression suite that
"just runs", that is the `@playwright/test` layer — a separate, heavier, explicitly-added effort.

## After a run — verify then commit

```bash
make up      # ensure backend + frontend dev containers are running (needed by targets below)
make lint    # auto-fix: biome write (frontend) + ruff fix (backend)
make exec    # full gate: frontend typecheck+build+biome; backend ruff+pytest
```

- A non-zero `make exec` is a blocker; fix and re-run before committing.
- This E2E walkthrough is behavioural and complements (does not replace) `make exec`'s static checks.
- Commit per AGENTS.md: conventional `type(scope):`, atomic by relevance, amend (not farm) when
  extending the last unpushed commit's concern, and ask before pushing or when scope is unclear.

## Guardrails

- Use test data only; interviews created here are real rows for DEV_USER — clean them up in History
  if you care (journey is harmless).
- The pure hermetic path never touches Clerk/Stripe keys. If you add the real-Clerk leg, follow the
  `clerk-stripe-operator` skill (headless sign-in, real hosted Checkout only with a human at the card
  step); do not mix the two postures in one run and do not loop-automate Stripe's bot checks.
- No host `npm install`, no `.playwright-mcp/`, no committed store hashes — resolve store paths at
  runtime and keep local storage clean.
