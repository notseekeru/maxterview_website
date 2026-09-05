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
- **hermetic-e2e** → a browser walkthrough of onboarding + dashboard nav through Playwright-MCP,
  hermetic DEV_USER, no keys. Use to drive the UI quickly. (Not a deterministic CI spec.)

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
  plus the Clerk `sk_test` operator secret to mint sessions/users for browser auth.

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

## Browser drive (Playwright MCP)

For UI reproduction/navigation use the Playwright MCP (chromium, already in `.mcp.json`): navigate,
fill, click, assert_text, screenshot, etc. The hermetic-e2e skill documents the onboarding journey
(Landing → /app → create interview → /interviews/:id) against DEV_USER. Real hosted Stripe Checkout
needs real keys and a human at the card step — see clerk-stripe-operator's
`references/card-browser-checkout.md`; do NOT loop-automate Stripe's bot checks.

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

## Guardrails

- ZERO TOUCH on secrets: presence-check only; never print/commit/log a key. Paste-steps always stay
  manual for the human.
- Never run against `sk_live_`/`whsec_live_`. Live key presence is a red flag: stop and surface it.
- Browser/automation never defeats Stripe anti-bot; a human completes the real card step.
- This repo's own rules: atomic commits, no command that risks uncommitted data, security first.
