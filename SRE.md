# SRE

Minimal SRE path for loading metrics and load testing application by generating randomized structured request with k6

Inspired by Arjay McCandless $12 VPS load testing videos, usually known for system design with informative detailed videos.

The specification comes first, and the runs follow it in the order they happened.

## The question

At what load does the prod deployment stop behaving acceptably, and which resource runs out first.

## Pipeline flow

One sweep, window open to boundary. Each measure box writes one CSV row per run, tagged with its phase.

```
gitops overlay opens the window    NodePort 30090 on the backend Service
        |
cleanup        delete every row the sweep identity owns            -> deleted_before
        |
measure 10s at 10 VUs  the harness check, before any rung          -> phase=smoke
        |
        +-- fail: abort the sweep, the harness or the app is broken
        |
ramp 30s, warm 60s     neither enters a gate
        |
measure 3 min          the only window that counts                 -> phase=ladder
        |
gates                  SLO
        |
        +-- pass, rungs left: double the VUs, repeat
        +-- pass at 800 VUs: stop and raise --max-vus, no confirmation
        +-- fail: binary search the gap down to the 10 VU smoke    -> phase=search
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
| Database pressure | `db.pool.size` against `db.pool.idle`, bounded by `DB_POOL_MAX`                                             | connections held      |
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
Capacity path, as run
  k6 (desktop or laptop) -> Tailscale -> NodePort 30090 -> pod
  pod -> Neon (direct host, TLS)
  pod -> Alloy (in-cluster) -> Grafana Cloud
```

The NodePort sits on the backend Service, so every prod row measures the pod, the app and its database,
with ingress-nginx, the tunnel and Cloudflare outside the number.

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
| DB pool                  | `DB_POOL_MAX`, `min_size=0`                              |
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

| Request                                                                        | Phase         |
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

Every virtual user is the same identity and they all share one account. One identity is the first cut
because it is one candidate moving through the app, and the cleanup has one owner to delete. A real
deployment is many people at once, so the next architecture will give different VUs different identities both also measured separately in the run.
That also changes two things: each owner's history stays small instead of growing with the whole window, and the cleanup has to delete a set of owners. It puts authentication back in the measured path too, since one `DEV_USER_SUB` is what makes the shared account possible.

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

The reads that scale with history are in the loop, so the loop's own writes change them. GET /api/interviews returned every run for the owner with no limit, and the stats endpoints re-scan the full history.

The first draft left pagination and Redis out, to stay close to the current unoptimized architecture. But on second thought I opt in the pagination goes in, first and foremost without coupling it to Redis or any more optimization strategies. A LIMIT and OFFSET is a minimal change to the query itself, not a dependency to run, so it comes before anything else is added or measured. The list is paginated, so the sweeps in `## Result` measured the unpaginated architecture and a re-run measures a different one.

Redis stays out: it is a different tier, a second compute and a cache to invalidate, and does not belong in the same step as a LIMIT.

## Between steps

A sweep is the whole experiment: warm the database, climb the ladder, bracket the failure, binary search, confirm, and record the boundary for estimated max users per relative to RPS. A step is one level inside it. The sweep is automated end to end, so there are no human gaps between steps. That matters here, because let's say I forgetting to actually run the test for a certain period, it will eventually close because theres no one using the application. A gap long enough would let the asyncpg pool close its idle connections and Neon return to scale-to-zero, and the next step would pay the wake again before any number is taken.

So first, we warm the database. `min_size=0` means the first requests pay pool creation and a fresh TLS handshake, and Neon scale-to-zero means the first request after an idle gap pays the compute wake.

Then every step is a ramp to the target VUs, then a 3 minute measurement window. Only the window counts. After it, a 60 second gap separates this step from the next: 15 seconds of
silence, up to 30 seconds of cleanup, 15 seconds of silence again. 60 seconds stays well inside asyncpg's idle close and Neon's scale-to-zero, so the gap costs neither the pool nor the wake of our cloud database.

The cleanup deletes the k6 identity's account, so every run starts from the same empty account. That deleting happens for 30 seconds which would be all more plenty of time to delete all that data relevant to our k6 account, and a cleanup that runs out of that budget aborts the sweep instead of letting the next window read a bigger account than the last. The row count is recorded at window start and at window end, so intra-window drift is reported rather than assumed.

The sweep opens with a 10 VU smoke on the same workload, with a 10 second window. It warms the pool and
the Neon compute, and it is the harness check: a failure there is the app or the generator, not load.
The smoke is not optional, and a failed smoke aborts the sweep before any rung.

Then the ladder starts at 100 VUs and doubles. A failed rung is the boundary rather than a broken
harness, because the smoke already cleared that. The search runs between the last pass and the failure,
and it can go as low as the smoke's 10 VUs when 100 is the rung that fails.

Each level passes or fails. If it passes, we go up. If it fails on an SLO, we stop going up, but the run keeps going. That failure becomes the top of the range, and we split the gap between the last pass and that failure to find the highest level that still passes. If 200 passes and 400 fails, try 300; if 300 passes, try 350. That is a binary search. We only need the boundary between pass and fail, not an exact number.

Confirm the highest passing level by re-running it 3 times, each measured for 5 minutes, and all three must pass. Since the boundary moves about 10%, a single pass is not proof. A failing run ends that phase at once and reopens the search between the level and the highest rung below it that passed, for at most three confirmation phases in total. If none of them reaches 3/3, the sweep stops unconfirmed.

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
11. Capacity sweep at a small fixed floor, and the unbounded read on its own N-sweep. N grew inside every window anyway (159 rows at 10 VUs, 415 at 100), because the cleanup runs between levels. The read never surfaced in the tail, the 100 VU failure was attributed to pool wait without an N-sweep, and pagination shipped on code grounds. The N-sweep is still unrun.

# The runs

## Result

Every row below is the application before any optimisation, with the pool at 10 and the NodePort path,
read from `results/sweep-*.csv`. Latency, rps and errors come from the harness; CPU, memory, pool wait,
the per-route and the per-query numbers are Grafana readings over the same windows. The laptop row is
docker compose against the stub; the rest are the prod pod, which is read from those latencies because
the harness records no target. `max` is the measure window's max latency: k6's summary does not export p(99) for these runs, so
the harness recorded the max while the gate evaluated a real p99 inside k6. The harness now exports
p(99), so the next sweep records both.

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
tails: `/stats/analytics` 4.8s p95, `/templates` 3.8s, `/usage` 2.9s, about one request in nine. No
query passed 425ms at p95 or 2.12s at p99, so the tail is sequential round trips stacking, not one slow
statement.

At 100 VUs the shape changes: p50 1.17s, of which 0.94s is pool wait, and pool wait p95 is 2.4s against
3.44s end to end. CPU stays at 0.27 cores.

## What I did not expect

I actually ran the same workload on the laptop first, docker compose with the stub model, and it passed
at 100 VUs. So I went into the prod run expecting the number to be somewhere in the hundreds, and it
failed on the first rung instead: p95 3.44s and a max of 8.54s at 100 VUs, and an error rate of zero.
The part that surprised me is that the machine was pretty much idle while it failed, 0.27 of 4 cores
and 134Mi of 256Mi. Nothing was out of CPU or memory, so the latency was not a resource running out.

If you noticed, I ran the test and wondered where my p99 was and apprarently when I was telling my AI to
code this with my specs, It just somehow glossed over the p99 export so that's why we only see max latency
on the pre-optimized run. Now it still my fault and the AI did pretty well on writing it and still gated p99
so we didn't lose the gates, just the numbers. Fixed it and from here on out we will be running it with p99.

At 100 VUs the pool was the queue: p50 1.17s, and 0.94s of that was wait for a connection that was not
doing anything yet. That is where I got worried, because 10 was a default I had set and not a number I
had found.

So I dropped to 10 VUs, expecting to find something wrong with the k6 harness. It passed, three times
over three 5 minute windows, so the harness was clean and the application was the thing. The 100 VU run
had already finished 348 iterations with every check passing, which I did not read that way at the time.
The rung above it failed at 20 VUs with a max of 17.6s, and no single statement explained it, since the
slowest query stayed under 2.12s at p99. The routes that failed were the ones that pay several round trips in a row:
`/stats/analytics` at 4.8s p95 across five sequential queries, `/templates` at 3.8s with a seed write
before its read, `/usage` at 2.9s across two. The queries were not slow, they were stacked, one behind
another, and every one of them was its own checkout from a pool of ten.

The run also showed two things that are not latency numbers. The list read every run the owner had,
with no limit, and the account grew inside every window: 159 rows at 10 VUs, 241 at 20, 415 at 100.
That is a code gap rather than a measured tail. The list route was never the slowest one in the report,
but it is the read whose cost rises with history. And there is no cache anywhere in this path, which I
left out on purpose. A cache is not a quick drop in, and if I had added it before the first run I would
not know what the app does without it.

I also read that first-rung failure as the harness or the app, not load. That was wrong. 100 VUs was not
a low number for this app, it was five to ten times above where it stops, so the failure was the
boundary, not a broken run.

That is why this run exists in this shape. I wanted the numbers for the application on the day I planned
this, before any of the optimisation, so that every later state has its own data and the difference is
what the optimisation is actually worth.

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

## The retest, and the regression it caught

With the six changes on the pod I opened the window again to see where the boundary had moved, and the
10 VU level failed, not on latency: errors at 3.75%, about one request per iteration, and
`/stats/analytics` returning 500 on every call. The one-statement aggregate built the offers as JSONB,
which turns a timestamp into a string, and the offer maths added a timedelta to that string. The old
five-query version handed back real datetimes, so nothing exercised that path until the route ran under
load.

One line put the date back to a datetime where the aggregate loses it, and a test that seeds an offer
keeps it fixed. The suite was green through all of it, because no test had ever created an offer. The
500 reached prod for most of an hour before the fix.

## What the run taught me about the harness

I skipped the manual smoke that time and went straight to the ladder, which turned a sixteen second
check into a five minute failed level. The 100 VU failure in the first sweep had already told me the old
rule was wrong: it was capacity, not a broken harness.

And from here and out we are smoking first 10 VU's first so we can catch whats wrong before 100 ladder starts.

The harness enforces it now: the smoke is the sweep's first window, it aborts before any rung, and its
result is the floor the search can reach when 100 is the rung that fails.

## The optimized sweep

Same workload, same target, the image with the six changes and the analytics fix, pool 20, over the
NodePort. The smoke passed at a 239ms p95, the ladder failed at its first rung, and the search put the
boundary between 32 and 55.

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
fails moved from 20 to 55. The tail did not improve: the max at 100 VUs went from 8.54s to 27s, and the
last 10 VU confirmation saw 19.6s.

## The 32 probe, and what the checks gate did

The 32 VU confirmation failed on checks, not latency: p95 600ms, p99 1.14s, error rate 0.08%, all inside
the gates. The summary shows 29 failed checks from 9 bad requests, 7 answer streams and 2 finishes. The
app logged only 200s on those routes and no errors, so the requests failed between k6 and the pod.

I re-ran 32 on its own: 514 iterations, 13,665 requests, zero errors, p95 558ms, 50.1 rps. The nine
failures did not repeat.

So the strict rule still reports 10, because one phase failed and the 25 VU tolerance cannot split 10 to 32. What the application does: 32 holds every window on latency and errors, and 55 is the first level
that fails, at p95 1.096s.

## What is the bottleneck now

The sweep above ran with the pool at 20, and at 20 the pool was the wall. The mean query time is what
sets that, not the p50: mean query time times queries per second is the number of connections held.

| Window (pool 20) | Mean query | Queries/s | Connections held | Pool wait p50 | Pool wait p95 | CPU  | Memory |
| ---------------- | ---------- | --------- | ---------------- | ------------- | ------------- | ---- | ------ |
| 32 VUs           | 100ms      | 138       | 13.7 of 20       | 6ms           | 129ms         | 0.39 | 48%    |
| 55 VUs           | 168ms      | 155       | 26.0 of 20       | 153ms         | 448ms         | 0.41 | 48%    |
| 100 VUs          | 119ms      | 134       | 15.9 of 20       | 478ms         | 1.31s         | 0.38 | 44%    |

At 32 VUs nothing waits on the pool, and the latency is the round trips: 2.3 queries per request at about
100ms each. `/stats/analytics` is still the slowest app-owned route at 1.41s p95, then `/messages` at
0.7s. The rest of the tail is model routes, which the gate excludes but the pool still serves.

At 55 VUs every route multiplies: analytics 1.41s to 7.75s, messages 0.7s to 5.08s, finish 3.46s to
14.2s. That is the pool of 20 running out, not the app work changing. At 100 VUs the wait is most of the
request: 478ms of a 719ms p50, and 1.31s of a 1.90s p95. The pool is fully held there, idle 0 for the
whole window; the 15.9 in the table is the achieved rate, and the queue is what lowers it.

CPU stays near a tenth of the four cores and memory near half of 256Mi in all three windows, so neither
is the ceiling.

## The pool probes

Same build, same NodePort path, same workload as the optimized sweep; only the pool changed. Each cell
is verdict, p95, rps, and pool wait p50.

| Pool | 55 VUs                        | 100 VUs                      |
| ---- | ----------------------------- | ---------------------------- |
| 20   | fail, 1.096s, 50.0 rps, 153ms | fail, 1.90s, 54.9 rps, 478ms |
| 40   | pass, 832ms, 70.3 rps, 6ms    | fail, 1.64s, 66.7 rps, 239ms |
| 80   | not measured                  | fail, 1.87s, 75.0 rps, 7ms   |

Raising the pool was the largest single move after the six changes: 40 turned 55 VUs from a failure into
a pass and halved the wait at 100. At 80 the app's wait disappeared, but the database's own query p95
rose to 962ms and the request p95 to 1.87s, worse than 1.64s at 40. So 40 ships, the wall at 100 is now
the database's service time, and the pod's memory caps the pool near 80: it was already 75% of 256Mi.

The levers left are Neon's compute size, the query count on the chat turn, and the analytics history
scan that survives the one-statement rewrite. The pool is not one of them at 100 VUs any more.

A warm `SELECT 1` from inside the pod is 37ms at the median, and a first-row read is the same. The mean
query is 100ms at 32 VUs and 234 to 339ms at 100 with 80 connections, so the inflation is the database's
own service time under concurrency, not the round trip. Co-location could save the 37ms floor; it
cannot save the inflation.

## What the record does not carry

- The CSV has no per-route and no pool columns. Those are Grafana readings keyed to the window, and the
  window is only the row's timestamp.
- A failed checks gate names its cause only in the run JSON's `root_group`, never in the CSV. The 32
  rejection needed that file to become 9 bad requests.
- The error rate does not separate a 4xx, a 5xx and a connection failure. The nine requests that failed
  at 32 left no app log line at all.
- The p50 query time understates the pool. The mean, sum over count, is what sets utilisation.
- The max column has no owner. The 27s at 100 VUs and the 19.6s in the last 10 VU confirmation are
  recorded but not explained.

## Next

The same sweep over the cloudflared path into the ingress, no NodePort, so the edge is in the number too.
It will not be comparable to these numbers, because Cloudflare and the tunnel are in that path; it answers
what the edge costs, not where the app breaks.
