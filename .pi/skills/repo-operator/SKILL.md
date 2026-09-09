---
name: repo-operator
description: >-
  Top-level "infra-hands" skill for the maxterview monorepo. When the user (or an agent) needs to
  operate or debug the running app and its auth/billing infra, load this FIRST. It gives one command
  surface to bring up and down the dev stack, read frontend/backend logs, reconcile the backend/.env
  Clerk/Stripe config (flagging exactly which secret is missing with the single paste step), query
  the database, drive the real test-mode Clerk and Stripe accounts, run a browser walkthrough, and
  see the repo at a glance. Binds to (does not duplicate) ./.pi/skills/clerk-stripe-operator AND
  ./.pi/skills/hermetic-e2e. Use when the user asks anything like "why is X failing", "start the
  app", "show logs", "set up a test user", "show webhooks", "what tier is this user", or "run the
  onboarding".
---

# maxterview repo operator (infra-hands)

You are operating a real app: FastAPI backend + React (Vite) frontend + Postgres, with **Clerk**
auth and **Stripe** billing. This is the whole-console playbook an AI loads to act — not to
narrate. Everything here is real infra you can actually reach from this repo.

## Key facts (from the repo)

- **Stack (docker compose, root):**
  - services: `backend` (FastAPI/uvicorn), `frontend` (Vite dev), `postgres`, plus `tools`. Profiles
    via `compose.yml` + `compose.dev.yml`/`compose.prod.yml`. Project name `maxterview-dev`.
  - Makefile conveniences: `make up`, `down`, `logs`, `psql`, `shell`, `exec`, `migrate`, `test-llm`.
  - Host ports: backend `8000`, frontend `5173`, postgres `5432`.
- **Config**: Clerk/Stripe/LLM live in git-ignored `backend/.env` (backend reads it via compose).
  Frontend `VITE_CLERK_PUBLISHABLE_KEY` lives in `frontend/.env` (git-ignored). Root `.env` is
  infra-only (POSTGRES_*, ports, APP_ENV).
- **No Clerk key enabled ⇒ the frontend falls into "no-Clerk dev mode"** (`clerkEnabled=false`),
  which lets you drive the whole auth-gated UI against the backend's `DEV_USER`. This is the fastest
  way to reproduce most UI/behaviour issues WITHOUT any Clerk/Stripe credentials.
- **Backend surfaces**: `/health`, `/interviews`, `/interviews/{id}` (+`/start`,`/complete`,
  `/messages`, `/feedback`), `/usage`, `/billing/checkout`, `/billing/portal`, `/billing/webhook`,
  `/interviews/{id}/chat/stream` (SSE).
- **Auth**: JWT verified against Clerk JWKS when `CLERK_ENABLED=true`; `__session` cookie primary,
  `Authorization: Bearer` accepted. When `CLERK_ENABLED=false` (dev/test only) a fixed `DEV_USER`.
- **Billing model (MONETIZATION.md)**: free/premium tiers from chat-turn caps; real entitlement via
  Stripe events → `subscriptions` table → `resolve_tier`. When Stripe keys are unset, `/billing/*`
  curls 503.

## Built-in companion skills (load on demand, don't duplicate)

- `./pi`-discoverable **clerk-stripe-operator** → real test-mode Clerk user/session mint + Stripe
  price/customer/webhook/state — gives you API hands on both accounts (curl), with live-key refusal
  and `--admin-destroy` gating. Use for "set up a test user", "show webhooks/customers/price",
  "make it premium", "tear that test user down".
- **hermetic-e2e** → a browser walkthrough of onboarding + chat/complete-scoring, driven HOST-DIRECT
  with nix-store playwright-core/chromium (no browser MCP is wired; pi consumes MCP via a pi-package
  MCP adapter, not `.mcp.json` — containerized `@playwright/mcp` via adapter is the documented target;
  see hermetic-e2e SKILL.md). `e2e.cjs` asserts the journey (PASS/FAIL, `--feedback` adds
  chat+Complete); `inspect.cjs` dumps the live DOM per stage for debug; both share `store.cjs`.
  Hermetic DEV_USER needs the
  backend at CLERK_ENABLED=false; real-Clerk stacks sign in headlessly first. Use to drive the UI
  quickly. (Not a deterministic CI spec.)

## Quick console (run from repo root)

Bring the stack up (if already up this is idempotent-ish):

```bash
make up                 # docker compose up -d (project maxterview-dev)
docker compose -f compose.yml -f compose.dev.yml ps    # status
make logs               # both services, tail 100; or:
docker logs --tail 200 maxterview_backend_dev
docker logs --tail 200 maxterview_frontend_dev
make psql               # open a DB shell
```

One-shot context gather (read-only): confirm which services are up + hit `/health` + `/usage`:

```bash
docker compose -f compose.yml -f compose.dev.yml ps
curl -s http://localhost:8000/health; echo
curl -s http://localhost:8000/usage; echo     # tier for the current (DEV_USER) caller if no __session
```

## Feature enablement — what to initialize first on a fresh device

Every repo feature gates on some git-ignored env value. On a new clone you set ONLY what you
need; nothing is required for everything. Read each key from its account dashboard (Clerk/Stripe);
keep secrets sealed (zero-touch) — say which var is missing, never the value.

| Feature | git-ignored file + var | Value you set once | Notes |
| --- | --- | --- | --- |
| Run the UI/API on no-auth dev fallback | *(nothing)* | — | default: `CLERK_ENABLED=false` → `DEV_USER`; fastest path, no keys |
| Real Clerk sign-in (UI button) + JWT auth | `backend/.env` → `CLERK_ENABLED=true`, `CLERK_DOMAIN`, `CLERK_JWKS_URL`; `frontend/.env` → `VITE_CLERK_PUBLISHABLE_KEY` | the .accounts.dev HTTPS URL + its JWKS + the `pk_test_…` | public, not secrets; best on the **Development** instance |
| Headless Clerk ops (mint users/sessions/tokens, read users) — the CLI + mint script | `backend/.env` → `CLERK_SECRET_KEY` | `sk_test_…` (instance secret, Backend API) | this is what drives `clerk` Backend-API commands + `clerk-mint.sh`. The backend itself does NOT read it (JWT verify is public JWKS only). |
| Clerk CLI shell (needs the tool only) | nix flake (`nix develop .`) has `nodejs`; `clerk` run via container `npx` | — | `docker exec maxterview_frontend_dev sh -c 'npx clerk …'` or `clerk api` with `CLERK_SECRET_KEY` |
| Stripe checkout → premium webhook row | `backend/.env` → `STRIPE_SECRET_KEY` (`sk_test_`), `STRIPE_WEBHOOK_SECRET` (`whsec_` from `stripe listen`), `STRIPE_PRICE_ID` | test-mode secret + webhook secret + a monthly price id | `stripe` CLI on host (flake) starts the listener; the `whsec_` must match the backend config |
| LLM interview chat / feedback | `backend/.env` → `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` (or empty = STUB) | OpenAI-compatible base/model/key | no key → deterministic stub |
| Observability | OBSERVABILITY.md | n/a | docs-first, not wired |

**Not needed** on any device: `clerk auth login`, `clerk link`, or a `CLERK_PLATFORM_API_KEY`.
That Platform/admin path requires an account opted into the Platform API beta (many accounts
show no such page) and, where present, its dashboard-only creation. It manages apps/domains —
NOT needed to run the app, sign in, mint users, or accept Stripe subscriptions. Everything an
operator/agent needs runs off the instance `CLERK_SECRET_KEY` (Backend API) + the Stripe test
keys above.

Fast reproducible check that feature env is in place (lists set/missing names only):

```bash
./.pi/skills/clerk-stripe-operator/scripts/need-keys.sh
```

## Reading config (zero-touch) and the one paste-step

Do NOT cat secrets or print secret values. Determine *presence* only. The operator skill's
`need-keys.sh` does exactly this; run it:

```bash
./.pi/skills/clerk-stripe-operator/scripts/need-keys.sh
```

It reports, for each Clerk/Stripe/optional var, set / missing / present-but-live — and prints WITH
placeholders only the paste template for what's actually missing. It never reveals a value. The
human keeps every secret sealed; you only ever say "please add `X` to `backend/.env`" if a step
truly needs one and it isn't set.

Remember the two runtime modes:
- **Fast debug mode (recommended default):** no Clerk key → backend `DEV_USER`, UI testable now. Run
  against dev (CLERK_ENABLED=false) using whatever is in env.
- **Full live-auth mode:** requires real `CLERK_ENABLED=true` + domain/JWKS/audience + frontend pk,
  plus the Clerk `sk_test` operator secret to mint sessions/users for headless browser auth
  (@clerk/testing) on real-Clerk stacks.

## Acting on the Clerk/Stripe sandbox

Use child skill `clerk-stripe-operator` for real account operations, not hand-rolled curl. Recall:
it refuses `*_live_*`, and anything destructive requires `--admin-destroy`. Representative calls:

```bash
# config health + list the fields you need human paste into backend/.env:
./.pi/skills/clerk-stripe-operator/scripts/need-keys.sh
# mint a throwaway test user + session/testing-token (idempotent-ish; prints user-id):
./.pi/skills/clerk-stripe-operator/scripts/clerk-mint.sh --email=qa@example.com
# webhook to flip that user's entitlement row to premium (uses real Stripe sandbox via CLI listen):
./.pi/skills/clerk-stripe-operator/scripts/webhook-driver.sh --event=customer.subscription.created
# read the subscriptions rows + /usage to prove who's premium (read-only debug-state):
./.pi/skills/clerk-stripe-operator/scripts/debug-state.sh
```

## Browser drive (no browser MCP wired; pi uses a package MCP adapter if you add one)

`.mcp.json` no longer declares a `playwright` server (the old `/nix/store/...playwright-mcp...`
binary was garbage-collected). Raw `.mcp.json` is not how pi reaches an MCP server anyway — pi loads
MCP through an MCP-adapter extension shipped as a **pi package**, whose natural target is a
containerized `@playwright/mcp` service (see hermetic-e2e SKILL.md). Until that adapter is built,
drive the browser one of these working paths:

- **Hermetic DEV_USER (no keys):** run the committed runner from the `hermetic-e2e` skill, which
  resolves `playwright-core` + chromium from `/nix/store` at runtime (no host npm install → no
  `node_modules` on the host):
  ```bash
  nix develop . -c node .pi/skills/hermetic-e2e/scripts/e2e.cjs             # onboarding/nav
  nix develop . -c node .pi/skills/hermetic-e2e/scripts/e2e.cjs --feedback  # + chat + Complete
  ```
  Backend must be `CLERK_ENABLED=false`. Check posture first: `curl -s -o /dev/null -w "%{http_code}" localhost:8000/usage`
  → 200 means DEV_USER (hermetic); 401 means real-Clerk (not hermetic).
- **Real-Clerk headless sign-in:** use the `clerk-stripe-operator` skill → `@clerk/testing/playwright`
  (`clerkSetup` + `clerk.signIn`) with a throwaway minted user, then render the auth-gated route.
  Real hosted Stripe Checkout still needs real keys and a human at the card step — see
  `references/card-browser-checkout.md`; do NOT loop-automate Stripe's bot checks.

Never hand-roll a brand-new browser harness when the committed runner / clerk skill cover it.

## Workflow guidance (how to reason as the infra-hands)

1. Gather: is the stack up? health? which env mode? (`docker compose ps`, `/health`, `need-keys.sh`).
2. If something fails, reproduce smallest: it may not need Clerk at all → use DEV_USER + `make logs`
   + the exact failing request.
3. Once you see the failing API response/log line, either fix config/env (point the human at the
   one line to add, or set in backend/.env if it's a non-secret like APP_ENV) or adjust the code,
   then re-verify via the same request/log path.
4. Only pull in Clerk-stripe-operator when the failure truly crosses into account state (e.g.
   webhook signature, tier not flipping, checkout 503, missing price) — do not touch real accounts
   for every dev bug.
5. Ask the user before any action that mutates persistent Clerk/Stripe sandbox state unless you
   already have explicit go-ahead or it is the obviously-safe throwaway op.

## Verify then commit (always after applying code changes)

Whenever you have made edits (frontend or backend) and they form a justifiable unit, do NOT commit
until you have run this repo's own gates. The stack must be up for the docker-exec targets; if it
is down, run `make up` first (containers: `maxterview_frontend_dev`, `maxterview_backend_dev`).

```bash
make up        # ensure the backend + frontend dev containers exist
make lint      # biome write (frontend) + ruff fix (backend) — auto-fix, then re-inspect diff
make exec      # full gate: frontend npm ci + biome + typecheck + build; backend sync + ruff + pytest
```

- `make exec` is the closest single command to the repo's local pre-merge gate (mirrors what
  `.github/workflows/ci-pipeline.yml` runs). Treat a non-zero exit as a blocker on committing.
- If `make exec` fails, fix the surfaced failure and re-run before moving on.
- (Optional, for flows touching auth-gated UI): drive the application once with the
  `hermetic-e2e` onboarding/navigation walkthrough (host-direct playwright-core browser) so behavior
  is exercised, since `make exec` is static checks + unit tests, not a browser.

Then commit per the repo's AGENTS.md policy:
- Conventional commits only: `feat(scope):`, `test(scope):`, `fix(scope):`, `ref(scope):`,
  `docs(scope):`, `chore(scope):`, `revert(scope):`. Subject < 60 chars, no body needed for
  trivial; add a short body when the scope is non-obvious.
- Atomic by relevance: group files of ONE logical change into one commit; never cram unrelated
  edits together. If unsure whether separate edits are one change, ask.
- Amend, do not farm: if this edit extends the last unpushed commit's same logical concern, fold
  it in with `git commit --amend` instead of opening a new commit. Open a new commit only when
  the change is genuinely distinct.
- Do not commit half-finished or speculative work. `git status` should reflect exactly what is
  intended; never `git add -A` blindly.
- Never push without the user asking; surface divergence/amends clearly if relevant.
- If uncertain whether the change is one logical scope, or whether to amend vs open new, ask the
  user first rather than guessing.
## Guardrails

- ZERO TOUCH on secrets: presence-check only; never print/commit/log a key. Paste-steps always stay
  manual for the human.
- Never run against `sk_live_`/`whsec_live_`. Live key presence is a red flag: stop and surface it.
- Browser/automation never defeats Stripe anti-bot; a human completes the real card step.
- This repo's own rules: atomic commits, no command that risks uncommitted data, security first.
