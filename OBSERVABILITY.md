# OBSERVABILITY — maxterview

Observability plan for the MVP. **Docs-first milestone (M13)**: this file captures the design and
current state; implementation follows in a later code pass. Companion to `PLAN.md`, `SECURITY.md`,
and `README.md`.

> **Decided 2026-08-23:** Grafana-focused stack only (Loki + Prometheus + Grafana Cloud) — no Sentry.
> For a personal MVP the two overlap on error logging; a single Grafana vendor keeps one auth, one
> data plane, and leans on the structlog JSON logs we already plan. Sentry-style exception grouping
> can be revisited later if error triage at scale ever demands it — not now.

---

## Current state (verified 2026-08-23)

| Area | Status |
|---|---|
| Structured logging | ⚠️ **none wired** — `structlog` is a declared dependency (`pyproject.toml`) but **imported nowhere**; the app uses default/unstructured logging |
| Request logging | ⚠️ FastAPI default access logs only; no JSON, no per-request context |
| Error tracking / APM | ❌ none (no Sentry, no error-log queries) |
| Metrics | ❌ none (no Prometheus metrics endpoint) |
| Log aggregation / dashboards | ❌ none (no Loki/Grafana) |
| Health/readiness | ✅ `/health` (liveness only; no readiness/deep-health) |

**Conclusion:** observability is effectively absent. Everything below is a documented plan.

---

## Design (Grafana-focused)

### 1. Logging — foundation (structlog JSON)

Use the already-declared `structlog` dependency. Output shape:
- **Production:** JSON (`structlog.processors.JSONRenderer`) — machine-parseable for Loki ingestion.
- **Development:** human-readable colored key/value output.

Wiring intent (future code pass):
- Configure `structlog` once at app startup (bind `app` name, env, request id).
- Add a FastAPI middleware/`logging` integration so every request emits one structured access log:
  `method`, `path`, `status`, `duration_ms`, `user` (`sub`), `interview_id` where present.
- Log LLM calls (model, tokens, latency) and feedback generation at info/debug.
- **Never log secrets:** no `DATABASE_URL`, `LLM_API_KEY`, Clerk tokens, or message bodies that could
  contain them. Log user message **lengths/ids**, not content, at debug-only if at all.

### 2. Log aggregation + metrics — Grafana Cloud (Loki + Prometheus + Grafana)

Single-vendor observability layer:
- **Loki** ingests the JSON structlog output. In the k3s cluster, scrape/forward via a log agent
  (Grafana **Alloy** or **promtail**) that ships pod stdout to Loki; label by `app`, `pod`, `env`.
- **Prometheus** (or Grafana Cloud's managed metrics) scrapes a backend metrics endpoint
  (`/metrics`) plus the node/pod targets. Add the FastAPI metrics endpoint in a code pass
  (`prometheus-client` fastapi instrumentation). Grafana Cloud also offers an agent that can scrape
  and remote-write.
- **Grafana dashboards:** request rate / latency / error rate over time, panel filters by
  `status`/`user`/`role`. Alerts on e.g. `status>=500` or error-rate thresholds — driven **from Loki
  queries** so we do not need a separate APM for error visibility.
- Logs and metrics share the same structlog fields (`duration_ms`, `status`, `user`), so a metric
  trace links back to the raw JSON log line in Loki.

> **Error tracking without Sentry:** errors surface as `status>=500` log lines in Loki. Query
> `{app="backend"} |= "error"` for triage; alert on rate. This covers MVP needs without a second
> vendor. Defer Sentry unless exception grouping/source-maps become a bottleneck.

---

## Rollout order

1. **Layer 1** — structlog JSON logging (foundation; cheap, unblocks everything).
2. **Layer 2** — Grafana Cloud: Loki (ingest JSON logs) + a `/metrics` endpoint + Prometheus + Grafana
   dashboards. All Grafana — do together once there is anything to chart.

```mermaid
structlog JSON logs ──► Loki (Grafana Cloud) ──► Grafana dashboards/alerts
        │                     ▲
        └──► /metrics ──► Prometheus (Grafana Cloud)
```

---

## Acceptance criteria (when implemented)

- [ ] Production logs are JSON; dev logs are human-readable.
- [ ] Every API request emits a structured access log (method/path/status/duration/user).
- [ ] No secrets appear in logs.
- [ ] Loki stores backend logs (via agent); labels `app`/`pod`/`env` populated.
- [ ] Grafana shows request rate/latency/error dashboards + an alert on `status>=500`.
- [ ] (Future) Prometheus `/metrics` instrumentation for counters/histograms.
