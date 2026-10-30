# SRE

A minimal SRE path for collecting metrics and benchmarking the application under load, by generating randomized structured requests with k6.

Benchmarking here means measuring the app against a stated bar, not guessing from a dashboard.

Inspired by Arjay McCandless's $12 VPS load testing videos, known for detailed, informative takes on system design.

The specification comes first, and the runs follow it in the order they happened.

## The question

At what load does the prod deployment stop behaving acceptably, and which resource runs out first?

## Vocabulary

| Term         | Meaning                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------- |
| benchmarking | measuring the app against a stated bar                                                         |
| VU           | one virtual user running one whole interview                                                   |
| sweep        | the whole experiment                                                                           |
| phase        | one stage of the sweep: smoke, ladder, search, confirm, or only for a one-level probe          |
| round        | historical: one old confirmation round: up to three 5 minute runs, repeated up to three times. |
| ladder       | the climb through levels; also the name of the phase that walks them                           |
| level        | one VU target in the ladder, with its ramp, hold, and measurement window                       |
| ladder step  | plain name for a level                                                                         |
| window       | the measured part of a level                                                                   |
| perf window  | the period the perf overlay is open                                                            |
| boundary     | the highest level that passes                                                                  |
| SLO          | the pass/fail bar                                                                              |
| p95 / p99    | latency at the 95th / 99th percentile                                                          |
| RPS          | requests per second                                                                            |

## Pipeline flow

One sweep, perf window open to boundary. Each measure box writes one CSV row per run, tagged with its phase.

```
gitops overlay opens the perf window    NodePort 30090 on the backend Service
        |
cleanup        delete every row the sweep identity owns            -> deleted_before
        |
measure 10s at 10 VUs  the harness check, before the first level          -> phase=smoke
        |
        +-- fail: abort the sweep, the harness or the app is broken
        |
ramp 30s, warm 60s     neither enters a gate
        |
measure 3 min          the only window that counts                 -> phase=ladder
        |
gates                  SLO
        |
        +-- pass, levels left: double the VUs, repeat
        +-- pass at 800 VUs: stop and raise --max-vus, no confirmation
        +-- fail: binary search the gap down to the 10 VU smoke    -> phase=search
                              |
                    confirm the highest passing level 3 times,
                    measure 5 min each, all three must pass        -> phase=confirm
                              |
                    any run fails: search below it and confirm
                    again, at most three confirmation rounds
                              |
                    boundary, from the CSV and Grafana
                              |
                    close the perf window, then --cleanup-only
```

The gap and the cleanup between two boxes, and why they stay at 60 seconds, are in Between levels.

## What is measured

| Indicator         | Source                                                                                                      | Carries               |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | --------------------- |
| Request latency   | `http.server.request.duration`, and k6 on the client side                                                   | method, route, status |
| Error rate        | the same histogram, plus k6 broken down by status code                                                      | status                |
| Throughput        | k6 RPS, and the server histogram's own sample count                                                         | route                 |
| Database pressure | `db.pool.size` against `db.pool.idle`, bounded by `DB_POOL_MAX`                                             | sampled at acquire    |
| Saturation        | `container_*` from the kubelet, root cgroup for the node and pod cgroups for pods; `machine_*` for capacity |                       |
| Architecture      | the machine, runtime, and tools used                                                                        | baseline              |

Server numbers are read as `increase` over the window that starts at `measure_start` and lasts
`measure_s`; an instant `rate` is a different number and is not used. The two pool gauges are emitted per
acquire, so they sample the pool at the moment a request takes a connection: occupancy is mean query
time times queries per second, not an average of those samples.

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

I set the pass bar for this architecture. Latency depends on the language and framework the app uses, and that matters when you compare runs.

p50 is there for reporting. No gate, since p95 would fail first, but I added it anyway.

Throughput is reported, not gated. A level fixes the VUs and the think time, so RPS falls out of the app's own latency rather than setting it: a gate would fail a level for answering slowly, which p95 and p99 already fail. It stays the number the boundary is recorded in, next to the user estimate.

## Architecture

One path, ending in the same pod.

```
Capacity path, as run
  k6 (desktop or laptop) -> Tailscale -> NodePort 30090 -> pod
  pod -> Neon (direct host, TLS)
  pod -> Alloy (in-cluster) -> Grafana Cloud
```

The NodePort sits on the backend Service, so every prod row measures the pod, the app and its database,
with ingress-nginx, the tunnel and Cloudflare outside the number.

## Configuration

### Load generator (the machine that runs k6)

The desktop is the machine the plan was written against. The laptop is the second one, and the machine measured running the load.

| Component  | Desktop                                                        | Laptop                                      |
| ---------- | -------------------------------------------------------------- | ------------------------------------------- |
| CPU        | AMD Ryzen 5 3600 (6 cores / 12 threads)                        | Intel i7-10610U (4 cores / 8 threads, 15 W) |
| RAM        | 32 GB                                                          | 16 GB                                       |
| Monitoring | Manual. Watch CPU, memory, and k6 when saturation is suspected | Same                                        |

The Windows desktop and the laptop both generate load. I watch them minimally, which is enough here: neither is expected to saturate. The app under load is the thing to watch, though CSV metrics would be an option.

The laptop measured about a quarter of one core at 240 RPS, 1.15 CPU-seconds per 1,000 requests, on the same workload the ladder runs. Neither box is the expected ceiling.

If the generator reaches sustained CPU or memory pressure, or cannot hold the intended VU load, the measured ceiling may be the generator, not the app.

### The box (the machine under test)

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

| Limit                    | Value                                                         |
| ------------------------ | ------------------------------------------------------------- |
| DB pool                  | `DB_POOL_MAX`, `min_size=0`                                   |
| app rate limit           | 120/minute per client IP by default, `off` in the perf window |
| templates                | 20, a module constant                                         |
| resume parse concurrency | 2                                                             |
| feedback attempts        | 3 attempts, 800ms apart                                       |

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

At first I considered running this test on a PVC Postgres pod in my K3s cluster. It is not directly equivalent to production: the round-trip latency from my backend to Neon's servers disappears, though that is not significant at my scale. I was worried the Neon free tier would block the request volume. I did the numbers, and the free tier is generous enough for this test without hitting storage or compute caps.

The sweep runs against prod's default branch, so it spends prod's own budget and its rows land in prod's data. The cleanup between levels is what keeps that bounded instead of accumulating.

It uses scale-to-zero so we don't pay for compute when the application is not used. That has tradeoffs like cold starts, but at this scale I decided to leave it alone, since we warm the Neon database anyway.

## Perf window

| Change                                    | Value        |
| ----------------------------------------- | ------------ |
| `LLM_BASE_URL`                            | unset (stub) |
| `RATE_LIMIT`                              | `off`        |
| `CLERK_ENABLED`                           | `false`      |
| `APP_ENV`                                 | `test`       |
| `nginx.ingress.kubernetes.io/limit-rps`   | `1000000`    |
| `nginx.ingress.kubernetes.io/limit-burst` | `1000000`    |

It is simple: change the values, commit the perf overlay, see the sync land in Argo CD, confirm the pod was replaced with kubectl or the GUI, and read its env to watch the perf values go live before any load. Overlays override Infisical values like `LLM_BASE_URL`.

## What each VU does

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

| Request                                                                        | Run stage     |
| ------------------------------------------------------------------------------ | ------------- |
| `POST /interviews`                                                             | Run start     |
| `POST /interviews/{id}/start`                                                  | Run start     |
| `POST /interviews/{id}/chat/kickoff`                                           | Opener        |
| `POST /interviews/{id}/chat/stream`                                            | Every turn    |
| `POST /interviews/{id}/finish`                                                 | Run end       |
| `GET /interviews/{id}/feedback`                                                | Run end       |
| `GET /interviews/{id}/messages`                                                | Run end       |
| `GET /interviews`, `/stats/dimensions`, `/stats/analytics`, `/stats/dashboard` | After the run |
| `GET /usage`, `/templates`, `/resumes`, `/settings/llm`, `/voice`              | After the run |
| `GET /interviews/{id}/offer`                                                   | After the run |
| `POST` and `DELETE /interviews/{id}/archive`                                   | After the run |
| `POST /resumes`, `POST /templates`, each deleted in the same run               | After the run |
| `POST /client-errors`                                                          | After the run |

Three of those rows are model-bearing, `chat/kickoff`, `chat/stream` and `finish`, and they are the
rows the latency gates exclude; the gates cover the rest.

The mix, measured over the 55 VU window of the pool-80 run: 13,635 requests and 31,572 queries in three
minutes, 2.3 queries per request and about 27 requests per iteration.

| Sent           | Count  | Share |
| -------------- | ------ | ----- |
| GET request    | 6,230  | 46%   |
| POST request   | 5,884  | 43%   |
| DELETE request | 1,521  | 11%   |
| SELECT         | 17,210 | 55%   |
| INSERT         | 9,269  | 29%   |
| UPDATE         | 2,527  | 8%    |
| DELETE query   | 1,008  | 3%    |
| WITH           | 1,558  | 5%    |

`WITH` is the first keyword of both the interview insert and the stats aggregates, so it is not cleanly
one side: SELECT is the read side, INSERT, UPDATE and DELETE the write side.

Every virtual user is the same identity and they all share one account. One identity is the first cut
because it is one candidate moving through the app, and the cleanup has one owner to delete. A real
deployment is many people at once, so the next architecture will give different VUs different identities, measured separately as well.
That also changes two things: each owner's history stays small instead of growing with the whole perf window, and the cleanup has to delete a set of owners. It puts authentication back in the measured path too, since one `DEV_USER_SUB` is what makes the shared account possible.

The number of turns per VU is randomized but follows the run's own plan, with a think time to simulate a real user: the depth dial sets how many phases and questions the interviewer will ask, so a VU stops at the last planned question instead of asking past it and collecting a refusal.

Exclusions, for different reasons.

Hardcore stays off in the workload. A run that fails the judge refuses every later turn, so it would end early for a reason that has nothing to do with capacity, and the turns after it would arrive as refusals rather than as load.

NvidiaNIM (LLM output) and Cloudflare Workers AI (voice) are out. These vendors use credit and would only limit the workload, which is why NvidiaNIM is stubbed and Cloudflare Workers AI is off. They are outside generation: vendors that could fail the experiment on free-tier and rate limits.

For edge tunneling, the tunnel exists because of CGNAT, and Cloudflare's bot protection on Free cannot be skipped: the only lever is an IP Access rule, and any IP Access rule disables BFM zone-wide, not just for the runner. So I simplified the architecture and used Tailscale to connect the load machine and the application machine. Cloudflare could measure production-like latency, but the plan was about SRE principles rather than what real users feel.

PDF import is out of the workload. `PLAN.md` has the measurement: a 40MB `/Contents` peaks 1.74GB for zero characters of text against a 256Mi pod limit, so one upload can OOMKill the only replica. That would read as a capacity failure when it is a known unfixed bug, and it is its own piece of work.

## Correctness (k6 checks)

Latency says nothing about whether the app worked, so each iteration checks, as k6 checks, that a failure lands in the same report as the timings.

- the interview was created and came back with an id
- the opener streamed and ended with `done`
- every answer streamed and ended with `done`
- the transcript holds one assistant reply per user turn, so a dropped or duplicated turn fails the run
- `finish` returned the completed status
- `GET /feedback` returned a review for that run

A sweep that passes on latency while any of those is false is not a pass.

The stub is read at import, so a pod that never restarted is a perf window that never opened.

## What the reads cost

The reads that scale with history are in the loop, so the loop's own writes change them. GET /api/interviews returned every run for the owner with no limit, and the stats endpoints re-scan the full history.

The first draft left pagination and Redis out, to stay close to the current unoptimized architecture. But on second thought I opted in: pagination goes in, first and foremost without coupling it to Redis or any other optimization strategy. A LIMIT and OFFSET is a minimal change to the query itself, not a dependency to run, so it comes before anything else is added or measured. The list is paginated from the optimized sweep on, so the baseline rows measured the unpaginated architecture and the optimized rows did not.

Redis stays out: it is a different tier, a second compute and a cache to invalidate, and does not belong in the same change as a LIMIT.

## Between levels

A sweep is the whole experiment: warm the database, climb the ladder, bracket the failure, binary search, confirm, and record the boundary for estimated max users relative to RPS. A level is one VU target inside it. The sweep is automated end to end, so there are no human gaps between levels. That matters here: if I leave the app idle long enough, the asyncpg pool closes its idle connections and Neon returns to scale-to-zero, and the next level pays the wake before any number is taken.

So first, we warm the database. `min_size=0` means the first requests pay pool creation and a fresh TLS handshake, and Neon scale-to-zero means the first request after an idle gap pays the compute wake.

Then every level is a 30 second ramp to the target VUs and a 60 second hold at them, neither of which
enters a gate, then a 3 minute measurement window. Only the window counts. After it, a 60 second gap separates this level from the next: 15 seconds of
silence, up to 30 seconds of cleanup, 15 seconds of silence again. 60 seconds stays well inside asyncpg's idle close and Neon's scale-to-zero, so the gap costs neither the pool nor the wake of our cloud database.

The cleanup deletes the k6 identity's rows, so every run starts from the same empty account. That deletion runs for 30 seconds, more than enough time to delete all the data relevant to our k6 account, and a cleanup that runs out of that budget aborts the sweep instead of letting the next level read a bigger account than the last. The cleanup's delete count is recorded as `deleted_before` and the owner's row count after the window as `rows_after`, so the account's growth within the window is reported rather than assumed.

The sweep opens with a 10 VU smoke on the same workload, with a 10 second window. It warms the pool and
the Neon compute, and it is the harness check: a failure there is the app or the generator, not load.
The smoke is not optional, and a failed smoke aborts the sweep before the first level.

Then the ladder starts at the 100 VU level and doubles. A failed level is the boundary rather than a broken
harness, because the smoke already cleared that. The search runs between the last pass and the failure,
and it can go as low as the smoke's 10 VUs when the 100 VU level fails.

Each level passes or fails. If it passes, we go up. If it fails on an SLO, we stop going up, but the run keeps going. That failure becomes the top of the range, and we split the gap between the last pass and that failure to find the highest level that still passes. If 200 passes and 400 fails, try 300; if 300 passes, try 350. That is a binary search. We only need the boundary between pass and fail, not an exact number.

Confirm the highest passing level by re-running it 3 times, each measured for 5 minutes, and all three must pass. Since the boundary moves about 10%, a single pass is not proof. A failing run ends that round at once and reopens the search between the level and the highest level below it that passed, for at most three confirmation rounds in total. If none of them reaches 3/3, the sweep stops unconfirmed.

## Decisions

1. k3s only, no host run. I am keeping k8s, so host-versus-k3s had no decision attached. Rejected: the host run, which answers a question I am no longer asking.
2. The prod pod patched, not a second Deployment. On a single node a second pod fights the prod pod for the same four cores, so its number is not prod's number. Rejected: a parallel Deployment, which measures a pod no user will hit.
3. Prod's default branch, not a Neon branch. Every VU is one identity either way, so a branch would isolate rows and change nothing about contention, at the cost of a second compute and a Secret swap.
4. Use Tailscale instead of Cloudflare due to BFM.
5. `APP_ENV=test` with Clerk off, and the simulate route left open. Both side effects accepted and recorded above. Rejected: staying on production with minted Clerk tokens, which keeps JWT verification in the measured path but makes Clerk a dependency of the sweep.
6. A full run per virtual user with a randomized turn count, plus any other endpoint a signed-in user can reach. Rejected: a fixed count, which makes every virtual user do identical work and has to be tuned to sit inside the arc.
7. Telemetry stays on and gets recorded as cost. Rejected: turning it off, which gives a cleaner app number at the price of the deployed configuration.
8. The model stubbed for the sweep. Rejected: real generation, where the ceiling is the provider's quota and not this one.
9. Direct host, not the pooler. A `-pooler` DSN flips `statement_cache_size`, a different code path than prod runs.
10. The sweep runs under its own identity, named by `DEV_USER_SUB`.
11. Capacity sweep at a small fixed floor, and the unbounded read on its own N-sweep. N grew inside every window anyway (159 rows at 10 VUs, 415 at 100), because the cleanup runs between levels. The read never surfaced in the slow end, the 100 VU failure was attributed to pool wait without an N-sweep, and pagination shipped on code grounds. The N-sweep is still unrun.

# The runs

## The first run

The table below is the application before any optimisation, with the pool at 10 and the NodePort path,
read from `results/sweep-*.csv`. Latency, rps and errors come from the harness; CPU, memory, pool wait,
the per-route and the per-query numbers are Grafana readings over the same windows. The laptop row is
docker compose against the stub; the rest are the prod pod, which is read from those latencies because
the harness records no target. `max` is the measure window's max latency: k6's summary does not export p(99) for these runs, so
the harness recorded the max while the gate evaluated a real p99 inside k6. The harness exports p(99)
now, so every sweep after the baseline carries both.

| Pod          | Phase   | VUs | Window | p50   | p95    | max   | rps  | Verdict |
| ------------ | ------- | --- | ------ | ----- | ------ | ----- | ---- | ------- |
| laptop, stub | only    | 10  | 10s    | 2.4ms | 11.6ms | 288ms | 54.0 | pass    |
| prod         | only    | 10  | 10s    | 155ms | 705ms  | 933ms | 25.6 | pass    |
| prod         | ladder  | 100 | 3m     | 1.17s | 3.44s  | 8.54s | 38.3 | fail    |
| prod         | ladder  | 10  | 3m     | 155ms | 654ms  | 2.80s | 16.7 | pass    |
| prod         | ladder  | 20  | 3m     | 205ms | 1.25s  | 17.6s | 21.6 | fail    |
| prod         | confirm | 10  | 5m     | 149ms | 587ms  | 3.00s | 16.9 | pass    |
| prod         | confirm | 10  | 5m     | 149ms | 569ms  | 1.38s | 16.7 | pass    |
| prod         | confirm | 10  | 5m     | 147ms | 496ms  | 2.01s | 17.4 | pass    |

Ten to twenty VUs raises throughput 29% and doubles p95, so that is the knee.

Nothing is saturated at 20 VUs: 0.21 of 4 cores, 100Mi of 256Mi, pool wait p50 35ms. The gate fails on
the slow end: `/stats/analytics` 4.8s p95, `/templates` 3.8s, `/usage` 2.9s, about one request in nine. No
query passed 425ms at p95 or 2.12s at p99, so the slow end is sequential round trips stacking, not one slow
statement.

At 100 VUs the shape changes: p50 1.17s, of which 0.94s is pool wait, and pool wait p95 is 2.4s against
3.44s end to end. CPU stays at 0.27 cores.

## What I did not expect

I actually ran the same workload on the laptop first, docker compose with the stub model, and it passed
at 100 VUs. So I went into the prod run expecting the number to be somewhere in the hundreds, and it
failed on the first level instead: p95 3.44s and a max of 8.54s at 100 VUs, and an error rate of zero.
The part that surprised me is that the machine was pretty much idle while it failed, 0.27 of 4 cores
and 134Mi of 256Mi. Nothing was out of CPU or memory, so the latency was not a resource running out.

I did not notice the missing p99 until I looked for it. When I asked my AI to code the harness from my
spec, it exported max but not p99. That is still my fault. The gate itself used a real p99 inside k6, so
the runs did not lose the gate, only the number. I fixed the export, and every run after the baseline
carries p99.

At 100 VUs the pool was the queue: p50 1.17s, and 0.94s of that was wait for a connection that was not
doing anything yet. That is where I got worried, because 10 was a default I had set and not a number I
had found.

So I dropped to 10 VUs, expecting to find something wrong with the k6 harness. It passed, three times
over three 5 minute windows, so the harness was clean and the application was the thing. The 100 VU run
had already finished 348 iterations with every check passing, which I did not read that way at the time.
The next level up failed at 20 VUs with a max of 17.6s, and no single statement explained it, since the
slowest query stayed under 2.12s at p99. The routes that failed were the ones that pay several round trips in a row:
`/stats/analytics` at 4.8s p95 across five sequential queries, `/templates` at 3.8s with a seed write
before its read, `/usage` at 2.9s across two. The queries were not slow, they were stacked, one behind
another, and every one of them was its own checkout from a pool of ten.

The run also showed two things that are not latency numbers. The list read every run the owner had,
with no limit, and the account grew inside every window: 159 rows at 10 VUs, 241 at 20, 415 at 100.
That is a code gap rather than a measured slow end. The list route was never the slowest one in the report,
but it is the read whose cost rises with history. And there is no cache anywhere in this path, which I
left out on purpose. A cache is not a quick drop in, and if I had added it before the first run I would
not know what the app does without it.

I also read that first-level failure as the harness or the app, not load. That was wrong. 100 VUs was not
a low number for this app, it was five to ten times above where it stops, so the failure was the
boundary, not a broken run.

That is why this run exists in this shape. I wanted the numbers for the application on the day I planned
this, before any of the optimisation, so that every later state has its own data and the difference is
what the optimisation is actually worth.

## What the run taught me about the harness

I skipped the manual smoke that time and went straight to the ladder, which turned a sixteen second
check into a five minute failed level. The 100 VU failure in the first sweep had already told me the old
rule was wrong: it was capacity, not a broken harness.

And from here on out we smoke 10 VUs first, so we catch what's wrong before the 100 VU ladder starts.

The harness enforces it now: the smoke is the sweep's first phase, it aborts before the first level, and its
result is the floor the search can reach when the 100 VU level fails.

## What changed after the first runs

Six changes, all of them on round trips, read size or the pool rather than on the queries themselves.

| Change             | Before                                             | After                                        |
| ------------------ | -------------------------------------------------- | -------------------------------------------- |
| `/stats/analytics` | five checkouts                                     | one statement                                |
| `/templates`       | a seed write, then the read                        | the read, seeded only when the list is empty |
| `/usage`           | two checkouts in the window, three to four in prod | one                                          |
| `GET /interviews`  | every run the owner had                            | 50 per page, archived filtered in the query  |
| Home counters      | derived in the browser from that full list         | one statement over the full history          |
| pool               | 10                                                 | `DB_POOL_MAX`, 20 then 40                    |

## The optimized sweep

Same workload, same target, the image with the six changes and the analytics fix, pool 20, over the
NodePort. The smoke passed at a 239ms p95, the ladder failed at its first level, and the search put the
boundary between 32 and 55. The `probe` row is the 32 VU re-run from the next section, not a window of
this sweep.

| Phase   | VUs | Window | Verdict | p50   | p95   | p99   | max   | rps  | errors |
| ------- | --- | ------ | ------- | ----- | ----- | ----- | ----- | ---- | ------ |
| smoke   | 10  | 10s    | pass    | 145ms | 239ms | 750ms | 769ms | 29.5 | 0      |
| ladder  | 100 | 3m     | fail    | 719ms | 1.90s | 3.26s | 27.0s | 54.9 | 0.08%  |
| search  | 55  | 3m     | fail    | 353ms | 1.10s | 2.48s | 28.6s | 50.0 | 0.36%  |
| search  | 32  | 3m     | pass    | 163ms | 499ms | 879ms | 2.23s | 50.2 | 0      |
| confirm | 32  | 5m     | fail    | 173ms | 600ms | 1.14s | 8.99s | 45.4 | 0.08%  |
| confirm | 10  | 5m     | pass    | 146ms | 289ms | 427ms | 577ms | 18.5 | 0      |
| confirm | 10  | 5m     | pass    | 145ms | 287ms | 416ms | 864ms | 18.5 | 0      |
| confirm | 10  | 5m     | pass    | 161ms | 800ms | 2.86s | 19.6s | 12.8 | 0      |
| probe   | 32  | 3m     | pass    | 166ms | 558ms | 888ms | 1.75s | 50.1 | 0      |

Against the baseline, 100 VUs now carries 54.9 rps instead of 38.3, with p50 719ms instead of 1.17s and
p95 1.90s instead of 3.44s. The highest level that passes moved from 10 to 32, and the first level that
fails moved from 20 to 55. The slow end did not improve: the max at 100 VUs went from 8.54s to 27s, and the
last 10 VU confirmation saw 19.6s.

## What is the bottleneck now

The sweep above ran with the pool at 20, and at 20 the pool was the wall. Each row is read as an
`increase` over the 3 minute measure window: mean query time times queries per second is the number of
queries in flight, and the wait is the other half of the request.

| Window (pool 20) | Mean query | Queries/s | In flight | Pool wait p50 | Pool wait p95 | CPU  | Memory |
| ---------------- | ---------- | --------- | --------- | ------------- | ------------- | ---- | ------ |
| 32 VUs           | 97ms       | 114       | 11.1      | 6ms           | 45ms          | 0.39 | 48%    |
| 55 VUs           | 112ms      | 121       | 13.6      | 170ms         | 491ms         | 0.41 | 48%    |
| 100 VUs          | 116ms      | 116       | 13.5      | 505ms         | 1.31s         | 0.38 | 44%    |

At 32 VUs nothing waits on the pool, and the latency is the round trips: 2.3 queries per request at about
100ms each. `/stats/analytics` is still the slowest app-owned route at 1.41s p95, then `/messages` at
0.7s. The rest of the slow end is model routes, which the gate excludes but the pool still serves.

At 55 VUs every route multiplies: analytics 1.41s to 7.75s, messages 0.7s to 5.08s, finish 3.46s to
14.2s. That is the pool of 20 running out, not the app work changing. At 100 VUs the wait is most of the
request: 505ms of a 719ms p50, and 1.31s of a 1.90s p95. The mean query stays flat, 97 to 116ms across
the three windows, so the database's service time is not what changes; the wait is, from 6ms to 505ms at
p50. The pool gauge reads 20 held and 0 idle, but it is emitted on each acquire, so it samples the pool at
the moment a request asks for a connection. The time average is 13.5 queries in flight, and the queue
still forms because a request's two or three queries arrive in a burst.

CPU stays near a tenth of the four cores and memory near half of 256Mi in all three windows, so neither
is the ceiling.

## The pool probes

Same build, same NodePort path, same workload as the optimized sweep; only the pool changed. `p95`, `rps`
and the verdict are k6's; the rest are Grafana over the measure window. The 40 VU rows predate
`measure_start`, so their Grafana columns were aligned by hand.

| Pool | VUs | Verdict       | p95    | rps  | Wait p50 | Wait p95 | Query mean | Query p95 | CPU  | Memory |
| ---- | --- | ------------- | ------ | ---- | -------- | -------- | ---------- | --------- | ---- | ------ |
| 20   | 55  | fail          | 1.096s | 50.0 | 170ms    | 491ms    | 112ms      | 276ms     | 0.40 | 50%    |
| 20   | 100 | fail          | 1.90s  | 54.9 | 505ms    | 1.31s    | 116ms      | 360ms     | 0.39 | 46%    |
| 40   | 55  | pass          | 832ms  | 70.3 | 5ms      | 10ms     | 150ms      | 451ms     | 0.54 | 52%    |
| 40   | 100 | fail          | 1.64s  | 66.7 | 209ms    | 838ms    | 163ms      | 433ms     | 0.52 | 56%    |
| 80   | 55  | fail (checks) | 820ms  | 71.1 | 5ms      | 10ms     | 124ms      | 336ms     | 0.59 | 64%    |
| 80   | 100 | fail          | 1.87s  | 75.0 | 6ms      | 162ms    | 248ms      | 797ms     | 0.64 | 74%    |

Raising the pool was the largest single move after the six changes: 40 turned 55 VUs from a failure into
a pass and cut the wait at 100 VUs from 505ms to 209ms. At 80 the wait all but disappears at 100 VUs,
6ms at p50 against 209ms, but the queries themselves slow down: the mean query goes from 163ms to 248ms
and the p95 from 433ms to 797ms. The request p95 ends up worse, 1.87s against 1.64s, and memory goes from
56% to 74% of the 256Mi limit.

That is why 80 is flat at p50 and slower at p95: no one waits for a connection, but every query runs
against a busier Neon. A request that pays two or three queries at the p95 lands near two seconds with no
queue at all.

So 40 ships. The extra 40 connections bought 12% more rps (66.7 to 75.0), a worse swing, and about 50MB less
headroom on a single replica with no autoscaler. The pod's memory is what caps the pool, and Neon's
compute is what inflates as the pool grows.

The options left are Neon's compute size, the query count on the chat turn, and the analytics history
scan that survives the one-statement rewrite. The pool is not one of them at 100 VUs any more.

Pool capacity is connections over mean query time: at 100 VUs, 20 gives 172 queries a second, 40 gives
245, 80 gives 323. The pool keeps adding capacity, but each doubling also raises the query mean there,
116 to 163 to 248ms, so the gain shrinks to 43% and then 32%, and the swing and the memory pay for it.

At 55 VUs the extra connections have nothing to remove: 80 gives p95 820ms against 832ms at 40, rps 71.1
against 70.3, and memory 64% against 52%. The wait is already 5ms at 40, so the pool is not the
constraint there. That run's checks gate failed on one broken opener in 759 iterations, the same
transport flake as the 32 VU confirmation, not on latency.

A warm `SELECT 1` from inside the pod is 37ms at the median, and a first-row read is the same. The mean
query is 97ms at 32 VUs and 248ms at 100 with 80 connections, so the inflation is the database's own
service time under concurrency, not the round trip. Co-location could save the 37ms floor; it
cannot save the inflation.

55 VUs is the SLO boundary, not the product ceiling. The app keeps serving past it: at 100 VUs the error
rate stays under 1% and p99 is inside its gate, while p95 and the checks gate fail, the checks gate on 14
of 795 iterations that lost an answer stream.

| Level            | p95   | p99   | rps  | error | Gate        |
| ---------------- | ----- | ----- | ---- | ----- | ----------- |
| 55 VUs, pool 40  | 832ms | 1.62s | 70.3 | 0     | pass        |
| 100 VUs, pool 40 | 1.64s | 3.43s | 66.7 | 0.16% | p95, checks |

A VU is a whole interview compressed into about 21 seconds, so the capacity number is 70 requests a
second, not 55 real people.

## Dropped streams

Some windows lose a few chat streams: 56 in 7,794 iterations, 0.72%, but clustered, 29 in one 55 VU
window and 0 in another at the same level, so it does not follow VUs or pool. The failed requests left no
app log line when they were checked, so the drop is most likely on the sweep path (laptop, Tailscale,
NodePort), which production does not use. The checks gate is binary, so one drop can fail a level: it is
why 10 is the only confirmed level while 32 and 55 are single windows, and why 55 VUs at pool 80 reads
`fail (checks)` at an 820ms p95.

## Result

The boundary after each change, in the order the runs happened:

| When       | Config                      | Passed once  | rps there | First fail |
| ---------- | --------------------------- | ------------ | --------- | ---------- |
| 2026-10-22 | pool 10, before the changes | 10           | 17        | 20         |
| 2026-10-23 | optimized changes (pool 20) | 32           | 50        | 55         |
| 2026-10-23 | pool 40                     | 55           | 70        | 100        |
| 2026-10-23 | pool 80                     | 55 (latency) | 71        | 100        |

Only 10 VUs passed the plan's three 5 minute confirmation. Everything above it is one window.

## Next

Count `status == 0` per route in the CSV, then either keep the binary gate and accept the noise or gate correctness at a rate; an edge-path smoke separates the rig from the app.

The same sweep over the cloudflared path into the ingress, no NodePort(since NodePort bypass cloudflared and ingress)
so the edge is in the number too. It will not be comparable to these numbers, because Cloudflare and the tunnel are in that path;
it answers what the edge costs, not where the app breaks.

The full sweep is paused: Neon's compute is at about 90% of its limit. The 55 VU pool-80 probe ran after
that, because it was one three minute window; the edge path and any full sweep wait for the budget.
I will keep expanding this dataset and run the same experiment against different architectures.

## Since this record

After the last sweep, four small changes landed:

- The daily chat-turn credit is now spent in one atomic upsert. It removes one round trip per chat turn and closes the double-spend race.
- The dashboard counters and the dimension averages now come from one statement. `/stats/dimensions` is gone; `/stats/dashboard` carries both.
- The resume page starts its usage read beside the resume list.
- The chat page starts the transcript read beside the start request.

The request table above still describes the sweep that ran, including `/stats/dimensions`. None of these four changes has been through the sweep yet, so every number above still describes the earlier build.

## Batching

I had three layers of batching. They sit at different points between the client and the database.

Request Batching means one request where several used to go out. Think of one call that asks for a batch of records instead of one call per record.

Aggregate Queries means one statement where several reads used to run. Think of one query that returns five counts instead of five queries.

Group Commits means several database writes grouped into one round trip or transaction. Think of one transaction for several writes instead of one commit per write. I did not use that here; it is the third layer, and I usually see it in SQLite work, not this Postgres app.

| Layer             | What gets fewer    | Where it sits      | Generic software example                              |
| ----------------- | ------------------ | ------------------ | ----------------------------------------------------- |
| Request Batching  | HTTP requests      | client to server   | one call for a batch of records, not one per record   |
| Aggregate Queries | SQL statements     | server to database | one query for five counts, not five queries           |
| Group Commits     | commit round trips | database writes    | one transaction for several writes, not one per write |

Parallel requests are a separate technique, not batching. Two calls run at the same time; that is not one call carrying both.

The earlier optimization was mostly Aggregate Queries. The latest batch is mixed.

| Batch   | Change                                                      | Layer                           |
| ------- | ----------------------------------------------------------- | ------------------------------- |
| Earlier | `/stats/analytics`, `/usage`, home counters                 | Aggregate Queries               |
| Earlier | `GET /interviews` pagination, `/templates` seed write, pool | Not batching                    |
| Latest  | Dashboard: two stats requests become one                    | Request Batching                |
| Latest  | Dashboard: counters and dimension averages in one statement | Aggregate Queries               |
| Latest  | Resume: usage read beside the list                          | Parallel requests, not batching |
| Latest  | Chat: transcript read beside start                          | Parallel requests, not batching |
| Latest  | Turn spend: one atomic upsert                               | Atomic write, not batching      |

## Current harness

| Setting             | The run in this record            | Current harness                   |
| ------------------- | --------------------------------- | --------------------------------- |
| Ladder measurement  | 3 min                             | 2 min                             |
| Confirmation        | 3 runs of 5 min, repeated 3 times | single-run confirm: one 5 min run |
| Failed confirmation | Search below, up to 3 times       | Abort; boundary unproven          |

I changed the measurement window to 2 minutes and the confirmation to one 5-minute run because the sweep was taking too much of my time, and I am fine losing some of this data for the experiment. The shorter windows also spend less Neon compute, which is the other reason for the change: the full sweep is paused near the free-tier limit. That is a real trade: fewer samples make p95 and p99 noisier, one run is weaker proof than the old 3/3, and a failed single-run confirm aborts the sweep instead of searching below.
