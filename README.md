# maxterview

[![CI](https://img.shields.io/github/actions/workflow/status/notseekeru/maxterview_website/ci-pipeline.yml?branch=main&label=CI)](https://github.com/notseekeru/maxterview_website/actions/workflows/ci-pipeline.yml)
[![CD](https://img.shields.io/github/actions/workflow/status/notseekeru/maxterview_website/cd-pipeline.yml?branch=main&label=CD)](https://github.com/notseekeru/maxterview_website/actions/workflows/cd-pipeline.yml)

**AI mock-interview coach** — practice interviews with an LLM that asks questions, annotates every
answer like a chess engine would (brilliant → blunder), and scores the run: accuracy, letter grade,
hire/reject call, tips. **MVP is text-based.**

Stack: **FastAPI** (backend) + **React + TypeScript + Vite** frontend (SPA) + **PostgreSQL 17**,
run with Docker Compose. Frontend: Tailwind 4 + shadcn/ui + react-router.

Docs:

- `PLAN.md` — technical decisions (D1–D12) and milestones (M1–M17)
- `MONETIZATION.md` — billing spec (quotas + PayMongo subscriptions shipped; PayMongo sandbox proof pending)
- `BYOK.md` — per-owner LLM provider keys (settings panel → `/app/settings/system`)
- `OBSERVABILITY.md` — logging/error-tracking/metrics plan (doc-first M13)

---

## Architecture

```
Browser (React SPA) ── /api ──► nginx/Vite proxy ──► FastAPI ──► PostgreSQL 17
                                (path passthrough)   │
                                                         └──► LLM (OpenAI-compatible)
```

- **Backend** (`backend/`): monolith FastAPI in `app/main.py`, raw SQL via asyncpg (`app/db.py`),
  manual Clerk JWT/JWKS verification (`app/auth.py`), OpenAI-compatible LLM client (`app/llm.py`).
  Migrations via **yoyo** (`backend/migrations/*.sql`).
- **Frontend** (`frontend/`): React 19 + Vite 8 + TypeScript 7, Tailwind 4 + shadcn/ui + react-router.
  Serves the interview UI and consumes the SSE `chat/stream` endpoint with native fetch streaming.

### Key flow (the interview loop)

```
create → start → chat/stream (SSE) → … → complete → feedback
```

- `POST /api/interviews` (create, role required) → `pending`
- `POST /api/interviews/{id}/start` → `in_progress`
- `POST /api/interviews/{id}/chat/stream` — **SSE**: user answer in, assistant reply streamed out
  (`event: message` / `done` / `error`). Persists both turns.
- `POST /api/interviews/{id}/complete` → `completed` + auto-generated feedback (409 if no turn was ever
  sent — an empty transcript is unscorable, so completion is refused instead of dead-ending a
  completed interview with no score)
- `GET /api/interviews/{id}/feedback` → accuracy + grade / verdict / tips (+ secondary 1-10 dims)
- `POST /api/interviews/{id}/feedback/generate` → (re)score a completed interview; 409 when it is not
  completed or has no answers, 503 when the model is unavailable right now (retryable)
- Every query is scoped to the owner (`ClerkUser.sub` / dev `DEV_USER`).

---

## Quickstart (dev)

Requires Docker + Docker Compose v2. Copy the example env and (optionally) fill in real values:

```bash
cp .env.example .env                  # compose/infra only: APP_ENV, POSTGRES_*, ports
cp backend/.env.example backend/.env  # backend runtime: CLERK, LLM, quotas, PAYMONGO
cp frontend/.env.example frontend/.env # VITE_* frontend vars
make up                     # builds + starts postgres, backend, frontend   (dev only — prod uses Neon)
```

- Backend API: http://localhost:8000/api (`/api/health`)
- Frontend UI: http://localhost:5173

Then open the frontend, create an interview (role + optional topic), answer the AI's questions,
and click **Complete** to see feedback.

### What to initialize to use each feature

Everything below reads git-ignored env in `backend/.env` (backend) or `frontend/.env` (frontend).
`cp *.env.example *.env` first; you only need to fill the vars for the features you actually use.
Run `need-keys.sh` to see which are set (names only):

```bash
./.pi/skills/paymongo-operator/scripts/need-keys.sh   # set/missing, never values
```

| Want this feature                                               | Set in `backend/.env`                                                              | plus                                                   | how to run/verify                                                                                                    |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| UI/API with no auth at all (fast dev)                           | _(nothing)_                                                                        | —                                                      | default works (`CLERK_ENABLED=false` → `DEV_USER`)                                                                   |
| Real Clerk sign-in button + JWT auth                            | `CLERK_ENABLED=true`, `CLERK_DOMAIN`, `CLERK_JWKS_URL`                             | `frontend/.env` `VITE_CLERK_PUBLISHABLE_KEY=pk_test_…` | `make up`, visit `/app`, sign in                                                                                     |
| Headless Clerk ops (mint users/sessions, drive the `clerk` CLI) | `CLERK_SECRET_KEY=sk_test_…`                                                       | —                                                      | `docker exec -e CLERK_SECRET_KEY="$CLERK_SECRET_KEY" maxterview_frontend_dev sh -c 'cd /tmp && npx clerk api users'` |
| PayMongo ₱499/mo subscription → premium row                     | `PAYMONGO_SECRET_KEY` (`sk_test_…`), `PAYMONGO_WEBHOOK_SECRET`, `PAYMONGO_PLAN_ID` | —                                                      | upgrade in the UI → Maya page; dev instead: POST `/api/billing/webhook/simulate` (no tunnel, no keys)                |
| Real AI interviewer chat + auto-feedback                        | `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`                                         | —                                                      | empty → deterministic STUB (model-free tests/dev)                                                                    |
| Observability                                                   | _(nothing yet)_                                                                    | —                                                      | `OBSERVABILITY.md` (docs-first, not wired)                                                                           |

Feature env values come from your Clerk app's **Development instance** (`.clerk.accounts.dev` /
`pk_test_` / `sk_test_`) and PayMongo **test mode** — both are safe to use on `localhost`. The
production `pk_live_…` / `sk_live_…` keys are locked to `seekeru.tech` and will be rejected
elsewhere.

> **You do NOT need** `clerk auth login`, `clerk link`, or a `CLERK_PLATFORM_API_KEY` to use any
> repo feature. Those Platform/admin tools manage apps/domains (a beta, dashboard-only capability)
> and add nothing here — the instance `CLERK_SECRET_KEY` (Backend API) plus `curl` and the PayMongo dashboard cover
> everything an operator needs. Avoid the dead-ends: NixOS can't run the npm-global `clerk` binary,
> and the container's OAuth loopback isn't reachable from a host browser.

---

> **Local llama.cpp caveat:** some llama.cpp builds return HTTP 500 to **non-streaming**
> `/chat/completions` when called via httpx, so auto-feedback can come back empty against a local
> llama.cpp (the streaming chat path is unaffected). Use a chat/OpenAI-compatible provider
> (e.g. DeepSeek) for structured feedback output. See `backend/.env.example`.
>
> The stage-2 formatter asks for grammar-constrained JSON (`response_format=json_schema`, greedy
> decoding) and transparently retries with `json_object` when a provider rejects the schema, so
> dim-name / 1-10-range drift is no longer a scoring failure.

---

## Common commands (`make`)

```
make up          # start dev stack (postgres + backend + frontend)
make logs        # tail all service logs
make shell       # exec bash in the backend container
make psql        # interactive psql helper (tools profile)
make migrate     # apply yoyo migrations
make rollback    # roll back last yoyo migration
make new-migration name=<name>
make lint        # ruff (backend) + biome (frontend)
make test        # backend pytest suite (self-migrates vs Postgres)
make test-llm    # end-to-end LLM smoke test (single turn) — needs a live model + running stack
scripts/llm-smoke.sh         # the same smoke, callable directly (optional BASE_URL arg)
make build / buildcache / down / clean  (dev)
make prod-build / prod-up / prod-logs / prod-down  (prod-style)
```

---

## Testing

- **Backend** (pytest): `make test`. Integration tests hit a real Postgres, self-migrate via yoyo,
  and force LLM STUB_MODE (model-free). Tests cover auth (JWT/JWKS negative cases), interview
  lifecycle, owner-scoping, LLM streaming/extraction, and M10 billing (quotas + PayMongo webhook status map).
- **Frontend**: `npm run typecheck`, `npm run build`, `npx biome check .` (in the frontend container).
- **LLM smoke**: `make test-llm` (`scripts/llm-smoke.sh`) — the ONE check that runs against a live
  provider instead of a monkeypatched one, so it is what catches a rejected `response_format` payload,
  a model drifting dim names, or unparseable feedback JSON.

CI (`.github/workflows/ci-pipeline.yml`) runs backend (ruff + format + pytest vs Postgres service) and
frontend (biome + typecheck + build + audit). The backend job runs a **Trivy 0.74 filesystem scan**
against its per-service `.trivyignore.yaml` dated-ignore policy (`--ignore-unfixed`, HIGH/CRITICAL gate,
exceptions expire 2026-12-01). The frontend relies on the CD image scan (below), not a source-tree scan,
as it ships only a static bundle. CD (`.github/workflows/cd-pipeline.yml`) runs on successful CI on `main`: it
builds both prod images, **Trivy-image-scans** them, smoke-tests, and **pushes to GHCR** (`maxterview_backend`/
`maxterview_frontend`), then a second job bumps the pinned tags in the `gitops` repo (see Deployment).
**Renovate** (renovate.json, GitHub-hosted app) opens weekly grouped PRs for frontend npm, backend
uv/pep621, Docker base images (digest-pinned), and GitHub Actions refs. Dependabot _alerts_ stay on;
Native Dependabot update-stream is disabled.

---

## Deployment (k3s + GitOps)

The production target is a **k3s cluster managed by GitOps** in the separate
[`gitops` repo](https://github.com/notseekeru/gitops) (Argo CD App-of-Apps, Terraform-installed).
This repo is the **app source**; the gitops repo holds the Kubernetes manifests.

**How an app ships here (per the gitops repo's existing `portfolio` / `diagram` convention):**

1. **Build & push images** to GHCR as immutable SHAs — `ghcr.io/notseekeru/maxterview_backend` and
   `ghcr.io/notseekeru/maxterview_frontend`. CD does this on green CI to `main`; a second job
   (`update-gitops-repo`, key `MAXTERVIEW_SSH`) then runs `kustomize edit set image` and pushes the SHA
   bump to `notseekeru/gitops`, which ArgoCD reconciles.
2. **Manifests** live in the gitops repo, not here: `apps/maxterview/` (backend + frontend Deployments and
   Services, `imagePullSecrets: [ghcr-login]`), `apps-of-apps/maxterview.yaml`, and
   `infra/maxterview-ingress.yaml` (host `maxterview.seekeru.tech`, `/api` → `maxterview-prod-backend:8000`,
   `/` → `maxterview-prod-frontend:8080`). The `/api` prefix is served by the **app** (`API_PREFIX` in
   `backend/src/app/__init__.py`): no proxy or ingress rewrite strips it.
3. **Secrets — still to do**: `maxterview-secrets` must be **added to `~/terraform` (`infra/k3s/main.tf`)** — it
   cannot copy `diagram_secrets`, because that secret _derives_ `database_url` from `var.POSTGRES_PASSWORD` and
   points at the in-cluster Postgres (`postgres.database.svc.cluster.local`). An external Neon DSN is not
   derivable, so it needs:
   - a new `var.NEON_DATABASE_URL` (sensitive) in `infra/k3s/variables.tf`, value set in **Infisical**
     (never `secrets.tfvars`),
   - a new `kubernetes_secret.maxterview_secrets` alongside `diagram_secrets`, carrying `DATABASE_URL`
     (plus Clerk/LLM/PayMongo keys) with **UPPERCASE keys named exactly as the env vars the app reads** —
     the Deployment injects the whole secret via `envFrom`, so `DATABASE_URL`, `CLERK_JWKS_URL`,
     `LLM_API_KEY`, `PAYMONGO_WEBHOOK_SECRET`, … A malformed key name blocks the pod (`envFrom` is all-or-nothing).
   - that secret added to `kubectl_manifest.gitops_app`'s `depends_on` list, so the root App still applies
     only after its secrets exist.
     Never `kubectl apply` secrets and never commit them; Terraform owns them.

   The in-cluster Postgres and its `postgres-credentials` secret stay as they are — they serve `diagram`.
   maxterview does not consume them, so the `docs/incident-2026-09-03` rotation runbook does not apply:
   Neon owns the role, so rotation is an Infisical change + re-apply, with no `ALTER USER` step.

### Where a value lives

One map, so nobody re-derives it (the word "dev" alone means five different things in this stack —
the secret store, the local stack, `APP_ENV`, the Clerk dev instance, and the `dev` billing tier):

| Value                                                                      | Home                                                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Deployed runtime config (`DATABASE_URL`, `CLERK_*`, `LLM_*`, `PAYMONGO_*`) | Infisical env **`prod`** (renamed from `dev` 2026-09-12) → Terraform → k8s Secret `maxterview-secrets` → `envFrom` |
| Local dev runtime + dev Clerk/LLM/PayMongo keys                            | `backend/.env` (git-ignored) — prod and dev values are _supposed_ to differ                                        |
| SPA build config (`VITE_CLERK_PUBLISHABLE_KEY`)                            | committed `frontend/.env.production` — public by design (D14)                                                      |
| CI plumbing (gitops deploy key)                                            | GitHub Actions secret `MAXTERVIEW_SSH`                                                                             |
| The Neon MCP's API key                                                     | root `.env` (direnv-exported; the app never reads it)                                                              |
| Deployed objects                                                           | namespace **`maxterview`** (own namespace; diagram/portfolio still share `default`)                                |

**Promotion is continuous:** every green `main` builds → Trivy-scans → smoke-tests → CD's
`update-gitops-repo` job bumps the pinned tag in `gitops` → Argo syncs, and the PreSync Job applies
migrations before the pods roll. No manual promotion step; CI is the gate.

**Database:** production runs against **Neon** (managed Postgres), not a DB pod in the cluster. There is no
PVC, no StatefulSet, and no DB backup/upgrade work in-cluster.

- `DATABASE_URL` comes from the `maxterview-secrets` Secret — use Neon's **direct** host
  (`ep-<id>.c-<cell>.<region>.aws.neon.tech`, e.g. `ep-tiny-hall-b3e0wb3g.c-4.ap-southeast-1.aws.neon.tech`) with `?sslmode=require`, **not** the `-pooler` host.
- The direct host needs zero code changes: the backend is one long-running pod holding ~10 pooled
  connections. Neon's pooler only matters when many short-lived instances share a DB (serverless) —
  and `app/db.py` already auto-detects a `-pooler` DSN (`statement_cache_size=0`) if you ever switch.
- Migrations on deployed envs run from the **in-cluster Job** with `MIGRATE_DATABASE_URL` (D12, PLAN §8 M17), not from a laptop; `make migrate` stays the dev path against the container. **Prod `public` schema is empty today**: the project exists (2026-09-12) but `0001–0007` are unapplied.
- **Tradeoffs:** public-internet round trips (measure latency from wherever the app runs), and the project runs
  `suspend_timeout_seconds: 0` = scale-to-zero **off** (no cold start, but ≈182 CU-h/month idle vs the 100 CU-h
  free budget — set 300 s before deploy, M17); the free history window is 6 h, so snapshot before each prod
  migration. In exchange you get durability, backups, and disposable branches for testing.
- **Identity is prod-grade, payments are not:** the backend verifies against the Clerk **production** instance (`clerk.seekeru.tech`, JWKS live) and the SPA's committed `pk_live_` (`frontend/.env.production`, public by design — D14) names the same instance. PayMongo is **test-mode** (live keys need a Fully Verified account; Subscriptions + Card Vaulting are enabled by support, not self-service), and every deployed value comes from one Infisical environment (`dev`, `SECRETS_PATH=/consumers/terraform`). Pre-launch swaps: PayMongo live keys + endpoint secret (PLAN §7, `MONETIZATION.md` §3).
- Local dev and CI keep the Postgres container / service; only the deployed DSNs change, and prod/staging are
  **separate Neon projects** (D11) — branches are disposable-only, inside staging. (`NEON_API_KEY`
  for the MCP server also lives in root `.env`, which compose injects into the backend container — the app
  never reads it, and it is separate from `DATABASE_URL`.)

### Driving Neon from an agent (MCP)

`.mcp.json` wires Neon's hosted MCP server so a coding agent can inspect/modify Neon directly — no
dashboard, no `neonctl`. This requires the `pi-mcp-adapter` extension (pi core has no MCP of its own).

```bash
# .env (git-ignored — exported into the shell by direnv via .envrc)
NEON_API_KEY=np_...
```

The adapter reads the key **from `.env` at connect time**, not from `process.env`, so writing or rotating
the key needs no restart of the shell or of pi — just `/mcp reconnect neon`. It must be launched with
cwd = repo root (the path is relative), and `.envrc`/direnv still feeds the _rest_ of the toolchain.

`NEON_API_KEY` is an **API-scoped** key and is _not_ `DATABASE_URL` (that is the separate DSN secret,
§Deployment). Two device-level facts worth knowing:

- **Auth is bearer, not OAuth.** The adapter keeps OAuth tokens in the OS credential store and fails
  closed rather than writing them in plaintext. Headless Linux here has no Secret Service/keyring, so
  OAuth cannot complete; the `!command` secret (`bearerToken` runs a shell command, stdout = token)
  sidesteps this entirely. `bearerTokenEnv` is the equivalent when the key is already exported.
- **The key is per-device, the config is per-repo.** `.mcp.json` is committed and holds only the _command
  that reads_ `.env`; each machine supplies its own `.env`. A file on one host does not reach another.
- **`.env` is `env_file`-loaded into the backend container**, so the key is injected there too. Harmless
  in practice (that container already holds `DATABASE_URL`, i.e. direct prod DB access) but the app never
  reads it — it exists only for the MCP adapter.

`approveTools` gates destructive calls (`*delete*`, `*drop*`, `*reset*`, `*truncate*`) behind an
interactive confirmation; reads run ungated. **This key can mutate the production database** — the free
basic key is account-wide, so there is no branch-level protection between the agent and prod data.

**Ports/roles:** backend serves `:8000` (FastAPI), frontend serves `:8080` (nginx, static SPA). Ingress routes
`/api` → `backend` and `/` → `frontend` (two paths, exactly as `diagram` does); the frontend's `nginx.conf`
`/api` proxy is a same-origin dev convenience, not the prod path. Because maxterview's backend **has a real
`/api/health` route**, its pods take `httpGet` probes rather than `diagram`'s `tcpSocket`.

> The GitOps half is **landed**: manifests + CD tag-bump job exist and CD pushes to `notseekeru/gitops`.
> The app does not schedule until `maxterview-secrets` exists — that is step 3 above (Terraform + Infisical),
> plus the first `MIGRATE_DATABASE_URL` migration (M17).

---

## Security & credentials

- `.env` files are git-ignored; only `.env.example` is committed.
- Never commit secrets. Backend refuses to boot in prod with `CLERK_ENABLED=false`.
- Clerk publishable keys are public; secret keys are admin-only (never in client code).
- `NEON_API_KEY` (MCP, see "Driving Neon from an agent") lives only in git-ignored `.env` — `.mcp.json`
  commits the command that reads it, never a value.
- **BYOK keys** (owner-supplied provider keys, `BYOK.md`) are Fernet-encrypted at rest under
  `BYOK_ENCRYPTION_KEY` and never returned by the API — only the key's last 4 characters are
  readable, for "which key is this?" in the settings panel.

---

## Status

- **M1–M9 done** (infra, backend, auth, API, LLM layer, tests, frontend app, verify + README).
- **M10** (billing/monetization) — **shipped**: daily-global chat-turn quotas (free 10 / premium 250 / dev 500 per owner, UTC-day reset; no per-interview cap) + `GET /api/usage` + PayMongo subscribe/cancel/webhook (Maya first payment; Stripe replaced 2026-09-12); no daily-interview cap; **`dev` tier wired 2026-08-25**; frontend tier labels + upsell/lockout notices + a dedicated **billing/plan page** (`/app/settings/billing`); **Postgres-proof 2026-09-12** (simulate endpoint → webhook → `premium/active` row with tz-aware period; `past_due`/`cancelled` downgrade; unsigned delivery 400). Sandbox transaction still owed — see `MONETIZATION.md` §3/§5.
- **M11** (security) — docs-first done (threat model + accepted risks + pentest plan in PLAN §7) + Trivy/Renovate; **code pass shipped 2026-09-12**: per-client limiter (`RATE_LIMIT`, `/health` + `/billing/webhook` exempt), `CORS_ALLOW_ORIGINS` allow-list (off by default), prompt-injection guardrails + a 4000-char turn cap. Open: deployed pentest, `CLERK_AUDIENCE`.
- **BYOK** (per-owner provider keys) — **shipped 2026-09-13**: `/app/settings/system` card → `GET/PUT/DELETE /api/settings/llm` + `/test`; Fernet-encrypted `llm_credentials` row per owner; one OpenAI-compatible target for interviewer + grader + formatter; BYOK turns bypass the daily chat-turn cap (`byok` on `/usage`); contract + threat notes in `BYOK.md`.
- **M12** (frontend polish) — **done (2026-08-24)**: public landing page, `/app` dashboard with stats + score charts, empty states, skeleton loaders, mobile-responsive layout, code-split routes (`/`, `/app`, `/interviews/:id`).
- **M13** (observability) — docs-first done (`OBSERVABILITY.md`); structlog + Grafana Cloud (Loki for logs, **pure OTLP** metrics/traces → Prometheus) wiring pending.
- **M14** (OKF / structured-output hardening) — **OKF not started**: no bundle exists, the interviewer's knowledge is still prompt strings. Its structured-output _prerequisite_ shipped (2026-09-11): `response_format=json_schema` + greedy decoding on the grader→formatter surface. OKF bundles are the markdown+frontmatter format M15 RAG will ingest.
- **M15** (RAG / retrieval-augmented interviewing) — future enhancement, not started (`PLAN.md`).
- **M16** (live voice interview — TTS + STT + webcam illusion) — future enhancement, not started (`PLAN.md`).
- **M17** (Neon environments & dedicated DB) — **decided 2026-09-12 (D11/D12), contract only, nothing provisioned**: prod/staging = separate Neon projects, branches disposable-only, app vs migrator DSN (`MIGRATE_DATABASE_URL` reserved), migrations via the in-cluster PreSync Job; prod `public` schema still empty. **First-deploy open items:** push `maxterview_website` (CD bakes the SPA key + bumps the gitops tag off the pre-`/api` image), `make plan/apply MOD=k3s ENV=prod` (creates the `maxterview` namespace + `maxterview-secrets` + the `maxterview.seekeru.tech` tunnel hostname; needs a kubeconfig), a Clerk allowed-origin check for the app host, a Stripe dashboard endpoint, and Neon quota (no suspend on free). Migrations now run via the PreSync Job in `gitops` (`9f46bd3`); the namespace + secret land from `terraform` (`6727cf8`).
- **M18** (load & performance testing) — docs-first, not built: staging-only k6 profiles, off-node generator, **STUB_MODE** for app capacity vs a real-model canary for provider capacity; single-VU runs measure the rate limiter (2 rps/client IP), so the unit is _concurrent open chats_. Needs M13 + staging (D13).
