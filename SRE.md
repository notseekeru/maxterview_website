# SRE

This file owns the run: the architecture it measures, the indicators it produces, the workload, the config the app runs under, and the decisions behind all of it.

Some tables below restate owners that already exist, on purpose, so a run can be read from one file: the manifests hold the dependency lists, the modules hold the constants, `OBSERVABILITY.md` holds the metrics, README holds the request path. Those stay the owners. This file is the copy that goes stale.

## The question

At what load does the prod deployment stop behaving acceptably, and which resource runs out first.

Not a user count, because that is not answerable without fixing what a user does. Not a host-versus-k3s comparison either, since I am keeping k3s and that run had no decision attached to it.

## What is measured

| Indicator         | Source                                                    | Carries               |
| ----------------- | --------------------------------------------------------- | --------------------- |
| Request latency   | `http.server.request.duration`, and k6 on the client side | method, route, status |
| Error rate        | the same histogram, plus k6 broken down by status code    | status                |
| Throughput        | k6 RPS, and the server histogram's own sample count       | route                 |
| Database pressure | connections in use against a pool of 10                   |                       |
| Saturation        | CPU, frequency, temperature, load, memory                 |                       |

Load generating machine could minimally be monitored by myself, though it isnt systematic, that would be enough for my purpose of the test since I dont really expect the load generating machine to saturate much. Focus on the application you're about to load not overcomplicate by other concerns.

Bucket boundaries are pinned in the SDK rather than left to its defaults, and they run from 0.01 to 120 seconds.

Four more are recorded for this experiment. `db.pool.wait.duration` and `db.query.duration` are sampled apart inside `db.py`, so a queued connection and a slow query are distinguishable, and the query label is the statement's first keyword, which keeps the label set bounded and the query text off the metric. The pod's restart count and last termination reason say whether a failure was the 256Mi limit rather than the node. Alloy's own CPU and its dropped-batch signal, which already feeds a Grafana alert, say whether the collector became the bottleneck.

Three properties of the instrumentation matter to this experiment.

The route label is the matched template and never the raw path, so the label set stays bounded and a scanner sweeping URLs cannot mint a series per URL.

The server histogram covers the whole response body, which means an SSE turn's sample is time-to-last-byte. That is why streams report separately from the plain reads.

The access line carries `request_id`, `trace_id`, `span_id`, `status` and `duration_ms`, and it is the join between a k6 failure and the server's own account of what happened.

The server-side indicators only exist when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. With it unset the SDK is never installed.

The turn counter's contention has no app metric. If the curve bends before the hardware explains it, `turn_usage` is the first suspect, and the evidence is lock waits on the Neon side rather than anything in the dashboards.

## SLO

One gate shape, and the gates themselves come from the baseline.

| Indicator                          | Gate                                               |
| ---------------------------------- | -------------------------------------------------- |
| p95 latency, plain reads           | from the baseline                                  |
| p95 time-to-last-byte, SSE turns   | from the baseline                                  |
| error rate, my own config excluded | from the baseline                                  |
| throughput                         | none. It is the experiment's output, not a target. |

A step fails on a gate, on a failed correctness check, or on a hard resource failure, and the first failure stops the sweep. The latency inflection and the resource that moved first are the explanation of a failure, not its definition: a step can fail on correctness with a perfectly flat curve, and a clean inflection with everything still under the gate is a step that passed.

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
| templates                | 20, a module constant                                    |
| resume parse concurrency | 2                                                        |
| feedback attempts        | 3 attempts, 800ms apart                                  |

## The vendors

### Neon

The sweep runs against prod's default branch, so it spends prod's own budget and its rows land in prod's data. The cleanup between steps is what keeps that bounded instead of accumulating.

### Cloudflare

The public path has two external dependencies I do not own: the tunnel that exists because of CGNAT, and Cloudflare's bot protection, which on Free cannot be skipped — the only lever is an IP Access rule, and any IP Access rule disables BFM zone-wide, not just for the runner. So I just simplified my Architecture, just using Tailscale for connection of load machine and application machine. While using cloudflare could measure PROD like latency, the plan itself was just really touching on SRE principles rather than focusing on what real users feel.

## Tools

### The app

| Layer           | What                                                               |
| --------------- | ------------------------------------------------------------------ |
| Runtime         | Python 3.13, FastAPI                                               |
| uvicorn workers | 1, the Dockerfile passes no `--workers`                            |
| Data            | asyncpg against Postgres, yoyo for migrations                      |
| Logging         | structlog, one JSON access line per request                        |
| Telemetry       | OpenTelemetry SDK, OTLP over HTTP to the in-cluster collector      |
| Rate limiting   | limits, in-process memory storage, no redis for now                |
| Frontend        | React 19, Vite, TypeScript, Tailwind, Clerk React, axios, recharts |

### The experiment

| Purpose               | Tool                                                |
| --------------------- | --------------------------------------------------- |
| Load generation       | k6, on the Windows box                              |
| Private path          | Tailscale                                           |
| Orchestration         | k3s, ingress-nginx, Argo CD, Kustomize              |
| Metrics, logs, traces | Grafana Cloud, with Alloy as the in-cluster shipper |
| Database              | Neon, prod's default branch, direct host            |

## Perf window

| Change          | Value        |
| --------------- | ------------ |
| `LLM_BASE_URL`  | unset (stub) |
| `RATE_LIMIT`    | `off`        |
| `CLERK_ENABLED` | `false`      |
| `APP_ENV`       | `test`       |

Opening the window is four steps: commit the perf values, see the sync land, confirm the pod was replaced, and read its env to watch the perf values go live before any load.

Closing it is the same four mirrored, and it is not closed until all of them hold. The last is `POST /api/billing/webhook/simulate` answering 404, which is the reason the check exists at all: a revert that reports success while that route still answers has left an unauthenticated endpoint that grants entitlement reachable on the public path.

The sweep runs as its own identity. `DEV_USER_SUB` names it and `auth.py` reads it, so the run holds its own interviews and its own `turn_usage` row instead of moving `dev-user`'s. Prod's dev rows and that account's daily turn counter stay where they are, and the cleanup deletes a set of rows that is known to be the sweep's.

## What one virtual user does

Every virtual user is the same identity and they all share one account.

A virtual user drives the app the way a person would. It creates an interview, answers it, finishes it, reads the review, then moves on to whatever else the app offers. Any endpoint a signed-in user can reach is in scope, so this measures the app's surface and not one route.

The number of turns is a structured but randomized actions run per VU, with each going through thinking to simulate how a real user would behave.

Exclusions, for different reasons.

NvidiaNIM(Stubbed) and Voice is out. Outside Generation, vendor that could fail the experiment due to free tier and rate limits.

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

The ladder is 10, 25, 50, 100, 200 and 400 VUs. The first four are validation rather than search: they cost almost nothing, and they are where a broken workload, a broken generator or an already-violated gate turns up before the interesting region. The last two are the search, and the pool of ten is the expected wall near the top. The first failing step brackets the answer, the ladder bisects that interval until we find the appropriate pass, if 200 pass and 400 fail then go 300, and so on with self explanatory methods.

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
- The baseline run itself, which produces every SLO gate.
