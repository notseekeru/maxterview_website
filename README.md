# maxterview

**AI mock-interview coach** — practice interviews with an LLM that asks questions, gives
per-question and end-of-interview feedback, and scores your performance. **MVP is text-based.**

Stack: **FastAPI** (backend) + **React + TypeScript + Vite** frontend (SPA) + **PostgreSQL 17**,
run with Docker Compose. Frontend: Tailwind 4 + shadcn/ui + react-router.

Docs:

- `PLAN.md` — technical decisions (D1–D10) and milestones (M1–M15)
- `MONETIZATION.md` — billing spec (quotas + raw Stripe + billing plan page shipped; real payment test done 2026-09-06; live-Clerk premium view open)
- `OBSERVABILITY.md` — logging/error-tracking/metrics plan (doc-first M13)

---

## Architecture

```
Browser (React SPA) ── /api ──► nginx/Vite proxy ──► FastAPI ──► PostgreSQL 17
                                      (strips /api)      │
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

- `POST /interviews` (create, role required) → `pending`
- `POST /interviews/{id}/start` → `in_progress`
- `POST /interviews/{id}/chat/stream` — **SSE**: user answer in, assistant reply streamed out
  (`event: message` / `done` / `error`). Persists both turns.
- `POST /interviews/{id}/complete` → `completed` + auto-generated feedback
- `GET /interviews/{id}/feedback` → scores / verdict / tips
- Every query is scoped to the owner (`ClerkUser.sub` / dev `DEV_USER`).

---

## Quickstart (dev)

Requires Docker + Docker Compose v2. Copy the example env and (optionally) fill in real values:

```bash
cp .env.example .env                  # compose/infra only: APP_ENV, POSTGRES_*, ports
cp backend/.env.example backend/.env  # backend runtime: CLERK, LLM, quotas, STRIPE
cp frontend/.env.example frontend/.env # VITE_* frontend vars
make up                     # builds + starts postgres, backend, frontend
```

- Backend API: http://localhost:8000 (`/health`)
- Frontend UI: http://localhost:5173

Then open the frontend, create an interview (role + optional topic), answer the AI's questions,
and click **Complete** to see feedback.

### What to initialize to use each feature

Everything below reads git-ignored env in `backend/.env` (backend) or `frontend/.env` (frontend).
`cp *.env.example *.env` first; you only need to fill the vars for the features you actually use.
Run `need-keys.sh` to see which are set (names only):

```bash
./.pi/skills/clerk-stripe-operator/scripts/need-keys.sh   # set/missing/live, never values
```

| Want this feature                                               | Set in `backend/.env`                                                                     | plus                                                   | how to run/verify                                                                                                    |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| UI/API with no auth at all (fast dev)                           | _(nothing)_                                                                               | —                                                      | default works (`CLERK_ENABLED=false` → `DEV_USER`)                                                                   |
| Real Clerk sign-in button + JWT auth                            | `CLERK_ENABLED=true`, `CLERK_DOMAIN`, `CLERK_JWKS_URL`                                    | `frontend/.env` `VITE_CLERK_PUBLISHABLE_KEY=pk_test_…` | `make up`, visit `/app`, sign in                                                                                     |
| Headless Clerk ops (mint users/sessions, drive the `clerk` CLI) | `CLERK_SECRET_KEY=sk_test_…`                                                              | —                                                      | `docker exec -e CLERK_SECRET_KEY="$CLERK_SECRET_KEY" maxterview_frontend_dev sh -c 'cd /tmp && npx clerk api users'` |
| Stripe $9.99 checkout → premium row                             | `STRIPE_SECRET_KEY` (`sk_test_…`), `STRIPE_WEBHOOK_SECRET` (`whsec_…`), `STRIPE_PRICE_ID` | —                                                      | host `stripe` CLI: `stripe listen --forward-to localhost:8000/billing/webhook`, then upgrade in UI                   |
| Real AI interviewer chat + auto-feedback                        | `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`                                                | —                                                      | empty → deterministic STUB (model-free tests/dev)                                                                    |
| Observability                                                   | _(nothing yet)_                                                                           | —                                                      | `OBSERVABILITY.md` (docs-first, not wired)                                                                           |

Feature env values come from your Clerk app's **Development instance** (`.clerk.accounts.dev` /
`pk_test_` / `sk_test_`) and Stripe **test mode** — both are safe to use on `localhost`. The
production `pk_live_…` / `sk_live_…` keys are locked to `seekeru.tech` and will be rejected
elsewhere.

> **You do NOT need** `clerk auth login`, `clerk link`, or a `CLERK_PLATFORM_API_KEY` to use any
> repo feature. Those Platform/admin tools manage apps/domains (a beta, dashboard-only capability)
> and add nothing here — the instance `CLERK_SECRET_KEY` (Backend API) plus the `stripe` CLI cover
> everything an operator needs. Avoid the dead-ends: NixOS can't run the npm-global `clerk` binary,
> and the container's OAuth loopback isn't reachable from a host browser.

---

> **Local llama.cpp caveat:** some llama.cpp builds return HTTP 500 to **non-streaming**
> `/chat/completions` when called via httpx, so auto-feedback can come back empty against a local
> llama.cpp (the streaming chat path is unaffected). Use a chat/OpenAI-compatible provider
> (e.g. DeepSeek) for structured feedback output. See `backend/.env.example`.

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
scripts/llm-smoke.sh         # single-turn LLM smoke
scripts/llm-smoke-full.sh    # full multi-turn lifecycle smoke
make build / buildcache / down / clean  (dev)
make prod-build / prod-up / prod-logs / prod-down  (prod-style)
```

---

## Testing

- **Backend** (pytest): `make test`. Integration tests hit a real Postgres, self-migrate via yoyo,
  and force LLM STUB_MODE (model-free). Tests cover auth (JWT/JWKS negative cases), interview
  lifecycle, owner-scoping, LLM streaming/extraction, and M10 billing (quotas + Stripe webhooks).
- **Frontend**: `npm run typecheck`, `npm run build`, `npx biome check .` (in the frontend container).
- **LLM smoke**: `scripts/llm-smoke-full.sh` walks the whole lifecycle against a live model.

CI (`.github/workflows/ci-pipeline.yml`) runs backend (ruff + format + pytest vs Postgres service) and
frontend (biome + typecheck + build + audit). The backend job runs a **Trivy 0.74 filesystem scan**
against its per-service `.trivyignore.yaml` dated-ignore policy (`--ignore-unfixed`, HIGH/CRITICAL gate,
exceptions expire 2026-12-01). The frontend relies on the CD image scan (below), not a source-tree scan,
as it ships only a static bundle. CD (`.github/workflows/cd-pipeline.yml`) runs on successful CI on `main`: it
builds both prod images, **Trivy-image-scans** them, smoke-tests, and **pushes to GHCR** (`maxterview_backend`/
`maxterview_frontend`). No GitOps repo is mutated here — deployment is adopted separately (see Deployment).
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
   `ghcr.io/notseekeru/maxterview_frontend`. The enabled CD pipeline does this automatically on green CI to `main`.
2. **Add the GitOps manifests** (in the gitops repo, not here):
   - `apps/maxterview/backend.yaml` + `frontend.yaml` + `kustomization.yaml` (Deployment + Service).
   - `apps-of-apps/maxterview.yaml` (child Application, `prune` + `selfHeal`).
   - `infra/maxterview-ingress.yaml` + a Cloudflare-tunnel DNS/route so a hostname reaches the cluster.
   - a deployment mechanism pins the immutable `:${SHA}` tag Argo CD reconciles against.
3. **Secrets** (`maxterview-secrets`, e.g. `DATABASE_URL`, `LLM_API_KEY`, Clerk keys) are created by the
   Terraform installer from Infisical — same as the existing `diagram-secrets`/`ghcr-login` pattern.

**Ports/roles:** backend serves `:8000` (FastAPI), frontend serves `:8080` (nginx, static SPA). The frontend's
`nginx.conf` proxies `/api` → `backend:8000` internally, so ingress can route `/` → frontend only (or
`/api` → backend directly, mirroring the `diagram` ingress). Unlike `diagram`'s backend, maxterview's
backend **has a `/health` route**, so its pods can use `httpGet` probes instead of `tcpSocket`.

> CD here is **enabled** and pushes images to GHCR, but until the gitops `apps/maxterview` manifests above
> exist nothing reconciles them onto the cluster. CI/CD + scanning (Trivy) are live; only the GitOps adoption
> half remains to be added in the `notseekeru/gitops` repo.

---

## Security & credentials

- `.env` files are git-ignored; only `.env.example` is committed.
- Never commit secrets. Backend refuses to boot in prod with `CLERK_ENABLED=false`.
- Clerk publishable keys are public; secret keys are admin-only (never in client code).

---

## Status

- **M1–M9 done** (infra, backend, auth, API, LLM layer, tests, frontend app, verify + README).
- **M10** (billing/monetization) — **shipped**: daily-global chat-turn quotas (free 10 / premium 250 / dev 500 per owner, UTC-day reset; no per-interview cap) + `GET /usage` + raw Stripe checkout/portal/webhook; no daily-interview cap; **`dev` tier wired 2026-08-25**; frontend tier labels + upsell/lockout notices + a dedicated **billing/plan page** (`/app/settings/billing`); **real payment test done 2026-09-06** (test-mode checkout → webhook → premium `subscriptions` row; fixed `_period_end` epoch→datetime 500). Open: live-Clerk (`CLERK_ENABLED=true`) to surface `premium` in `/usage` (`MONETIZATION.md`).
- **M11** (security) — docs-first phase done (threat model + accepted risks + pentest plan in PLAN §7); code hardening (rate limiter, CORS) pending.
- **M12** (frontend polish) — **done (2026-08-24)**: public landing page, `/app` dashboard with stats + score charts, empty states, skeleton loaders, mobile-responsive layout, code-split routes (`/`, `/app`, `/interviews/:id`).
- **M13** (observability) — docs-first done (`OBSERVABILITY.md`); structlog + Grafana Cloud (Loki for logs, **pure OTLP** metrics/traces → Prometheus) wiring pending.
- **M14** (RAG / retrieval-augmented interviewing) — future enhancement, not started (`PLAN.md`).
- **M15** (live voice interview — TTS + STT + webcam illusion) — future enhancement, not started (`PLAN.md`).
