---
name: repo-operator
description: >-
  Top-level "infra-hands" skill for the maxterview monorepo. When the user (or an agent) needs to
  operate or debug the running app and its auth/billing infra, load this FIRST. It gives one command
  surface to bring up and down the dev stack, read frontend/backend logs, reconcile the backend/.env
  Clerk/PayMongo config (flagging exactly which secret is missing with the single paste step), query
  the database, drive the real test-mode Clerk and PayMongo accounts, run a browser walkthrough, and
  see the repo at a glance. Binds to (does not duplicate) ./.pi/skills/paymongo-operator,
  ./.pi/skills/hermetic-e2e AND ./.pi/skills/grafana-operator.
---

# maxterview repo operator (infra-hands)

You are operating a real app: Hono on Node backend + React (Vite) frontend + Postgres, with **Clerk**
auth and **PayMongo** billing. This is the whole-console playbook an AI loads to act — not to
narrate. Everything here is real infra you can actually reach from this repo, the cluster included
via one SSH hop that asks first; see below.

## Key facts (from the repo)

- **Stack (docker compose, root):**
  - services: `backend` (Hono on Node, `tsx watch`), `frontend` (Vite dev), `postgres`, plus `tools`. Profiles
    via `compose.yml` + `compose.dev.yml`/`compose.prod.yml`. Project name `maxterview-dev`.
  - Makefile conveniences: `make up`, `down`, `logs`, `psql`, `shell`, `exec`, `migrate`.
  - Host ports: backend `8000`, frontend `5173`, postgres `5432`.
- Config lives in three git-ignored `.env` files, one per consumer: root (POSTGRES*\*, ports, APP_ENV,
  plus the two MCP tokens `.envrc` exports to the shell), `backend/.env` (runtime config),
  `frontend/.env` (`VITE*\*`). `make env-sync-dev`fills the credential lines in the first two from
Infisical's dev env at`/consumers/maxterview`, inside a marked block at the end of each file; it is
  the only target that needs the network.
- **Cluster reach is one SSH hop, and it asks first.** The k3s kubeconfig (and therefore `kubectl`,
  `argo`, Helm) lives on the node, not here (`~/.kube` holds only caches). The node is
  `$TARGET` over Tailscale, opened with `$KEY`, a key that logs into the node
  and nothing else (the CD key is not a node login). Both live in `.env`. **Ask the user before opening a session**, then:

  ```bash
  ssh -i "$KEY" "$TARGET" 'kubectl get pods -A; kubectl top nodes'
  ```

  Read-only by default: `apply`, `delete`, `scale`, `rollout restart`, `edit`, `exec` and `sudo` each
  need their own go-ahead. `kubectl top` is the only view of node and pod resources anywhere, live
  and unretained (`OBSERVABILITY.md`). If the key is absent, hand the user the command instead. Prod
  is still verifiable from here, from the other end of the pipe, via the **grafana-operator** skill:
  Loki for what the pods logged, Prometheus and Tempo for what they exported. All three are reachable
  through the datasource proxy with no cluster. A frontend redeploy, for instance, shows up as the
  frontend's kube-probe log lines disappearing.

- **No Clerk key enabled ⇒ the frontend falls into "no-Clerk dev mode"** (`clerkEnabled=false`),
  which lets you drive the whole auth-gated UI against the backend's `DEV_USER`. This is the fastest
  way to reproduce most UI/behaviour issues WITHOUT any Clerk/PayMongo credentials.
- **Backend surfaces** (all under the app's `/api` prefix): `/api/health`, `/api/interviews`, `/api/interviews/{id}` (+`/start`,`/finish`,`/archive`,
  `/chat`, `/feedback`, `/feedback/generate`), `/api/billing/usage`,
  `/api/billing/checkout`, `/api/billing/cancel`, `/api/billing/webhook`, `/api/billing/webhook/simulate`,
  `/api/interviews/{id}/chat/send` (SSE).
- **Auth**: JWT verified against Clerk JWKS when `CLERK_ENABLED=true`; `__session` cookie primary,
  `Authorization: Bearer` accepted. When `CLERK_ENABLED=false` (dev/test only) a fixed `DEV_USER`.
- **Billing model (MONETIZATION.md)**: free/premium tiers from daily GLOBAL per-owner chat-turn caps;
  real entitlement via PayMongo webhook events → `subscriptions` table → `resolve_tier`. The shipping
  rail is `BILLING_MODE=period` (one payment buys 30 days; no `PAYMONGO_PLAN_ID` needed). When
  `PAYMONGO_SECRET_KEY` is unset, `/api/billing/checkout` returns 503 (`/api/billing/cancel` still works —
  period mode only flips the row); the dev-only `/api/billing/webhook/simulate` still proves the
  entitlement path. **Prod's `PAYMONGO_SECRET_KEY`/`_WEBHOOK_SECRET` are populated in Infisical**
  (terraform `infra/k3s`; its ADR records prod's pair as live-mode), so the period rail is live there.
  Remaining proof: one real ₱99 payment (PLAN.md).

## Built-in companion skills (load on demand, don't duplicate)

- `./pi`-discoverable **paymongo-operator** → real test-mode Clerk user/session mint + PayMongo
  plan/customer/subscription/webhook/state — gives you API hands on both accounts (curl), with
  live-key refusal and `--admin-destroy` gating. Use for "set up a test user", "show
  webhooks/customers/plan", "make it premium", "tear that test user down".
- **hermetic-e2e** → drive a real headless browser against the running frontend through the wired
  `playwright` MCP server (nixpkgs `playwright-mcp` via `.pi/mcp.json`), reached from codemode as
  `tools.mcp__playwright__browser_*`. It returns observations, not assertions: read the snapshot, the
  waited-for text, or a `browser_evaluate` result and judge it yourself (not a deterministic CI spec).
  Hermetic DEV_USER needs backend at CLERK_ENABLED=false; real-Clerk stacks sign in first
  (paymongo-operator).
- **grafana-operator** → the Grafana Cloud stack behind the alerts: folder / rule / contact-point
  uids, the measured API verb semantics that keep one project's write from moving another's rules,
  the `provenance` switch that decides UI-editability, Loki through the datasource proxy, and
  `observability/grafana/bootstrap.py` to give a new project its own folder + rules + dashboard.
  Use for "why didn't the alert fire", "change a threshold", "show the dashboards", "onboard a
  project into Grafana".

## Quick console (run from repo root)

Bring the stack up (if already up this is idempotent-ish):

```bash
make up                 # docker compose up -d (project maxterview-dev)
make ps                 # status; raw equivalent needs the project name:
docker compose -p maxterview-dev -f compose.yml -f compose.dev.yml ps   # without -p, compose derives
                                                                       # another project name and lists nothing
make logs               # both services, tail 100; or:
docker logs --tail 200 maxterview_backend_dev
docker logs --tail 200 maxterview_frontend_dev
make psql               # open a DB shell
```

**Dependency changes need a rebuilt image AND a renewed volume.** `/app/node_modules` is an anonymous
volume (`compose.dev.yml`), so a stale one keeps shadowing the image, and the image itself can predate
`package-lock.json`. Symptoms: Vite 500 on one module (`Failed to resolve import ...`), `#root` with 0
children, locator timeouts, `npm ls <pkg>` empty inside the container. Fix both halves:

```bash
docker compose -p maxterview-dev -f compose.yml -f compose.dev.yml build frontend
docker compose -p maxterview-dev -f compose.yml -f compose.dev.yml up -d --force-recreate -V frontend
```

`-V` renews the anonymous volumes; without it the stale `node_modules` returns.

One-shot context gather (read-only): confirm which services are up + hit `/api/health` + `/api/billing/usage`:

```bash
docker compose -p maxterview-dev -f compose.yml -f compose.dev.yml ps
curl -s http://localhost:8000/api/health; echo
curl -s http://localhost:8000/api/billing/usage; echo     # tier for the current (DEV_USER) caller if no __session
```

## Feature enablement — what to initialize first on a fresh device

Every repo feature gates on some git-ignored env value. On a new clone you set ONLY what you need;
nothing is required for everything. **The canonical feature → env-var table is `README.md` § "What to
initialize to use each feature"** — read it there instead of keeping a second copy here. Read each
key from its account dashboard (Clerk/PayMongo) and keep secrets sealed (zero-touch): say _which_
var is missing, never its value.

Skill-specific notes the README does not carry:

- `CLERK_SECRET_KEY` drives the `clerk` Backend-API CLI + `clerk-mint.sh`. **The backend itself never
  reads it** — JWT verification is public-JWKS only.
- The clerk CLI runs as `docker exec maxterview_frontend_dev sh -c 'npx clerk …'` (the nix flake has
  `nodejs`; NixOS cannot run the npm-global `clerk` binary).
- PayMongo has **no CLI and no webhook listener** — deliver events with `webhook-driver.sh` (signed)
  or `--simulate`.
- Unset `PAYMONGO_SECRET_KEY` → `/billing/checkout` 503s (`/billing/cancel` still works; period mode
  only flips the row) and the dev-only `/billing/webhook/simulate` still proves the entitlement path.
- `BILLING_MODE=subscription` + `PAYMONGO_PLAN_ID` is **blocked** until support enables Subscriptions
  - Card Vaulting (`MONETIZATION.md` §4).

**Not needed** on any device: `clerk auth login`, `clerk link`, or a `CLERK_PLATFORM_API_KEY`.
That Platform/admin path needs an account opted into the Platform API beta (many accounts show no
such page) and, where present, its dashboard-only creation. It manages apps/domains — NOT needed to
run the app, sign in, mint users, or accept PayMongo subscriptions. Everything an operator/agent
needs runs off the instance `CLERK_SECRET_KEY` (Backend API) + the PayMongo test keys.

Fast reproducible check that feature env is in place (lists set/missing names only):

```bash
./.pi/skills/paymongo-operator/scripts/need-keys.sh
```

## Reading config (zero-touch) and the one paste-step

Do NOT cat secrets or print secret values. Determine _presence_ only. The operator skill's
`need-keys.sh` does exactly this; run it:

```bash
./.pi/skills/paymongo-operator/scripts/need-keys.sh
```

It reports, for each Clerk/PayMongo/optional var, set / missing / present-but-live — and prints WITH
placeholders only the paste template for what's actually missing. It never reveals a value. The
human keeps every secret sealed; you only ever say "please add `X` to `backend/.env`" if a step
truly needs one and it isn't set.

Remember the two runtime modes:

- **Fast debug mode (recommended default):** no Clerk key → backend `DEV_USER`, UI testable now. Run
  against dev (CLERK_ENABLED=false) using whatever is in env.
- **Full live-auth mode:** requires real `CLERK_ENABLED=true` + domain/JWKS/audience + frontend pk,
  plus the Clerk `sk_test` operator secret to mint sessions/users for headless browser auth
  (@clerk/testing) on real-Clerk stacks.

## Acting on the Clerk/PayMongo sandbox

Use child skill `paymongo-operator` for real account operations, not hand-rolled curl. Recall:
it refuses `*_live_*`, and anything destructive requires `--admin-destroy`. Representative calls:

```bash
# config health + list the fields you need human paste into backend/.env:
./.pi/skills/paymongo-operator/scripts/need-keys.sh
# mint a throwaway test user + session/testing-token (idempotent-ish; prints user-id):
./.pi/skills/paymongo-operator/scripts/clerk-mint.sh --email=qa@example.com
# webhook to flip that user's entitlement row to premium (no listener/CLI exists for PayMongo;
# --simulate needs no secret, the default signed mode proves the HMAC path):
./.pi/skills/paymongo-operator/scripts/webhook-driver.sh --simulate --event=subscription.activated --customer=cus_x --subscription=subs_x
# read the subscriptions rows + /api/billing/usage to prove who's premium (read-only debug-state):
./.pi/skills/paymongo-operator/scripts/debug-state.sh
```

## Browser drive (see hermetic-e2e for full detail)

The **playwright MCP server** is wired in `.pi/mcp.json` (nixpkgs `playwright-mcp` from the flake
devShell; needs pi running inside `nix develop`). It is `codemode` exposure, so call the ref-based
`mcp__playwright__browser_*` tools from a codemode script. There is no host runner: a verdict is a
snapshot, a waited-for text, or a `browser_evaluate` result you judge yourself.

Check posture before driving: `curl -s -o /dev/null -w "%{http_code}" localhost:8000/api/billing/usage`
→ 200 means DEV_USER (backend `CLERK_ENABLED=false`, hermetic); 401 means real-Clerk (not hermetic).

- **Real-Clerk headless sign-in:** use the `paymongo-operator` skill → `@clerk/testing/playwright`
  (`clerkSetup` + `clerk.signIn`) with a throwaway minted user, then render the auth-gated route.
  A real QR Ph payment still needs real keys and a human at the wallet step — see
  `references/qrph-checkout.md` (in `paymongo-operator`); do NOT loop-automate that handoff (and use
  `webhook-driver.sh --simulate` when you only need the entitlement assertion).

Never hand-roll a brand-new browser harness: the MCP server and the clerk skill cover it.

## Workflow guidance (how to reason as the infra-hands)

1. Gather: is the stack up? health? which env mode? (`docker compose ps`, `/api/health`, `need-keys.sh`).
2. If something fails, reproduce smallest: it may not need Clerk at all → use DEV_USER + `make logs`
   - the exact failing request.
3. Once you see the failing API response/log line, either fix config/env (point the human at the
   one line to add, or set in backend/.env if it's a non-secret like APP_ENV) or adjust the code,
   then re-verify via the same request/log path.
4. Only pull in the paymongo-operator skill when the failure truly crosses into account state (e.g.
   webhook signature, tier not flipping, checkout 503, missing plan) — do not touch real accounts
   for every dev bug.
5. Ask the user before any action that mutates persistent Clerk/PayMongo sandbox state unless you
   already have explicit go-ahead or it is the obviously-safe throwaway op.

## Verify then commit (always after applying code changes)

Whenever you have made edits (frontend or backend) and they form a justifiable unit, do NOT commit
until you have run this repo's own gates. The stack must be up for the docker-exec targets; if it
is down, run `make up` first (containers: `maxterview_frontend_dev`, `maxterview_backend_dev`).

```bash
make up        # ensure the backend + frontend dev containers exist
make lint      # biome write (frontend) + biome fix (backend) — auto-fix, then re-inspect diff
make exec      # full gate: frontend npm ci + biome + typecheck + build; backend npm ci + biome + typecheck + build + vitest
```

- `make exec` is the closest single command to the repo's local pre-merge gate (mirrors what
  `.github/workflows/ci-pipeline.yml` runs). Treat a non-zero exit as a blocker on committing.
- If `make exec` fails, fix the surfaced failure and re-run before moving on.
- (Optional, for flows touching auth-gated UI): drive the application once through the
  `hermetic-e2e` browser walkthrough so behavior is exercised, since `make exec` is static checks +
  unit tests, not a browser.

Then commit per the repo's `AGENTS.md` commit policy (conventional prefixes, atomic scope, amend
don't farm, never `git add -A` blindly, never push unprompted).

## Guardrails

- ZERO TOUCH on secrets: presence-check only; never print/commit/log a key. Paste-steps always stay
  manual for the human.
- Never run against `sk_live_`/`whsec_live_`. Live key presence is a red flag: stop and surface it.
- Browser/automation never completes a live QR Ph payment; a human finishes the wallet step.
- This repo's own rules: atomic commits, no command that risks uncommitted data, security first.
