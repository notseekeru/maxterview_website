# OBSERVABILITY — maxterview

One pipeline: structured logs. Everything else is a query over those logs. Decisions: no backend error
tracker (Loki already receives the tracebacks), no app-side metrics or traces yet, Grafana Cloud free
tier, and the app never holds a Grafana write credential.

## Shipped — tier 1, app-local

| Area | Where | What |
| --- | --- | --- |
| Logging | `backend/src/app/logs.py` | structlog plus a `ProcessorFormatter` bridge, so uvicorn's records and unhandled tracebacks are JSON in prod (console in dev). uvicorn's own access log is off — the middleware replaces it. |
| Request context | same | one `http.request` line per request with `method/path/status/duration_ms/user/interview_id`, `/health` skipped, `X-Request-ID` on every response. Identity is read from `scope["state"]` because the rate limiter is a `BaseHTTPMiddleware`, which blocks contextvars from travelling back up. |
| Turn cost | `app/main.py` chat route | `llm.chat.completed` / `llm.chat.failed` with model, latency and chars. Tokens would need `stream_options.include_usage` in the provider payload; not requested. |
| Browser errors — anonymous pages | `frontend/src/lib/errorBeacon.ts` → `POST /api/client-errors` | message and path only, deduped, ≤5 per page load, field caps plus a 4 KiB declared-length check taken before the body is parsed; the per-client rate limit is the volume ceiling. |
| Browser errors — signed-in app | `frontend/src/lib/sentry.ts`, started from `AppShell` | full Sentry SDK, errors only, after first paint. 146 kB gz because `@sentry/browser` hard-depends on replay/rrweb; an authenticated page pays it once, the landing page never does. |
| Probe depth | `/api/health` stays shallow | deliberate: the pool is lazy (`db.py`, `min_size=0`) and Neon scales to zero, so a DB-gated readiness would flap the only replica into a full outage. |

## Next — tier 2, needs a Grafana Cloud stack

1. Stack + access policy scoped `logs:write`; the token reaches the cluster as a Terraform-created Secret from Infisical, same pattern as `maxterview-secrets`.
2. Alloy as a **1-replica Deployment**, not a DaemonSet: `discovery.kubernetes` + `loki.source.kubernetes` tail through the Kubernetes API, so there is no hostPath, no node filesystem, no privileged container — just a Role with pods list/watch and pods/log get. Caveat: API tailing sees only what Alloy is running to witness.
3. Labels `app/pod/env`; three **Grafana-managed** alert rules (500 rate, feedback-generation failure, pod restart) — Loki-ruler alerts are deprecated in new stacks.
4. Ceilings that then bound history: 14-day retention, 5 MB/s ingest, 5k streams, 50 GB/mo.

Independent of all of the above: k3s ships `metrics-server`, and `kubectl top` fails on a kubelet
certificate SAN. Fixing that (`--tls-san`, brief apiserver restart) unblocks M18's load test with no
new pipeline at all.

## Parked — the trigger unparks each

- **OTel SDK → OTLP**, pointed at the in-cluster Alloy receiver (never at Grafana directly, so the app still holds no credential): when a number needs a real histogram, or history deeper than 14 days.
- **Tempo traces**: when a latency problem spans more than one hop.
- **Faro/RUM**: only after OTel exists, for frontend-to-backend trace correlation.
- **Dashboards-as-code, uptime probes, ingress observability**: the first incident that needs one.
- **Readiness deepening**: more than one replica, or a DB outage indistinguishable from an app outage.
