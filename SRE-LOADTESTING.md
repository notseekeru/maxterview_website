# SRE

Minimal SRE path for loading metrics and load testing application by generating randomized structured request with k6

Inspired by Arjay McCandless $12 VPS load testing videos, usually known for system design with informative detailed videos.

## The question

At what load does the prod deployment stop behaving acceptably, and which resource runs out first.

## What is measured

| Indicator         | Source                                                                         | Carries               |
| ----------------- | ------------------------------------------------------------------------------ | --------------------- |
| Request latency   | `http.server.request.duration`, and k6 on the client side                      | method, route, status |
| Error rate        | the same histogram, plus k6 broken down by status code                         | status                |
| Throughput        | k6 RPS, and the server histogram's own sample count                            | route                 |
| Database pressure | `db.pool.size` against `db.pool.idle`, a pool of 10                            | connections held      |
| Saturation        | CPU and memory for the node and its pods from `kubectl top` and host on `htop` |                       |
| Architecture      | Architecture of machine/optimization framework or tools used                   | baseline              |

Windows machine is the load generating machine, which could minimally be monitored by myself, though it isnt systematic, that would be enough for my purpose of the test since we dont really expect the load generating machine to saturate much. Focus on the application you're about to load not overcomplicate by other concerns, though we could use something like csv metrics.

Bucket boundaries are pinned in the SDK rather than left to its defaults, and they run from 0.01 to 120 seconds.

Two more are recorded for this experiment. `db.pool.wait.duration` and `db.query.duration` are sampled apart inside `db.py`, so a queued connection and a slow query are distinguishable, and the `db.operation` label is the statement's first keyword, which keeps the label set bounded and the query text off the metric.

Three properties of the instrumentation matter to this experiment.

The route label is the matched template and never the raw path, so the label set stays bounded and a scanner sweeping URLs cannot mint a series per URL.

The access line carries `request_id`, `trace_id`, `span_id`, `status` and `duration_ms`, and it is the join between a k6 failure and the server's own account of what happened.

The server-side indicators only exist when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. With it unset the SDK is never installed.

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

## Configuration

### Windows load generator(The one who runs k6)

| Component  | Specification                                                                                                              |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| CPU        | AMD Ryzen 5 3600 (6 cores / 12 threads)                                                                                    |
| RAM        | 32 GB                                                                                                                      |
| Monitoring | Lightweight/manual monitoring initially; observe CPU, memory, and k6 process behavior if generator saturation is suspected |

If the generator approaches sustained CPU or memory pressure or can't maintain the intended VU load, the measured capacity ceiling could generator limitations rather than application limitations.

### The box(The main machine we're testing)

| Component  | Specification                      |
| ---------- | ---------------------------------- |
| Device     | Raspberry Pi 5                     |
| RAM        | 8 GB                               |
| CPU        | Four Cortex-A76 cores              |
| Deployment | k3s, single replica, no autoscaler |

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

Uses scale-to-zero so we don't pay for compute when the application is not used. This has tradeoffs like coldstarts but for this particular scale I decided to still just don't touch it since we're gonna be warming up our Neon database anyways.

## Perf window

| Change                                    | Value        |
| ----------------------------------------- | ------------ |
| `LLM_BASE_URL`                            | unset (stub) |
| `RATE_LIMIT`                              | `off`        |
| `CLERK_ENABLED`                           | `false`      |
| `APP_ENV`                                 | `test`       |
| `nginx.ingress.kubernetes.io/limit-rps`   | `1000000`    |
| `nginx.ingress.kubernetes.io/limit-burst` | `1000000`    |

Really simple to change values, commit the perf values, see the sync land in argocd, confirm the pod was replaced with maybe kubectl or the gui, and read its env to watch the perf values go live before any load. overlays override infisical values like `LLM_BASE_URL`.

## What each VUs does

| Operation                                  | Type         | When           | Per turn |
| ------------------------------------------ | ------------ | -------------- | -------- |
| Interview row read                         | Read         | Session open   | 1        |
| Transcript read                            | Read         | Session open   | 1        |
| Reply insert                               | Write        | Every turn     | 1        |
| Trailing-user-turn repair: delete + insert | Write        | Sometimes      | 0 or 2   |
| Turn credit read + upsert                  | Read + write | Turn credit on | 0 or 2   |

Every virtual user is the same identity and they all share one account.

The number of turns is a structured but randomized actions run per VU, with each going through thinking to simulate how a real user would behave.

Exclusions, for different reasons.

NvidiaNIM(LLM Output) and Cloudflare Workers AI(Voice) is out. These vendors uses credit and will only limit the workload, this is why NvidiaNIM is stubbed and Cloudflare Workers AI is off. These Outside Generation, vendor that could fail the experiment due to free tier and rate limits.

For the edge tunneling, the tunnel that exists because of CGNAT, and Cloudflare's bot protection, which on Free cannot be skipped — the only lever is an IP Access rule, and any IP Access rule disables BFM zone-wide, not just for the runner. So I just simplified my Architecture, just using Tailscale for connection of load machine and application machine. While using cloudflare could measure PROD like latency, the plan itself was just really touching on SRE principles rather than focusing on what real users feel.

**PDF import is out of the loop.** `PLAN.md` has the measurement: a 40MB `/Contents` peaks 1.74GB for zero characters of text against a 256Mi pod limit, so one upload can OOMKill the only replica. That would read as a capacity failure when it is a known unfixed bug, and it is its own piece of work.

## Correctness (k6 checks)

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

A sweep is the whole experiment: warm the database, climb the ladder, bracket the failure, binary search, confirm, and record the boundary for estimated max users. A step is one level inside it. The sweep is automated end to end, so there are no human gaps between steps. That matters here, because let's say I forgetting to actually run the test for a certain period, it will eventually close because theres no one using the application. A gap long enough would let the asyncpg pool close its idle connections and Neon return to scale-to-zero, and the next step would pay the wake again before any number is taken.

So first, we warm the database. `min_size=0` means the first requests pay pool creation and a fresh TLS handshake, and Neon scale-to-zero means the first request after an idle gap pays the compute wake.

Then every step is a ramp to the target VUs, a 1min quiet gap with no requests which separates one step from the next in the metrics or in a dashboard like grafana., then a 5minute measurement window. Specifically, only the measurement window counts.

The database is warmed once before the first step, so pool creation and the Neon wake we already paid before any number is taken.

We start at 100 VUs and double from there. This is first level where we are checking and warming up: initialize our database, a smoke test for an app or a generator that was already broken before the load got high.

If one of them fails, then that is not a load problem, so we stop and fix it instead of searching since it will be very unsual to have my test fail at such a low number. The search only starts above the smoke levels.

Each level passes or fails. If it passes, we go up. If it fails on an SLO, we stop going up, but the run keeps going. That failure becomes the top of the range, and we split the gap between the last pass and that failure to find the highest level that still passes. If 200 passes and 400 fails, try 300; if 300 passes, try 350. That is a binary search. We only need the boundary between pass and fail, not an exact number, because the boundary itself moves about 10% between runs. If we land on 2500 today, a rerun could land at 2400 or 2600 and that is the same answer.

Confirm the highest passing level by re-running it 3 times, and again since the boundary moves about 10% this becomes more important to evaluating between runs and a single pass is not proof.

## Decisions

1. k3s only, no host run. I am keeping k8s, so host-versus-k3s had no decision attached. Rejected: the host run, which answers a question I am no longer asking.
2. The prod pod patched, not a second Deployment. On a single node a second pod fights the prod pod for the same four cores, so its number is not prod's number. Rejected: a parallel Deployment, which measures a pod no user will hit.
3. Prod's default branch, not a Neon branch. Every VU is one identity either way, so a branch would isolate rows and change nothing about contention, at the cost of a second compute and a Secret swap.
4. Use Tailscale instead of cloudflare due to BFM.
5. `APP_ENV=test` with Clerk off, and the simulate route left open. Both side effects accepted and recorded above. Rejected: staying on production with minted Clerk tokens, which keeps JWT verification in the measured path but makes Clerk a dependency of the sweep.
6. A full run per virtual user with a randomized turn count, plus any other endpoint a signed-in user can reach. Rejected: a fixed count, which makes every virtual user do identical work and has to be tuned to sit inside the arc;
7. Telemetry stays on and gets recorded as cost. Rejected: turning it off, which gives a cleaner app number at the price of the deployed configuration.
8. The model stubbed for the sweep. Rejected: real generation, where the ceiling is the provider's quota and not this one.
9. Direct host, not the pooler. A `-pooler` DSN flips `statement_cache_size`, a different code path than prod runs.
10. The sweep runs under its own identity, named by `DEV_USER_SUB`.
11. The workload is what `main.js` walks, with no version pinned to it. Rejected: pinning it to the image revision, which would date the drift but costs a fact to maintain. The consequence is that a new route joins the workload silently, so two runs are only comparable when they share a revision.
