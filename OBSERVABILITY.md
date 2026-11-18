# OBSERVABILITY: maxterview

Structured logs carry every content event, OTLP carries every duration and count, and a log line
carries the trace id, so the two join. Decisions: no backend error tracker (Loki already receives the
tracebacks), no third-party browser error tracker (a beacon posts browser errors into the same logs),
no RUM (the browser has no trace context to contribute yet), Grafana Cloud free tier, and the app holds
no telemetry write credential in either pipeline.

## How each signal leaves the app

| Signal  | Direction                                 | App knows the collector   | Alloy down                                         |
| ------- | ----------------------------------------- | ------------------------- | -------------------------------------------------- |
| Logs    | stdout write, Alloy pulls through the API | no, it writes to fd 1     | delayed: the lines wait on the node until rotation |
| Traces  | push, OTLP over HTTP                      | yes, the endpoint env var | the batch queue fills and drops the spans          |
| Metrics | push, OTLP over HTTP                      | yes, the same env var     | the last interval drops with the queue             |

Only the push paths can lose data. The log path is a local write, so an Alloy outage delays ingest instead of dropping it.

## Logs in the app

- pino with an `AsyncLocalStorage` mixin, so request lines and unhandled errors are JSON in every env. Hono's own logger is unused: the middleware replaces it.
- One `http.request` line per request, `/health` skipped, `X-Request-ID` on every response. Identity is read from the Hono context at log time, after the auth middleware has set it.
- `llm.chat.completed` / `llm.chat.failed` carry model, latency and chars. Tokens would need `stream_options.include_usage` in the provider payload; not requested.
- Browser errors reach the same logs from every page, signed in or not: message, path, and the component stack of an `ErrorBoundary` render crash. Component names survive minification, a JS stack would not, so none is sent. Deduped, at most 5 per page load, field caps plus a 4 KiB declared-length check taken before the body is parsed; the per-client rate limit is the volume ceiling.
- `/api/health` stays shallow on purpose: the pool is lazy and Neon scales to zero, so a DB-gated readiness would flap the only replica into a full outage.

## Logs leaving the cluster

Alloy tails pod stdout through the Kubernetes API into Grafana Cloud Loki, labelled `namespace/pod/container/app` plus the external `cluster`/`app`. Its config is `gitops/apps/maxterview/base/alloy.yaml`.

- One Deployment, not a DaemonSet: `discovery.kubernetes` into `loki.source.kubernetes` goes through the API, so no hostPath, no node filesystem, no privileged container.
- `namespaces { own_namespace = true }`. Discovery lists cluster-wide by default and the namespaced Role forbids that: the first deploy produced a 403 and zero targets. Here the Role is the scope.
- A `drop` on the `Succeeded` phase, so a finished job does not hold a stream open.
- The kube-probe fetching `/` every 10s was nearly the whole pipeline. Dropped in nginx for the same reason the backend skips `/api/health`, so the line never leaves the node.
- The `maxterview/config-hash` pod annotation. Argo updating a ConfigMap restarts nothing and Alloy reads its config at startup, so the hash must be bumped with the config to roll the pod.
- One access-policy token, scoped `logs:write`, `metrics:write`, `traces:write`, held by Alloy alone. Both pipelines authenticate with it and only the username differs; the app never holds it.

## OTLP

- OTel SDK over OTLP/HTTP to the in-cluster receiver, which is the only holder of a write credential. HTTP/protobuf only: the Node exporter has no gRPC client wired, so there is no second listen address. The endpoint env var is the kill switch: empty means the SDK is never installed and every call site runs against the API's no-op proxies, so nothing in the app branches on whether telemetry is on.
- Export runs on the batch processor's own timer and drops when its queue is full, so an unreachable collector costs the request path nothing; shutdown flushes under a 5s bound so it cannot hold the pod in Terminating.
- The root span wraps the same region `duration_ms` measures. Every model call carries `llm.stage` (chat/chat.close/judge/grader/formatter/classify/shout), which is the only way to see that a feedback run is several calls in a row and which one owns the clock. The probe path creates no span, no sample and no line: it alone filled the first Tempo page and would have buried every real trace in the search list.
- Grafana Cloud gives every legacy service its own basic-auth user and the OTLP gateway another, the stack tenancy id shared with profiles and insights. Point the exporter at the wrong one and every batch is dropped with HTTP 401 while the receiver keeps accepting, the app logs nothing and the panels read empty. Only the tenancy id answers 200.
- `http.server.request.duration`, `llm.client.call.duration`, and the two database histograms that keep waiting apart from working: `db.pool.wait.duration`, and `db.query.duration` labelled by operation. Bucket boundaries are pinned in the SDK because its defaults are written for milliseconds and applied whatever the unit.
- The route label is the matched template, never the raw path, so a scanner sweeping URLs cannot mint a series per URL. Labels stay route, method, status, model, stage, outcome; never `interview_id` or `user_sub`.
- The log context carries `trace_id` and `span_id`, which is the whole Grafana-side wiring: the Loki datasource already carries the derived-field regex, and Tempo already points at logs, metrics and profiles.
- One collector for both signals. The OTLP receiver is unauthenticated inside the namespace, the same trust boundary the log tailing already relies on.
- An unset `OTLP_URL` has to fail the pod's startup rather than leave a silently empty endpoint, so Terraform carries all four secret keys before this revision syncs, and the config hash above is what rolls the pod onto them.

## Alerts

The kit in `observability/grafana` is the only writer: `bootstrap.py` renders the folder, the rule group and the dashboard from `rules/` and `dashboards/`, and writes the rules without `disable_provenance`, so Grafana marks them provisioned and locks them against UI edits. Changing a rule means editing the JSON and rerunning.

- The rules count 5xx, liveness and the two latency lines off the OTLP metrics, read the logs for tracebacks, browser errors, swallowed model failures and the voice/Clerk/PayMongo dependency failures, and cover saturation: container memory against its limit, an OOM kill, disk free, node anonymous memory against capacity.
- `noDataState` is `OK` on all of them: an app with no traffic genuinely has no 5xx, no model calls and no tracebacks, so silence is never read as failure.
- The counters cannot see a dead export. The liveness rule is what can, because `target_info` and the app's heartbeat gauge are the only backend series that exist with zero traffic, and a backend that stops pushing would otherwise leave every rule quiet.
- Both latency rules exclude the model and voice routes on purpose, since that duration belongs to the provider, and both count requests past a line instead of taking a percentile: at this volume a p95 is one slow minute, not a distribution.
- Pool wait and query time are separate instruments, so "waiting for Neon" and "the database is slow" never read the same.
- Traffic and saturation are read and never alerted: a spike at this volume is a scanner and a dip is a quiet day.
- Routing lives in the notification tree `bootstrap.py` writes, one route per severity, critical repeating hourly and warning every six, and no rule sets a receiver of its own, because a rule-level one wins over the tree and would bypass the split.
- Downtime is the only signal that does not come off the node: the alerting engine GETs `/api/health` every 60s and fires when that fetch fails, so a dead app, a dead tunnel, dead DNS and a dead node all read the same way. It judges the response, not the body. The target is `/api/health` and not an instrumented route, so the probe adds no traffic to the pipeline it is watching.
- The dashboard reads logs and both metric groups, so a project that only ships logs still gets a usable board. Log volume answers whether anything happened; the usage stat answers how much.
- Retention is the whole of the history question, and nothing here buys more than the tier gives. The ceilings are not this repo's to state: read them off the tenant's own limit metrics on the `grafanacloud-usage` datasource.
