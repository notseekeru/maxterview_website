---
name: hermetic-e2e
description: >-
  Lean browser walkthrough of maxterview onboarding + dashboard navigation (Landing -> /app ->
  create interview -> /interviews/:id). Browser automation is HOST-DIRECT today via a committed
  runner (scripts/e2e.cjs) that resolves playwright-core + chromium from the nix store and drives
  real chromium with the node(js) the repo flake ships (no .mcp.json server is wired; raw .mcp.json
  is not a pi mechanism anyway — see "Host-direct vs browser MCP"). Add --feedback to also send an
  answer, click Complete, and assert the FeedbackView (or Retry-scoring notice) renders. A
  companion debug runner (scripts/inspect.cjs) dumps the live DOM per stage when an assert is
  ambiguous; scripts/store.cjs holds the shared resolve/launch. The
  intended long-term browser-MCP path (pi MCP adapter in a package -> containerized @playwright/mcp)
  is noted in that section; host-direct is the working fallback needing NO host npm install / zero
  node_modules. Hermetic when the backend runs with CLERK_ENABLED=false (no-Clerk DEV_USER). If the
  stack runs real Clerk, sign in headlessly first via the clerk-stripe-operator skill. Use to
  reproduce or eyeball onboarding / new-interview / complete-scoring in a browser, or after applying
  frontend/backend changes.
---

# Hermetic E2E — onboarding, chat + complete-scoring walkthrough (host-direct; browser-MCP-via-adapter is a documented note, not wired)

A walkthrough an agent follows to simulate a user **onboarding**, **driving a chat turn** and
**(optionally) completing an interview** in the frontend, using a **real browser** via a committed
`node` runner that reads `playwright-core` + `chromium` from the nix store. No browser MCP server,
no `@playwright/test`, no host `npm install` — keeps local storage free of `node_modules`.

Follows the real DOM, not a fake: routes are `react-router-dom` in `frontend/src/App.tsx`.

**Hermetic by design:** run the dev stack against the **no-Clerk dev fallback** — backend started
WITHOUT `CLERK_ENABLED=true` so it returns `DEV_USER`, and frontend without a usable publishable key
so `clerkEnabled=false` renders the gated routes directly. No Clerk or Stripe keys needed. It does
not place a real Stripe payment.

## Host-direct vs browser MCP

Host-direct (a committed runner driving nix-store chromium) is the browser path this repo uses
and verifies. Browser MCP exists as a target only — see the note below; it is not wired.

Why host-direct is the working today-path:

- `playwright-core` is a store package you `require()` without installing.
- chromium's binary lives in the store at `<hash>-playwright-chromium/chrome-linux64/chrome`.
- The repo flake (`nix develop .`) puts a `nodejs` on PATH, so a host `node` drives it.
- No host `npm install`: nothing lands in `.playwright-mcp/` or any host `node_modules`.

> **Note — browser MCP is a pi adapter, not `.mcp.json`.** pi does not consume raw `.mcp.json`
> `mcpServers`; it reaches MCP servers through an MCP-adapter extension bundled in a **pi package**
> (pi README lists "MCP server integration" under extensions; packages carry extensions). The old
> `.mcp.json` playwright binary was garbage-collected and correctly removed — it was never how pi
> reached it. The intended browser-MCP path is a **containerized `@playwright/mcp`** service on the
> compose network (GC-proof, reachable by service name) consumed by a pi package MCP adapter; pin
> the adapter against the pi-version's extension API when building it (pi core docs lag the adapter).
> Not built here; host-direct is the verified fallback.

## Preconditions

- Dev stack up: `make up`. Confirm: `curl -s http://localhost:8000/health` -> 200 and
  `curl -s -o /dev/null -w "%{http_code}" localhost:5173/` -> 200.
- Decide the auth posture FIRST — the driving mechanism differs:
  - **Hermetic DEV_USER:** backend `CLERK_ENABLED=false`. Check
    `curl -s -w "%{http_code}\n" localhost:8000/usage` returns 200 for an unauthenticated caller.
    401 "Missing credentials" => the backend is in real-Clerk mode -> not hermetic; use the real-Clerk
    section below.
  - **Real Clerk:** backend `CLERK_ENABLED=true`. `/usage` returns 401 anonymously. Sign the browser
    in headlessly first (see real-Clerk section).
- A host node that can read the nix store. `nix develop .` puts a `nodejs` on PATH. The runner is
  **CommonJS (`require`)**, not ESM — playwright-core ships CJS, and ESM cannot `import ... from <expr>`.
- Store artifacts present: a `playwright-core-*` (with `index.js`) and `playwright-chromium` (with
  `chrome-linux64/chrome`). **Never hardcode a store hash** — they change per rebuild and get
  garbage-collected (the old `playwright-mcp-0.0.76` binary and earlier chromium hashes are already
  gone). `scripts/e2e.cjs` re-resolves both from `/nix/store` at startup by reading directory names
  (`<hash>-playwright-core-…` / `<hash>-playwright-chromium`) and checking for the real file/dir.

## Running the runners (pre-flight + journey in ONE command)

Helpers in `scripts/`; you normally only call the first two:

- `scripts/store.cjs` — shared: resolves playwright-core + chromium from `/nix/store` at runtime
  and exposes `{ BASE, CHROME_BIN, pcore, sleep, openBrowser }`. `e2e.cjs` and `inspect.cjs` both
  `require()` it, so resolve/browser-launch changes happen once. Do NOT hardcode a store hash.
- `scripts/e2e.cjs` — the assert run: onboarding + chat + Complete, prints PASS/FAIL.
- `scripts/inspect.cjs` — the debug run: same journey but dumps the live DOM per stage so you can
  SEE what actually rendered (add `--dom` for raw innerHTML) when an assert run is ambiguous.

```bash
# onboarding + dashboard nav only (fast sanity):
nix develop . -c node .pi/skills/hermetic-e2e/scripts/e2e.cjs

# full assert: send an answer, click Complete, assert FeedbackView OR the Retry-scoring notice:
nix develop . -c node .pi/skills/hermetic-e2e/scripts/e2e.cjs --feedback

# debug: same journey, dump the live DOM at each stage (append --dom for raw innerHTML):
nix develop . -c node .pi/skills/hermetic-e2e/scripts/inspect.cjs [--dom]

# optional overrides (all env-settable): E2E_BASE, E2E_ROLE, E2E_TOPIC, E2E_ANSWER
E2E_ANSWER="..." nix develop . -c node .pi/skills/hermetic-e2e/scripts/e2e.cjs --feedback
```

On a real model backend `/complete` runs inline and can block tens of seconds; `e2e.cjs` uses a
~90s deadline for the scoring outcome. Both runners create a real DEV_USER interview and print its
id — delete it when judging (History / `DELETE /interviews/<id>`).

Why a committed runner instead of a copy-paste snippet: the older skill handed agents an ESM
snippet (`import pw from PCORE_INDEX`) that is a **SyntaxError** (import specifiers must be string
literals) and used inconsistent variable names (`PCORE`/`CHROME`/`CHROME_PATH`/`CHROME_BIN`) across
sections, plus it resolved the top-level chromium *dir* rather than the real `chrome-linux64/chrome`
binary — all of which produced false "chromium missing" failures. Keeping resolution in one shared
module removes that whole class of error.

## The journey (what both modes assert, via the real DOM)

The labelled checkpoint array lives in `scripts/checkpoints.mjs`; `scripts/e2e.cjs` drives these
selectors as live `page.*` calls:

1. **Landing loads** — `page.goto(BASE + "/")`. Assert the marketing hero and CTA(s)
   ("Get started" / "Start practicing").
2. **Enter the app** — click **"Get started"** (header). Assert `page.url()` ends in `/app`.
3. **Dashboard + banner** — on `/app` assert the **dev-mode banner** ("Dev mode (no Clerk key)…")
   and the "New interview" form with `#role` + `#topic (optional)` inputs.
4. **Create interview** — fill `#role` and `#topic`, submit "Start interview".
5. **Route to detail** — after create the SPA navigates to `/interviews/{uuid}` and `InterviewChat`
   (auto-calls `startInterview` on mount) loads a textarea.
6. **(--feedback) Chat + Complete** — type a substantive answer into the textarea, click **Send**,
   await the interviewer's streamed reply (Complete re-enabled), click **Complete**, then poll the
   DOM for either:
   - the **FeedbackView** marker `"Your performance summary"` (real scores rendered) — PASS for the
     scoring path, or
   - the **Retry-scoring notice** `"scoring wasn't ready"` — the runner clicks **Retry scoring** and
     re-polls (covers the scope-3 recovery seam).

Do not treat a pending interview (`status=pending→in_progress` auto-transition client-side) as a
failure. Test interviews are real DEV_USER rows; the runner prints their ids. Delete them from
History / via `DELETE /interviews/<id>` when judging.

## Real-Clerk posture (NOT hermetic) — sign in first, then run

If the backend is `CLERK_ENABLED=true`, `/app` renders a signed-out gate and the steps fail at
banner/history. Do NOT claim it is hermetic. Instead:

1. Read `clerk-stripe-operator` SKILL.md → "Fully-headless Clerk auth"; use `@clerk/testing/playwright`
   (`clerkSetup` + `clerk.signIn`) with a throwaway test user:
   - mint the user: `.pi/skills/clerk-stripe-operator/scripts/clerk-mint.sh --email=<addr>`
   - sign the page in headlessly as that address; confirm a real `__session` cookie appears.
   - tear it down after: `clerk-mint.sh --admin-destroy --teardown --user=<user_id>`.
2. Now run the journey's `/app` assertions; you are exercising the real-Clerk auth path.
3. If you only need to eyeball a component behind the gate on an auth-gated route you can often take
   the hermetic route by toggling the backend to `DEV_USER` — but that mutates auth state / container
   env: ask / get explicit go-ahead first (AGENTS.md zero-touch).

## Source of truth for launching (only if you extend the runner or write a bespoke script)

playwright-core's index and chromium's binary each live at a HASH-prefixed store dir. Resolve at
runtime, use `require` (CJS), and point `executablePath` at `…/chrome-linux64/chrome` (NOT the bare
`playwright-chromium` dir):

```js
// bespoke.cjs — CommonJS, runtime-resolved (no hardcoded hashes):
const fs = require('fs'), path = require('path');
const pcoreDir = fs.readdirSync('/nix/store')
  .find(n => n.includes('playwright-core-') && !n.endsWith('.drv')
       && fs.existsSync(path.join('/nix/store', n, 'index.js')));
const chromeDir = fs.readdirSync('/nix/store')
  .find(n => n.includes('playwright-chromium')
       && fs.existsSync(path.join('/nix/store', n, 'chrome-linux64', 'chrome')));
const pw = require(path.join('/nix/store', pcoreDir, 'index.js'));
const b = await pw.chromium.launch({ executablePath: path.join('/nix/store', chromeDir, 'chrome-linux64', 'chrome'),
  headless: true, args: ['--no-sandbox', '--disable-gpu'] });
```

Do not reintroduce `import … from <var>` ESM or a bare-directory `executablePath`; prefer
`scripts/store.cjs` (it already does this), or add to it rather than duplicating resolution.

## Why this is not a CI spec

This is a **scripted walkthrough** that passes/fails live as it runs, with a printed PASS/FAIL and
exit code for the executed path — but not a reproducible CI regression suite (depends on machine-local
nix store paths). Deterministic CI would need the `@playwright/test` layer — a separate, heavier,
explicitly-added effort.

## After a run — verify then commit

```bash
make up      # ensure backend + frontend dev containers are running (needed by targets below)
make lint    # auto-fix: biome write (frontend) + ruff fix (backend)
make exec    # full gate: frontend typecheck+build+biome; backend ruff+pytest
```

- A non-zero `make exec` is a blocker; fix and re-run before committing.
- This walkthrough is behavioural and complements (does not replace) `make exec`'s static checks.
- Commit per AGENTS.md: conventional `type(scope):`, atomic by relevance, amend (not farm) when
  extending the last unpushed commit's concern, and ask before pushing or when scope is unclear.

## Guardrails

- Use test data only; interviews created here are real rows for DEV_USER — delete them (the runner
  prints ids; History / `DELETE /interviews/<id>` also works).
- The pure hermetic path never touches Clerk/Stripe keys. For the real-Clerk leg follow the
  `clerk-stripe-operator` skill (headless sign-in; real hosted Checkout only with a human at the card
  step); do not mix the two postures in one run and do not loop-automate Stripe's bot checks.
- No host `npm install`, no `.playwright-mcp/`, no committed store hashes — resolve store paths at
  runtime and keep local storage clean.
