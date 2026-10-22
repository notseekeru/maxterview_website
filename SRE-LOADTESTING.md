# SRE

Minimal SRE path for loading metrics and load testing application by generating randomized structured request with k6

Inspired by Arjay McCandless $12 VPS load testing videos, usually known for system design with informative detailed videos.

## The question

At what load does the prod deployment stop behaving acceptably, and which resource runs out first.

## Pipeline flow

One sweep, window open to boundary. Each measure box writes one CSV row per run, tagged with its phase.

```
gitops overlay opens the window    NodePort 30090 on the backend Service
        |
cleanup        delete every row the sweep identity owns            -> deleted_before
        |
ramp 30s, warm 60s     neither enters a gate
        |
measure 3 min          the only window that counts                 -> phase=ladder
        |
gates                  SLO
        |
        +-- pass, rungs left: double the VUs, repeat
        +-- pass at 800 VUs: stop and raise --max-vus, no confirmation
        +-- fail on the first rung: abort, then --only 10 tells harness from app
        +-- fail above it: binary search the gap                  -> phase=search
                              |
                    confirm the highest passing rung 3 times,
                    measure 5 min each, all three must pass        -> phase=confirm
                              |
                    any run fails: search below it and confirm
                    again, at most three confirmation phases
                              |
                    boundary, from the CSV and Grafana
                              |
                    close the window, then --cleanup-only
```

The gap and the cleanup between two boxes, and why they stay at 60 seconds, are in Between steps.

## What is measured

| Indicator         | Source                                                                                                      | Carries               |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | --------------------- |
| Request latency   | `http.server.request.duration`, and k6 on the client side                                                   | method, route, status |
| Error rate        | the same histogram, plus k6 broken down by status code                                                      | status                |
| Throughput        | k6 RPS, and the server histogram's own sample count                                                         | route                 |
| Database pressure | `db.pool.size` against `db.pool.idle`, a pool of 10                                                         | connections held      |
| Saturation        | `container_*` from the kubelet, root cgroup for the node and pod cgroups for pods; `machine_*` for capacity |                       |
| Architecture      | Architecture of machine/optimization framework or tools used                                                | baseline              |

## SLO

| Indicator   | Gate           |
| ----------- | -------------- |
| p50 latency | none, reported |
| throughput  | none, reported |
| p95 latency | <1s            |
| p99 latency | <5s            |
| error rate  | <1%            |
| correctness | check pass     |

The latency gates cover the app-owned routes. The model-bearing ones are excluded, the same set the alert rules exclude: `chat/stream`, `chat/kickoff`, `feedback/generate`, `voice/stt`, `voice/tts`, and `finish`, which runs the whole feedback pipeline inside the request rather than returning a read.

established my baseline of acceptable for this particular architecture since latency can be dependent on programming language and the framework it's using, this is much more important than it seem especially if were testing application performance.

p50 is there for reporting, no gate added since it can be considered redundant since p95 would fail first, but for the sake it, i just added p50 latency.

Throughput is reported, not gated. A level fixes the VUs and the think time, so RPS falls out of the app's own latency rather than setting it: a gate would fail a level for answering slowly, which p95 and p99 already fail. It stays the number the boundary is recorded in, next to the user estimate.

## Architecture

One path, ending in the same pod.

```
Capacity path
  k6 (desktop or laptop) -> Tailscale -> ingress-nginx -> pod
  pod -> Neon (direct host, TLS)
  pod -> Alloy (in-cluster) -> Grafana Cloud
```

## Configuration

### Load generator(The one who runs k6)

The desktop is the box the plan was written against; the laptop is the second one, measured doing it.

| Component  | Desktop                                                                                                                    | Laptop                                      |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| CPU        | AMD Ryzen 5 3600 (6 cores / 12 threads)                                                                                    | Intel i7-10610U (4 cores / 8 threads, 15 W) |
| RAM        | 32 GB                                                                                                                      | 16 GB                                       |
| Monitoring | Lightweight/manual monitoring initially; observe CPU, memory, and k6 process behavior if generator saturation is suspected | Same                                        |

Windows machine is the load generating machine and so is the laptop, which could minimally be monitored by myself, though it isnt systematic, that would be enough for my purpose of the test since we dont really expect the load generating machine to saturate much. Focus on the application you're about to load not overcomplicate by other concerns, though we could use something like csv metrics.

The laptop measured about a quarter of one core at 240 RPS, 1.15 CPU-seconds per 1,000 requests, on the same workload the ladder runs. Neither box is the expected ceiling.

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
| DB pool                  | `DB_POOL_MAX`, `min_size=0`                             |
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
| Load generation       | k6, on the desktop or the laptop                                                   |
| Private path          | Tailscale                                                                          |
| Orchestration         | k3s, ingress-nginx, Argo CD, Kustomize                                             |
| Metrics, logs, traces | Grafana Cloud, with Alloy as the in-cluster shipper                                |
| Harness               | `~/k6-load-testing`: `main.js` the workload, `sweep.py` the ladder and the cleanup |
| Database              | Neon, prod's default branch, direct host                                           |

## Neon

At first, I considered running this test on a PVC Postgres Pod in my K3s cluster. Even though it's not directly equivalent to production (for example, the round-trip latency from my backend to Neon's servers, which is not that significant at my scale), I was worried my free tier limit on Neon would block me from generating all these requests. However, I did some numbers and realized that Neon’s free tier limits are actually generous enough to handle my test volume without hitting any storage or compute caps.

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

| Operation                                        | Type         | When          | Count     |
| ------------------------------------------------ | ------------ | ------------- | --------- |
| Interview row read + attached resume             | Read         | Every turn    | 1         |
| Transcript read                                  | Read         | Every turn    | 1         |
| User message insert                              | Write        | Every turn    | 1         |
| Turn credit read + upsert                        | Read + write | Every turn    | 1         |
| Assistant reply insert                           | Write        | Every turn    | 1         |
| Trailing-user-turn repair: delete the stale turn | Write        | Sometimes     | 0 or 1    |
| Interview insert                                 | Write        | Run start     | 1 per run |
| Interview status update                          | Write        | Start, finish | 2 per run |
| Feedback transcript + dials read                 | Read         | Run end       | 2 per run |
| Feedback upsert                                  | Write        | Run end       | 1 per run |

The two reads at every turn are both `_chat_session`: the interview with its resume text, and the whole transcript, so the transcript read grows with the run and is re-paid on every turn rather than once at session open.

| Request                                                           | Phase         |
| ----------------------------------------------------------------- | ------------- |
| `POST /interviews`                                                | Run start     |
| `POST /interviews/{id}/start`                                     | Run start     |
| `POST /interviews/{id}/chat/kickoff`                              | Opener        |
| `POST /interviews/{id}/chat/stream`                               | Every turn    |
| `POST /interviews/{id}/finish`                                    | Run end       |
| `GET /interviews/{id}/feedback`                                   | Run end       |
| `GET /interviews/{id}/messages`                                   | Run end       |
| `GET /interviews`, `/stats/dimensions`, `/stats/analytics`        | After the run |
| `GET /usage`, `/templates`, `/resumes`, `/settings/llm`, `/voice` | After the run |
| `GET /interviews/{id}/offer`                                      | After the run |
| `POST` and `DELETE /interviews/{id}/archive`                      | After the run |
| `POST /resumes`, `POST /templates`, each deleted in the same run  | After the run |
| `POST /client-errors`                                             | After the run |

Three of those rows are model-bearing, `chat/kickoff`, `chat/stream` and `finish`, and they are the
rows the latency gates exclude; the gates cover the rest.

Every virtual user is the same identity and they all share one account.

The number of turns is a structured but randomized actions run per VU, with each going through thinking to simulate how a real user would behave. The random count is drawn against the run's own plan: the chitchat, behavioural and technical mix dials set how many questions the interviewer will ask, so a VU stops at the last planned question instead of asking past it and collecting a refusal.

Exclusions, for different reasons.

Hardcore stays off in the loop. A run that fails the judge refuses every later turn, so it would end early for a reason that has nothing to do with capacity, and the turns after it would arrive as refusals rather than as load.

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

The reads that scale with history are in the loop, so the loop's own writes change them. GET /api/interviews returns every run for the owner with no limit, and the stats endpoints re-scan the full history.

The first draft left pagination and Redis out, to stay close to the current unoptimized architecture. But on second thought I opt in the pagination goes in, first and foremost without coupling it to Redis or any more optimization strategies. A LIMIT and OFFSET is a minimal change to the query itself, not a dependency to run, so it comes before anything else is added or measured. The list is paginated, so the sweeps in `## Result` measured the unpaginated architecture and a re-run measures a different one.

I'll still measure without pagination first, since it should fail at a lower VU count than the paginated version would. The cost is low because the unpaginated run is the first one you hit, and the difference against the paginated run is the result. The two are separate runs with separate data, since they are different architectures.

Redis stays out: it is a different tier, a second compute and a cache to invalidate, and does not belong in the same step as a LIMIT.

## Between steps

A sweep is the whole experiment: warm the database, climb the ladder, bracket the failure, binary search, confirm, and record the boundary for estimated max users per relative to RPS. A step is one level inside it. The sweep is automated end to end, so there are no human gaps between steps. That matters here, because let's say I forgetting to actually run the test for a certain period, it will eventually close because theres no one using the application. A gap long enough would let the asyncpg pool close its idle connections and Neon return to scale-to-zero, and the next step would pay the wake again before any number is taken.

So first, we warm the database. `min_size=0` means the first requests pay pool creation and a fresh TLS handshake, and Neon scale-to-zero means the first request after an idle gap pays the compute wake.

Then every step is a ramp to the target VUs, then a 3 minute measurement window. Only the window counts. After it, a 60 second gap separates this step from the next: 15 seconds of
silence, up to 30 seconds of cleanup, 15 seconds of silence again. 60 seconds stays well inside asyncpg's idle close and Neon's scale-to-zero, so the gap costs neither the pool nor the wake of our cloud database.

The cleanup deletes the k6 identity's account, so every run starts from the same empty account. That deleting happens for 30 seconds which would be all more plenty of time to delete all that data relevant to our k6 account, and a cleanup that runs out of that budget aborts the sweep instead of letting the next window read a bigger account than the last. The row count is recorded at window start and at window end, so intra-window drift is reported rather than assumed.

The database is warmed once before the first step, so pool creation and the Neon wake we already paid before any number is taken.

We start at 100 VUs and double from there. This is first level where we are checking and warming up: initialize our database, a smoke test for an app or a generator that was already broken before the load got high.

If the first rung fails, the sweep aborts instead of searching, since a failure at that low a number is
the harness or the app rather than load. Rerun the same workload at 10 VUs to see which.

Each level passes or fails. If it passes, we go up. If it fails on an SLO, we stop going up, but the run keeps going. That failure becomes the top of the range, and we split the gap between the last pass and that failure to find the highest level that still passes. If 200 passes and 400 fails, try 300; if 300 passes, try 350. That is a binary search. We only need the boundary between pass and fail, not an exact number.

Confirm the highest passing level by re-running it 3 times, each measured for 5 minutes, and all three must pass. Since the boundary moves about 10%, a single pass is not proof. A failing run ends that phase at once and reopens the search between the level and the highest rung below it that passed, for at most three confirmation phases in total. If none of them reaches 3/3, the sweep stops unconfirmed.

## Result

Two sweeps against the prod pod, both closed with the sweep identity's rows deleted.

| Ladder | Boundary            | Confirmed                           | Failure                        |
| ------ | ------------------- | ----------------------------------- | ------------------------------ |
| 100    | level one           | none, the first rung aborts         | p95 3.44s, p99 8.54s, 38.3 rps |
| 10, 20 | 10 passes, 20 fails | 10, 3/3 over three 5 minute windows | p95 1.25s, p99 17.6s, 21.6 rps |

Ten to twenty VUs raises throughput 29% and doubles p95, so that is the knee.

Nothing is saturated at 20 VUs: 0.21 of 4 cores, 100Mi of 256Mi, pool wait p50 35ms. The gate fails on
tails: `/stats/analytics` 4.8s p95, `/templates` 3.8s, `/usage` 2.9s, about one request in nine. No
query passed 425ms at p95 or 2.12s at p99, so the tail is sequential round trips stacking, not one slow
statement.

At 100 VUs the shape changes: 80% of the 1.17s p50 is pool wait, p50 0.94s and p95 2.4s, while CPU
stays at 0.27 cores.

The tails above were taken before those routes dropped to one checkout per statement.

## Decisions

1. k3s only, no host run. I am keeping k8s, so host-versus-k3s had no decision attached. Rejected: the host run, which answers a question I am no longer asking.
2. The prod pod patched, not a second Deployment. On a single node a second pod fights the prod pod for the same four cores, so its number is not prod's number. Rejected: a parallel Deployment, which measures a pod no user will hit.
3. Prod's default branch, not a Neon branch. Every VU is one identity either way, so a branch would isolate rows and change nothing about contention, at the cost of a second compute and a Secret swap.
4. Use Tailscale instead of cloudflare due to BFM.
5. `APP_ENV=test` with Clerk off, and the simulate route left open. Both side effects accepted and recorded above. Rejected: staying on production with minted Clerk tokens, which keeps JWT verification in the measured path but makes Clerk a dependency of the sweep.
6. A full run per virtual user with a randomized turn count, plus any other endpoint a signed-in user can reach. Rejected: a fixed count, which makes every virtual user do identical work and has to be tuned to sit inside the arc.
7. Telemetry stays on and gets recorded as cost. Rejected: turning it off, which gives a cleaner app number at the price of the deployed configuration.
8. The model stubbed for the sweep. Rejected: real generation, where the ceiling is the provider's quota and not this one.
9. Direct host, not the pooler. A `-pooler` DSN flips `statement_cache_size`, a different code path than prod runs.
10. The sweep runs under its own identity, named by `DEV_USER_SUB`.
11. Capacity sweep at a small fixed floor; the unbounded read on its own N-sweep. Rejected: letting N grow inside the ladder, which conflates read cost with concurrency and makes a failure at 100 VUs unattributable.
