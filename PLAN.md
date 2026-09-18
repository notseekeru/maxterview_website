# PLAN — decisions & open milestones

The stable contract: read at session start. As-built (architecture, endpoints, commands) lives in
`README.md`; topology in `DIAGRAM.md`; billing in `MONETIZATION.md`; BYOK in `BYOK.md`; ops in
`OBSERVABILITY.md`.

**Change policy:** edit only when a decision, milestone, or guardrail changes. When a milestone
ships, delete the section that predicted it — don't add a "shipped" note beside it.

## Decisions (still-binding only)

| # | Decision | Why |
| --- | --- | --- |
| D2 | Clerk fallback (`CLERK_ENABLED=false`) only when `APP_ENV` is `development`/`test`; else refuse to boot | No silent unauthenticated prod; tests boot without Clerk |
| D3 | yoyo migrations: the whole `.sql` is the **up** step, rollback is a separate `<name>.rollback.sql` | yoyo has no in-file `-- migrate:up/down` markers — an in-file down block executes as **up** (it created-then-dropped tables once) |
| D4 | Domain is the Clerk `sub`; every query is owner-scoped | Auth is load-bearing |
| D5 | `DATABASE_URL` is derived, never literal: dev composes it from `POSTGRES_*`, prod injects an external secret | Prod DB is external (Neon), so it cannot be composed; nothing committed |
| D7 | LLM = one OpenAI-compatible client via env; one self-hosted qwen for dev and prod; stub for tests | One interface, no vendor lock |
| D10 | Two-tier entitlement (free/premium + developer), shipped as a one-time period top-up; provider-managed recurring implemented but dormant. Spec: `MONETIZATION.md`. Provider seam = `app/payments.py` + the `subscriptions.provider*` columns | Retrofit gating later is costly; that seam is the whole provider-specific surface |
| D11 | Durable envs = **separate Neon projects**; branches are disposable-only (PR/preview, migration rehearsal) and live inside the staging project, never prod. Dev + CI keep the local container Postgres | Free-plan quotas are **per project** — sharing one lets busy staging starve prod's compute. Dev stays local: hermetic, offline, no CU burn |
| D12 | DDL runs as a **separate credential**: a PreSync Job in the target namespace with `MIGRATE_DATABASE_URL`; the app runs a DML-only role via `DATABASE_URL`. Unset `MIGRATE_DATABASE_URL` falls back to `DATABASE_URL` | A leaked app DSN must not `DROP`. **Split decided, not implemented** — the Job currently migrates as the owner DSN |
| D13 | One cluster, two namespaces rendered from kustomize base + overlays. Promotion is **continuous deployment**: every green `main` bumps the pinned tag; nothing is hand-promoted. Staging buys migration rehearsal and a safe load-test target, not a gate | At solo scale a promo stage, canary analysis and multi-cluster buy nothing; the CI gate is the gate |
| D14 | The SPA's Clerk publishable key is a **committed build default** in `frontend/.env.production` (`ARG VITE_MODE` selects prod vs staging); staging images tag `staging-<sha>`, never `latest` | Vite inlines `VITE_*` at build time, so it can never come from a cluster Secret. A `pk_` is public (it ships inside `dist/assets/*.js`) and leaks nothing. Rejected: repo variable, Infisical machine identity (+1 credential for a public constant), nginx `config.js` injection (9 files for a payoff that needs *many* envs) |
| D15 | The marketing page stays in the SPA: no prerender, no SSR, no framework migration. Crawler basics ship in the shell (static head, real `<a href>` CTAs, real 404, `noindex` on gated routes) | A framework closes the ~1-page prerender gap, writes no content, and costs a Node runtime or a route-tree rewrite. **Accepted:** a non-JS fetcher reads the head but not the landing copy. Content pages, when they land, ship as static HTML in `frontend/public/` |

## Guardrails

- **Config:** prod Secrets are created by Terraform from Infisical and consumed with `envFrom`, so **secret keys ARE the env-var names** (uppercase) — a lowercase key is a var the app never reads, and one malformed key blocks the pod. Never `kubectl apply` a secret, never commit one. Rotation = Infisical change + re-apply + rollout restart.
- **`CORSMiddleware` is off unless `CORS_ALLOW_ORIGINS` lists exact origins** — the SPA is same-origin through the `/api` proxy.
- **Rate budget is per client, so load-time reads must stay bounded.** A view that fans out one read per row spends that client's whole minute on one page load (the dashboard used to; it is now one list + one aggregate). `GET /interviews` is the remaining unbounded read (all-time, no pagination).
- **LLM prompt injection:** the system prompt marks the candidate's role/topic and their turns as data (`llm.INJECTION_GUARD`), the grader prompt marks the transcript untrusted, turns are capped at 4000 chars, and the model gets no tools. Residual risk accepted for a non-agent model.
- **Logs never carry secrets or message bodies** — lengths, ids and content-free `shape=` fingerprints instead.

**Open before broad public traffic:** `aud` claim validation; the D12 migrator-role split; `uv pip audit`/`npm audit` non-informational; a manual pentest (authz/IDOR/JWT/input/rate-limit/prompt-injection/secret leak).

## Open milestones

| # | Milestone | Status |
| --- | --- | --- |
| 13 | **Observability** — see `OBSERVABILITY.md` | [~] structlog calls landed; `configure()` + Grafana Cloud unwired |
| 14 | **OKF / structured-output hardening** — author the interviewer's knowledge as OKF bundles (markdown + YAML frontmatter) | [ ] not started; the `json_schema` half shipped. M15 ingests these bundles |
| 15 | **RAG** — embeddings + vector retrieval (pgvector) over role/question-bank content, framed after M14 | [ ] future, not MVP |
| 16 | **Live voice interview** — TTS speaks the questions, STT transcribes the answers, optional webcam illusion; the text transcript stays the source of truth | [ ] future, not MVP |
| 17 | **Environments** — Neon projects + namespaces live; both envs' migrations applied by their own PreSync Job | [ ] open: one real ₱499 payment proof, and the D12 migrator-role split. Neon quota is not a risk (2,932 CPU-s of 100 CU-h; scale-to-zero is on) |
| 18 | **Load testing** — k6 on **staging only**, generator off-node, `LLM_BASE_URL` empty (STUB_MODE) to measure app capacity vs a real-model canary for provider capacity; report two ceilings separately. Walls to measure, not discover: ingress 30 rps/burst 20 per IP, app `RATE_LIMIT=120/min` per client IP, asyncpg pool ~10, `replicas: 1`. Check Neon CU-hours before/after | [ ] docs-first; needs M13 for actionable numbers, since `kubectl top` is unavailable (no metrics-server) |
