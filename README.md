# maxterview

[![License](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)
[![CI](https://github.com/notseekeru/maxterview_website/actions/workflows/ci-pipeline.yml/badge.svg)](https://github.com/notseekeru/maxterview_website/actions/workflows/ci-pipeline.yml)
[![CD](https://github.com/notseekeru/maxterview_website/actions/workflows/cd-pipeline.yml/badge.svg)](https://github.com/notseekeru/maxterview_website/actions/workflows/cd-pipeline.yml)

**AI mock-interview coach** — practice interviews with an LLM that asks questions, annotates every
answer like a chess engine would (brilliant → blunder), and scores the run: accuracy, letter grade,
hire/reject call, tips.

Stack: **FastAPI** (backend) + **React + TypeScript + Vite** (SPA) + **PostgreSQL 18**, run with
Docker Compose. Frontend: Tailwind 4 + shadcn/ui + react-router.
NvidiaNim, Neon Postgres, Cloudflare Workers AI, PayMongo,Grafana Cloud + Loki + Tempo

Docs:

- `PLAN.md` — binding decisions and open milestones
- `MONETIZATION.md` — billing spec (quotas + PayMongo period top-up, shipped)
- `docs/interview-structure.md` — the interview's phases and the research behind each one
- `BYOK.md` — per-owner LLM provider keys (settings panel → `/settings/system`)
- `OBSERVABILITY.md` — what telemetry ships, and what is deliberately parked
- `VOICE.md` — voice: Cloudflare free tier, one engine, TTS + STT shipped and live in prod

---

## Architecture

```
Browser (React SPA) ── /api ──► nginx/Vite proxy ──► FastAPI ──► PostgreSQL 18
                                (path passthrough)   │
                                                     └──► LLM (OpenAI-compatible)
```

- **Backend** (`backend/`): FastAPI in `app/main.py`, raw SQL via asyncpg (`app/db.py`),
  manual Clerk JWT/JWKS verification (`app/auth.py`), OpenAI-compatible LLM client (`app/llm.py`).
  Migrations via **yoyo** (`backend/migrations/*.sql`).
- **Frontend** (`frontend/`): React 19 + Vite 8 + TypeScript 7. Consumes the SSE `chat/stream`
  endpoint with native fetch streaming.

### The interview loop

```
create → start → chat/stream (SSE) → … → complete → feedback
```

Every query is scoped to the owner (`ClerkUser.sub`, or dev `DEV_USER`). All paths carry the `/api`
prefix, which the **app** owns (`API_PREFIX`) — no proxy or ingress rewrite strips it.

`complete` auto-generates feedback and refuses with `409` if no turn was ever sent — an empty
transcript is unscorable, so completion fails instead of dead-ending a completed interview with no
score.

---

## Quickstart (dev)

Requires Docker + Docker Compose v2. Copy the example env and (optionally) fill in real values:

```bash
cp .env.example .env                  # compose/infra only: APP_ENV, POSTGRES_*, ports
cp backend/.env.example backend/.env  # backend runtime: CLERK, LLM, quotas, PAYMONGO
cp frontend/.env.example frontend/.env # VITE_* frontend vars
make env-sync-dev           # pulls the credentials into .env + backend/.env (needs `infisical login` once)
make up                     # builds + starts postgres, backend, frontend   (dev only — prod uses Neon)
```

- Backend API: http://localhost:8000/api (`/api/health`)
- Frontend UI: http://localhost:5173

### What to initialize to use each feature

Everything below reads git-ignored env in `backend/.env` (backend) or `frontend/.env` (frontend); you
only need the vars for the features you actually use. Check which are set (names only) with
`./.pi/skills/paymongo-operator/scripts/need-keys.sh`.

| Want this feature                          | Set in `backend/.env`                                               | plus                                                   | how to run/verify                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| UI/API with no auth at all (fast dev)      | _(nothing)_                                                         | —                                                      | default works (`CLERK_ENABLED=false` → `DEV_USER`)                                                                                     |
| Real Clerk sign-in + JWT auth              | `CLERK_ENABLED=true`, `CLERK_DOMAIN`, `CLERK_JWKS_URL`              | `frontend/.env` `VITE_CLERK_PUBLISHABLE_KEY=pk_test_…` | `make up`, visit `/sign-in`                                                                                                            |
| Headless Clerk ops (mint users/sessions)   | `CLERK_SECRET_KEY=sk_test_…`                                        | —                                                      | `docker exec -e CLERK_SECRET_KEY="$CLERK_SECRET_KEY" maxterview_frontend_dev sh -c 'cd /tmp && npx clerk api users'`                   |
| PayMongo ₱99 → premium row (30 days)       | `PAYMONGO_SECRET_KEY` (`sk_test_…`), `PAYMONGO_WEBHOOK_SECRET`      | —                                                      | upgrade in the UI → QR Ph code, scanned in any wallet/bank app; dev instead: POST `/api/billing/webhook/simulate` (no tunnel, no keys) |
| Real AI interviewer chat + auto-feedback   | `LLM_BASE_URL`, `LLM_MODEL`, `LLM_PRO_MODEL`, `LLM_API_KEY`         | —                                                      | empty → deterministic STUB (model-free tests/dev)                                                                                      |
| BYOK (own provider key)                    | `BYOK_ENCRYPTION_KEY`                                               | —                                                      | `BYOK.md`                                                                                                                              |
| Observability (logs, metrics, traces)      | `OTEL_EXPORTER_OTLP_ENDPOINT` (empty = logs only, no SDK)           | prod: Loki + Tempo + Prometheus, wired in gitops       | `make logs` in dev; prod is `OBSERVABILITY.md`                                                                                         |
| Voice: interviewer speaks, answers dictate | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (Workers AI - Read) | —                                                      | `VOICE.md`. Empty → the chat surface disables both controls and says why instead of failing on click                                   |
| Resume review + LaTeX preview              | _(nothing)_                                                         | —                                                      | pdflatex ships in `backend/Dockerfile`; a `\documentclass` resume renders a live PDF with the audit's weak and strong lines marked, and Open hands it to the browser viewer for zoom and search. Anything else is plain text, one Convert to LaTeX click away. Tunable with `LATEX_*` |

Feature env values come from your Clerk app's **Development instance** (`.clerk.accounts.dev` /
`pk_test_` / `sk_test_`) and PayMongo **test mode** — both safe on `localhost`. Live keys are locked
to `seekeru.tech` and are rejected elsewhere. `BILLING_MODE=subscription` additionally needs
`PAYMONGO_PLAN_ID` and a support-enabled account (`MONETIZATION.md` §4).

---

## Testing

CI (`.github/workflows/ci-pipeline.yml`) runs backend (ruff + format + pytest vs Postgres service)
and frontend (biome + typecheck + build + audit), plus a **Trivy 0.74 filesystem scan** of the backend
(`backend/.trivyignore.yaml` dated-ignore policy, `--ignore-unfixed`, HIGH/CRITICAL gate, no open
exceptions).
The frontend relies on the CD image scan instead, as it ships only a static bundle. CD runs on
successful CI on `main`: build both prod images → Trivy-image-scan → smoke-test → push to GHCR →
bump the pinned tags in the `gitops` repo. **Renovate** opens weekly grouped PRs for frontend npm,
backend uv/pep621, Docker base images (digest-pinned) and GitHub Actions refs.

---

## Deployment

Production is a **k3s cluster managed by GitOps** in the separate
[`gitops` repo](https://github.com/notseekeru/gitops). This repo is the app source; the gitops repo
holds the manifests (`apps/maxterview/{base,overlays/prod}`) and Argo reconciles them.

Operator notes:

- **Secrets** (`~/terraform` `infra/k3s`) come from Infisical and are consumed via `envFrom`, so
  **the secret keys ARE the app's env-var names** (uppercase). Never `kubectl apply` a secret, never
  commit one; rotation is an Infisical change + `make apply` + a rollout restart. Live-mode
  `PAYMONGO_*` and the `payment.paid` webhook secret are applied — a signed live-format delivery
  answers `200 ok`, an unsigned one `400`. First real ₱99 QR Ph payment: 2026-09-27 (MONETIZATION §4).
- **Database:** Neon, **direct host** (not `-pooler`) with `?sslmode=require`. The direct host needs
  no code change — the backend is one long-running pod holding ~10 pooled connections; Neon's pooler
  only matters when many short-lived instances share a DB, and `app/db.py` auto-detects a `-pooler`
  DSN (`statement_cache_size=0`) anyway.
  **snapshot before each prod migration**.
- **Migrations on deployed envs** run from the in-cluster Job, not a laptop; `make migrate` is the dev
  path against the container.

---

## Status

Open milestones and their current state: **`PLAN.md`**.
