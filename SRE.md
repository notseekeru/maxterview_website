# SRE

Minimal SRE path for loading metrics and load testing application by generating randomized structured request with k6

Inspired by Arjay McCandless load testing videos, usually known for system design with informative detailed videos.

## The question

At what load does the prod deployment stop behaving acceptably, and which resource runs out first.

## What is measured

| Indicator         | Source                                                       | Carries               |
| ----------------- | ------------------------------------------------------------ | --------------------- |
| Request latency   | `http.server.request.duration`, and k6 on the client side    | method, route, status |
| Error rate        | the same histogram, plus k6 broken down by status code       | status                |
| Throughput        | k6 RPS, and the server histogram's own sample count          | route                 |
| Database pressure | connections in use against a pool of 10                      |                       |
| Saturation        | CPU, frequency, temperature, load, memory                    |                       |
| Architecture      | Architecture of machine/optimization framework or tools used | baseline              |

Windows machine is the load generating machine, which could minimally be monitored by myself, though it isnt systematic, that would be enough for my purpose of the test since we dont really expect the load generating machine to saturate much. Focus on the application you're about to load not overcomplicate by other concerns, though we could use something like csv metrics.

Bucket boundaries are pinned in the SDK rather than left to its defaults, and they run from 0.01 to 120 seconds.

Four more are recorded for this experiment. `db.pool.wait.duration` and `db.query.duration` are sampled apart inside `db.py`, so a queued connection and a slow query are distinguishable, and the query label is the statement's first keyword, which keeps the label set bounded and the query text off the metric.

Three properties of the instrumentation matter to this experiment.

The route label is the matched template and never the raw path, so the label set stays bounded and a scanner sweeping URLs cannot mint a series per URL.

The server histogram covers the whole response body, which means an SSE turn's sample is time-to-last-byte. That is why streams report separately from the plain reads.

The access line carries `request_id`, `trace_id`, `span_id`, `status` and `duration_ms`, and it is the join between a k6 failure and the server's own account of what happened.

The server-side indicators only exist when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. With it unset the SDK is never installed.

The turn counter's contention has no app metric. If the curve bends before the hardware explains it, `turn_usage` is the first suspect, and the evidence is lock waits on the Neon side rather than anything in the dashboards.

## SLO

| Indicator   | Gate           |
| ----------- | -------------- |
| p50 latency | none, reported |
| p95 latency | <1s            |
| p99 latency | <5s            |
| error rate  | <1%            |
| correctness | check pass     |

established my baseline of acceptable for this particular architecture since latency can be dependent on programming language and the framework it's using, this is much more important than it seem especially if were testing application performance.

p50 is there for reporting, no gate added since it can be considered redundant since p95 would fail first, but for the sake it, i just added p50 latency.

## Architecture

One path, ending in the same pod.

```
Capacity path
  k6 (Windows box) -> Tailscale -> ingress-nginx -> pod
  pod -> Neon (direct host, TLS)
  pod -> Alloy (in-cluster) -> Grafana Cloud
```

The app's own request path, its middleware order and the layer breakdown are in the README's `## Architecture` section. What matters here is the composition of a single turn.

- two reads to open the session, the interview row and then its transcript
- one read and one upsert for the turn credit
- sometimes a delete and an insert, the trailing-user-turn repair
- one insert for the reply

**Every one of those reads is a network round trip to Neon, not a local call.** That is the material the number is made of.

## Configuration

### The box

RPi5, 8 GB, four Cortex-A76 cores.

### Deploy

| Setting          | Value                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------- |
| replicas         | 1, no autoscaler, no HPA, no KEDA                                                     |
| ingress-limit    | 30 and 20 burst, raised to 1M(both) for the duration                                  |
| pod memory limit | 256Mi                                                                                 |
| telemetry        | OTLP to the in-cluster Alloy receiver, which is the only holder of a write credential |
| database         | Neon direct host, not `-pooler`, TLS required                                         |

The overlay itself lives in the gitops repo, so those values are read from there and not from this file.

### The app's own limits

These bound what one client can do, so they set the roof on the loop.

| Limit                    | Value                                                    |
| ------------------------ | -------------------------------------------------------- |
| DB pool                  | `max_size=10`, `min_size=0`                              |
| app rate limit           | 120/minute per client IP by default, `off` in the window |
| daily turn cap           | `DEV_CHAT_TURNS`, 100000000 in dev and prod              |
| templates                | 20, a module constant                                    |
| resume parse concurrency | 2                                                        |
| feedback attempts        | 3 attempts, 800ms apart                                  |

## Tools

### The app

| Layer           | What                                                               |
| --------------- | ------------------------------------------------------------------ |
| Runtime         | Python 3.14-slim, FastAPI                                          |
| uvicorn workers | 1, the Dockerfile passes no `--workers`                            |
| Data            | asyncpg against Postgres, yoyo for migrations                      |
| Logging         | structlog, one JSON access line per request                        |
| Telemetry       | OpenTelemetry SDK, OTLP over HTTP to the in-cluster collector      |
| Rate limiting   | limits, in-process memory storage, no redis for now                |
| Frontend        | React 19, Vite, TypeScript, Tailwind, Clerk React, axios, recharts |

### The experiment

| Purpose               | Tool                                                                               |
| --------------------- | ---------------------------------------------------------------------------------- |
| Load generation       | k6, on the Windows box                                                             |
| Private path          | Tailscale                                                                          |
| Orchestration         | k3s, ingress-nginx, Argo CD, Kustomize                                             |
| Metrics, logs, traces | Grafana Cloud, with Alloy as the in-cluster shipper                                |
| Harness               | `~/k6-load-testing`: `main.js` the workload, `sweep.py` the ladder and the cleanup |
| Database              | Neon, prod's default branch, direct host                                           |

## Neon

The sweep runs against prod's default branch, so it spends prod's own budget and its rows land in prod's data. The cleanup between steps is what keeps that bounded instead of accumulating.

## Perf window

| Change                                    | Value        |
| ----------------------------------------- | ------------ |
| `LLM_BASE_URL`                            | unset (stub) |
| `RATE_LIMIT`                              | `off`        |
| `CLERK_ENABLED`                           | `false`      |
| `APP_ENV`                                 | `test`       |
| `nginx.ingress.kubernetes.io/limit-rps`   | `1000000`    |
| `nginx.ingress.kubernetes.io/limit-burst` | `1000000`    |

it cann be automated using a script with infisical changing values in prod and auto sed with commits, or by doing it manually.

Opening the window is four steps: commit the perf values, see the sync land, confirm the pod was replaced, and read its env to watch the perf values go live before any load.

## What one virtual user does

Every virtual user is the same identity and they all share one account.

A virtual user drives the app the way a person would. It creates an interview, answers it, finishes it, reads the review, then moves on to whatever else the app offers. Any endpoint a signed-in user can reach is in scope, so this measures the app's surface and not one route.

The number of turns is a structured but randomized actions run per VU, with each going through thinking to simulate how a real user would behave.

Exclusions, for different reasons.

NvidiaNIM(LLM Output) and Cloudflare Workers AI(Voice) is out.

These vendors uses credit and will only limit the workload, this is why NvidiaNIM is stubbed and Cloudflare Workers AI is off.

Outside Generation, vendor that could fail the experiment due to free tier and rate limits.

For the edge tunneling, the tunnel that exists because of CGNAT, and Cloudflare's bot protection, which on Free cannot be skipped — the only lever is an IP Access rule, and any IP Access rule disables BFM zone-wide, not just for the runner. So I just simplified my Architecture, just using Tailscale for connection of load machine and application machine. While using cloudflare could measure PROD like latency, the plan itself was just really touching on SRE principles rather than focusing on what real users feel.

**PDF import is out of the loop.** `PLAN.md` has the measurement: a 40MB `/Contents` peaks 1.74GB for zero characters of text against a 256Mi pod limit, so one upload can OOMKill the only replica. That would read as a capacity failure when it is a known unfixed bug, and it is its own piece of work.

## What each iteration asserts

Latency says nothing about whether the app worked, so each iteration checks, as k6 checks, that a failure lands in the same report as the timings.

- the interview was created and came back with an id
- the opener streamed and ended with `done`
- every answer streamed and ended with `done`
- the transcript holds one assistant reply per user turn, so a dropped or duplicated turn fails the run
- `finish` returned the completed status
- `GET /feedback` returned a review for that run

A sweep that passes on latency while any of those is false is not a pass.

The stub is read at import, so a pod that never restarted is a window that never opened.

## What the reads cost

The reads that scale with history are in the loop, so the loop's own writes change them. `GET /api/interviews` returns every run for the owner with no limit, and the stats endpoints re-scan the full history. Left alone, a later step reads a bigger account than an earlier one did, and part of any curve is data the test itself created. I could use Pagination and Redis but for a simplicty and not to deviate much before some current non-optimized architecture.

So the rows go between steps. Every other test here cleans up after itself and this one does the same, which holds the account at a constant size and stops growth from presenting itself as capacity loss.

## Between steps

Warm the database. `min_size=0` means the first requests pay pool creation and a fresh TLS handshake, and Neon scale-to-zero means the first request after an idle gap pays the compute wake.

Every step runs the same four phases and only the third is data: a 30 second ramp to the target, a 60 second warm-up that is discarded, a 300 second measurement window, and a stop. The warm-up never becomes part of a number.

We start at 25 VUs and double from there, 25, 50, 100, 200, 400, and we keep going past 400 if needed. The first four are just checks. They are simple and they catch a broken test so like basically a smoke test where we just first check the application or a broken generator that was already broken before the load even got high.

If one of the first four fails, that is not a load problem, so we stop and fix it instead of searching. The search only starts at 200 and above.

Each level passes or fails. If it passes, we go up. If it fails on an SLO, we stop going up, but the run keeps going. That failure becomes the top of the range, and we split the gap between the last pass and that failure to find the highest level that still passes. If 200 passes and 400 fails, try 300; if 300 passes, try 350. That is a binary search. We only need the boundary between pass and fail, not an exact number, because the boundary itself moves about 10% between runs. If we land on 2500 today, a rerun could land at 2400 or 2600 and that is the same answer.

## Decisions

1. k3s only, no host run. I am keeping k8s, so host-versus-k3s had no decision attached. Rejected: the host run, which answers a question I am no longer asking.
2. The prod pod patched, not a second Deployment. On a single node a second pod fights the prod pod for the same four cores, so its number is not prod's number. Rejected: a parallel Deployment, which measures a pod no user will hit.
3. Prod's default branch, not a Neon branch. Every VU is one identity either way, so a branch would isolate rows and change nothing about contention, at the cost of a second compute and a Secret swap. This is a deliberate override of D11, which says branches are for PR and migration rehearsal and that prod's default branch is never used for this. D11 needs a carve-out, or the override needs recording there.
4. Use Tailscale instead of cloudflare due to BFM.
5. `APP_ENV=test` with Clerk off, and the simulate route left open. Both side effects accepted and recorded above. Rejected: staying on production with minted Clerk tokens, which keeps JWT verification in the measured path but makes Clerk a dependency of the sweep.
6. A full run per virtual user with a randomized turn count, plus any other endpoint a signed-in user can reach. Rejected: a fixed count, which makes every virtual user do identical work and has to be tuned to sit inside the arc; and a reads-only loop, which never touches the streaming path.
7. Telemetry stays on and gets recorded as cost. Rejected: turning it off, which gives a cleaner app number at the price of the deployed configuration.
8. The model stubbed for the sweep. Rejected: real generation, where the ceiling is the provider's quota and not this one.
9. Direct host, not the pooler. A `-pooler` DSN flips `statement_cache_size`, a different code path than prod runs.
10. The sweep runs under its own identity, named by `DEV_USER_SUB`. Rejected: leaving it as `dev-user`, which puts the run's rows and its daily turn counter on the same account dev uses, and makes the cleanup inseparable from real data.
11. The workload stays defined by whatever a signed-in user can reach, with no version pinned to it. Rejected: pinning it to the image revision, which would date the drift but costs a fact to maintain. The consequence is that a new route joins the workload silently, so two runs are only comparable when they share a revision.

## Open

- `kubectl top` fails on a kubelet certificate SAN. Fix is `--tls-san` plus a brief apiserver restart. Until then host CPU and temperature come from `vmstat` and `htop`.

## Audit, 2026-10-11

Against the source at `d80cbf9` and gitops at `185b6e1`. Severity is the cost if it fires unattended.

### The spec against the source

| Claim here                                         | Verdict | Evidence                                                                                                                                                                   |
| -------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buckets pinned, 0.01 to 120s                       | holds   | `telemetry.py:35`                                                                                                                                                          |
| Pool wait and query duration, one apart            | holds   | `db.py:77,80`                                                                                                                                                              |
| Query label is the first keyword                   | holds   | `db.py:59-65`, else `other`                                                                                                                                                |
| Route label is the matched template                | holds   | `logs.py:139-142`, unmatched paths land on `unmatched`                                                                                                                     |
| Access line fields                                 | holds   | `logs.py:93-133`                                                                                                                                                           |
| Indicators only exist with the endpoint            | holds   | `telemetry.py:41,76`                                                                                                                                                       |
| Pool 10 / 0, non-pooler DSN                        | holds   | `db.py:29-33`                                                                                                                                                              |
| Limiter 120/minute per client IP                   | holds   | `ratelimit.py:25`                                                                                                                                                          |
| Templates 20, resume parses 2, feedback 3 at 800ms | holds   | `main.py:390,63-64`, `resumes.py:29`                                                                                                                                       |
| One worker, replicas 1, 256Mi                      | holds   | `backend/Dockerfile` CMD, gitops `base/backend.yaml:6,50`                                                                                                                  |
| D11 carve-out for the prod-branch override         | missing | `PLAN.md:14` still says prod's default branch is never used for this                                                                                                       |

### Reliability

| Finding                                                                                                                                                                                                    | Evidence                                                                  | Severity |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------- |
| One replica on one node. Any pod restart, image pull or node loss is a full outage, and nothing states that ceiling                                                                                        | gitops `base/backend.yaml:6`, no PDB, no second node                      | high     |
| A 1.74GB peak from one authenticated PDF against a 256Mi limit kills the only replica, in-flight SSE included, and no alert or probe sees it                                                               | `PLAN.md:26`, gitops `base/backend.yaml:50`, no restart rule              | high     |
| No backup or point-in-time restore anywhere in the repo. The only recovery path is a manual Neon snapshot (`README.md:122`), so the ceiling is the plan's retention and an operator's memory               | no `backup`/`restore`/`PITR` outside `PLAN.md`                            | high     |
| No CPU limit, only a 10m request. The 90s CPU-bound parse path can starve the frontend and ingress-nginx on the same four cores                                                                            | gitops `base/backend.yaml:52-55`                                          | med      |
| Liveness and readiness are the same shallow `/api/health`, no `timeoutSeconds`, `periodSeconds` or `failureThreshold`, so the defaults decide. An event-loop-starved pod is restarted rather than degraded | gitops `base/backend.yaml:37-46`                                          | med      |
| No `terminationGracePeriodSeconds` and no `preStop`, so replacing the pod cuts in-flight streams mid-turn, which is the object being measured                                                              | gitops `base/backend.yaml`                                                | med      |
| Migrations run as a PreSync hook and yoyo only goes forward. There is no path back over a schema change that the running code cannot read                                                                  | gitops `base/migration-job.yaml`, `README.md:122`                         | med      |
| Argo syncs with `selfHeal: true` from GitHub main, so the overlay's own `kubectl apply -k` alternative reverts itself. Opening the window that way needs the app paused first                              | gitops `apps-of-apps/maxterview.yaml`, `overlays/perf/kustomization.yaml` | med      |
| Limiter state is in-process `MemoryStorage`: a restart clears every window, and a second replica would double the effective limit                                                                          | `ratelimit.py:8,26`                                                       | low      |
| `min_size=0` plus Neon scale-to-zero means the first request after idle pays wake, TLS and pool creation, and no SLO carve-out exists for that request                                                     | `db.py:29`, this file `## Between steps`                                  | low      |
| The whole `maxterview-secrets` Secret arrives through one `envFrom`, so one malformed key blocks the pod from starting                                                                                     | gitops `base/backend.yaml:31-34`                                          | low      |

### Observability

| Finding                                                                                                                                                                                                           | Evidence                                                            | Severity |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------- |
| Nothing watches the node or the pod. Ten rules read what the app emits, so a restart, an OOMKill or a CrashLoop is silent until it becomes a 5xx                                                                  | `observability/grafana/rules/alerting.json` titles, no restart rule | high     |
| The SLO gates exist only as prose. The dashboard has p95 panels but no rule fires on 1s, 5s or 1%, so nothing holds the line between sweeps                                                                       | `dashboards/logs.json:172,188`, no latency expression in any rule   | high     |
| Every signal leaves through the same node, the same Alloy Deployment and the same outbound path, and no check comes from outside. Node or tunnel death blinds all ten rules at once, and TLS expiry is unobserved | `alloy.yaml:4-5,48-50`, no uptime or cert rule                      | high     |
| No host metrics at all: no node-exporter, Alloy tails through the API, `kubectl top` is broken, so disk, thermal and CPU headroom on the only node are unmeasured                                                 | `alloy.yaml:4-5,48-50`, this file `## Open`                         | med      |
| `db.pool.wait.duration` only sees the pool. The lock waits named here as the first suspect behind a bend in the turn counter have no pipeline, and reading them is a manual Neon query                            | `db.py:77`, this file `## What is measured`                         | med      |
| If Alloy stops, the pipeline goes quiet and the one rule that watches it reads a stream that is no longer being written                                                                                           | `alloy.yaml`, `alerting.json` dropped-batch rule                    | med      |
