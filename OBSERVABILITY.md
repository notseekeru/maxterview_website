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

## Shipped — tier 2, log pipeline

Logs leave the cluster: Alloy tails pod stdout through the Kubernetes API into Grafana Cloud Loki, and a rule set turns those lines into alerts. Labels are `namespace/pod/container/app` plus the external `cluster`/`app`.

| Area | Where | What |
| --- | --- | --- |
| Collector | `gitops/apps/maxterview/base/alloy.yaml` | One **Deployment**, not a DaemonSet: `discovery.kubernetes` → `loki.source.kubernetes` goes through the Kubernetes API, so no hostPath, no node filesystem, no privileged container — just a namespaced Role for pods list/watch and pods/log get. |
| Discovery scope | same | `namespaces { own_namespace = true }`. Discovery lists cluster-wide by default and the namespaced Role forbids that: the first deploy produced a 403 and zero targets. Here the Role *is* the scope. |
| Target filter | same | `drop` on `__meta_kubernetes_pod_phase =~ "Succeeded|Failed"` — a finished Job pod has no live stream and API tailing re-opens it in a hot loop. Drop, not keep-on-Running, so a missing label can never silently drop every target. |
| Config changes | same | The `maxterview/config-hash` pod annotation. Argo updating a ConfigMap restarts nothing and Alloy reads its config at startup, so the hash must be bumped together with the config to roll the pod. |
| Credential | Terraform `maxterview-logs` Secret, values from Infisical | `LOKI_URL`/`LOKI_USER`/`LOKI_TOKEN`, scope `logs:write` and nothing else. The app never holds it. |
| Alerts | Grafana, `maxterview` folder | Three **Grafana-managed** rules — backend 5xx, LLM failures, backend tracebacks — routed to a Slack contact point (webhook lives in Infisical at `/sources/webhooks`). Loki-ruler alerts are deprecated in new stacks. |
| Ceilings | — | 14-day retention, 5 MB/s ingest, 5k streams, 50 GB/mo. Metric history inherits the log window, since metrics are LogQL queries over these lines. |

Independent of all of the above: k3s ships `metrics-server`, and `kubectl top` fails on a kubelet
certificate SAN. Fixing that (`--tls-san`, brief apiserver restart) unblocks M18's load test with no
new pipeline at all.

## Parked — the trigger unparks each

- **OTel SDK → OTLP**, pointed at the in-cluster Alloy receiver (never at Grafana directly, so the app still holds no credential): when a number needs a real histogram, or history deeper than 14 days.
- **Tempo traces**: when a latency problem spans more than one hop.
- **Faro/RUM**: only after OTel exists, for frontend-to-backend trace correlation.
- **Dashboards-as-code, uptime probes, ingress observability**: the first incident that needs one.
- **Readiness deepening**: more than one replica, or a DB outage indistinguishable from an app outage.
