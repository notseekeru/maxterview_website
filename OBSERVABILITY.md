# OBSERVABILITY — maxterview

Observability plan for the MVP. **Docs-first milestone (M13)**: this file captures the design and
current state; implementation follows in a later code pass. Companion to `PLAN.md`, `SECURITY.md`,
and `README.md`.

---

## Current state (verified 2026-08-23)

| Area | Status |
|---|---|
| Structured logging | ⚠️ **none wired** — `structlog` is a declared dependency (`pyproject.toml`) but **imported nowhere**; the app uses default/unstructured logging |
| Request logging | ⚠️ FastAPI default access logs only; no JSON, no per-request context |
| Error tracking / APM | ❌ none (no Sentry) |
| Metrics | ❌ none (no Prometheus metrics endpoint) |
| Log aggregation / dashboards | ❌ none (no Loki/Grafana) |
| Health/readiness | ✅ `/health` (liveness only; no readiness/deep-health) |

**Conclusion:** observability is effectively absent. Everything below is a documented plan.

---

## Design (3 layers)

### 1. Logging — foundation (structlog)

Use the already-declared `structlog` dependency. Output shape:
- **Production:** JSON (`structlog.processors.JSONRenderer`) — machine-parseable for Loki/cloud ingestion.
- **Development:** human-readable colored key/value output.

Wiring intent (future code pass):
- Configure `structlog` once at app startup (bind `app` name, env, request id).
- Add a FastAPI middleware/`logging` integration so every request emits one structured access log:
  `method`, `path`, `status`, `duration_ms`, `user` (`sub`), `interview_id` where present.
- Log LLM calls (model, tokens, latency) and feedback generation at info/debug.
- **Never log secrets:** no `DATABASE_URL`, `LLM_API_KEY`, Clerk tokens, or message bodies that could
  contain them. Log user message **lengths/ids**, not content, at debug-only if at all.

### 2. Error tracking / APM — first layer (Sentry, do now)

Sentry is the highest-leverage first addition for a FastAPI + React stack:
- **Backend:** `sentry-sdk[fastapi]` captures unhandled exceptions with request context; links the
  mystery 500s (e.g. the earlier llama.cpp feedback 500) to code.
- **Frontend:** Sentry React SDK + an error boundary capture client-side exceptions; source maps for
  readable stack traces.
- **DSN:** supplied via env (`SENTRY_DSN`), surfaced in prod via a k8s secret → env (Terraform/Infisical
  pattern, same as `maxterview-secrets`). **Not committed.**
- Sign up: sentry.io free tier is sufficient for a personal deployment.

### 3. Metrics + log aggregation — later layer (Grafana Cloud)

Once there is traffic to measure, add **Grafana Cloud**:
- **Loki** ingests the JSON structlog output (agent/promtail or OTel collector in the cluster).
- **Prometheus + Grafana** for request rate / latency / error-rate dashboards over time (SLOs/trends).
- Leverage the same `duration_ms`/`status`/`user` fields logged in layer 1.
- Scope this later — dashboards only matter with a real user base; not needed to debug the MVP.

---

## Recommended rollout order

1. **Layer 1 first** — structlog JSON logging (foundation; cheap, unblocks everything).
2. **Layer 2** — Sentry (error tracking) for backend + React.
3. **Layer 3** — Grafana Cloud (Loki + Prometheus + Grafana) after real traffic.

```mermaid
structlog JSON logs ──► (Sentry: errors/APM now)
      │
      └──► (Grafana Cloud: Loki + Prometheus + Grafana, later)
```

---

## Acceptance criteria (when implemented)

- [ ] Production logs are JSON; dev logs are human-readable.
- [ ] Every API request emits a structured access log (method/path/status/duration/user).
- [ ] No secrets appear in logs.
- [ ] Sentry captures backend exceptions + frontend errors with source maps; `SENTRY_DSN` from env.
- [ ] (Later) Loki stores logs and Grafana shows request/error dashboards.
