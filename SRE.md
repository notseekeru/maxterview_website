# SRE

A minimal SRE learning/iterative artifact for collecting metrics and benchmarking the application under load, by generating randomized structured requests with k6.

Inspired by Arjay McCandless's $12 VPS load testing videos, known for detailed, informative takes on system design.

## The question

So first here were my question at the time when this idea went through my head.

First, How do I even benchmark an application. Second, What is the methodology of this kind of experiment. And third, How much traffic can my pi can handle under simulater user workload.

## SLO

| Indicator   | Gate           |
| ----------- | -------------- |
| p50 latency | none, reported |
| throughput  | none, reported |
| p95 latency | <1s            |
| p99 latency | <5s            |
| error rate  | <1%            |
| correctness | check pass     |

I set the pass bar for this architecture but you could use whatever you want. Since latency can depend on the language and framework the app uses, and that matters when you compare runs. You could not compare a backend using Rust to a backend using something like NodeJS.

Im not really an SRE or I don't even have professional experience even so keep that in mind for our session and I cannot confirm what I'm doing is even right even for my specs and my methodology and I present this as documentation as my learning process with verified metrics and numbers.

## Architecture

One path, ending in the same pod.

```
Capacity path, as run
  k6 (desktop or laptop) -> Tailscale -> NodePort 30090 -> pod
  pod -> Neon (direct host, TLS)
  pod -> Alloy (in-cluster) -> Grafana Cloud
```

## k6 flow

The block below is the first harness. More over the change in harness later on, but for now.

One test sweep. Each measurements writes box on one CSV row per sweep so we can fully record our numbers. Now in a bit, I'm gonna be explaining in more detail what these mean and how they interact this becomes really important specially if you wanna develop a mental model to actually understand systems.

```
flowchart TD
    A["overlay: open perf window; NodePort 30090"] --> B["cleanup: delete sweep rows -> deleted_before"] --> C["smoke: 10s @ 10 VUs -> phase=smoke"]
    C -- fail --> D["abort sweep"]
    C -- pass --> E["ramp 30s, warm 60s (no gate)"] --> F["ladder: 3 min -> phase=ladder"] --> G["gates: SLO"]
    G -- pass --> H["double VUs; repeat"] -- loop --> F
    G -- fail --> I["search to 10VU smoke -> phase=search"] --> J["confirm highest pass 3x5min; all pass -> phase=confirm"]
    J -- "all pass" --> K["boundary: CSV+Grafana"] --> M["close perf window; then --cleanup-only"]
    J -- "any fail" --> L["search below; confirm again; max 3 rounds; loop to confirm"] -- "loop to confirm" --> J
```

## Configuration

### Load generator (the machine that runs k6)

| Component | Laptop                                      |
| --------- | ------------------------------------------- |
| CPU       | Intel i7-10610U (4 cores / 8 threads, 15 W) |
| RAM       | 16 GB                                       |

### The box (the machine under test)

| Component  | Specification                      |
| ---------- | ---------------------------------- |
| Device     | Raspberry Pi 5                     |
| RAM        | 8 GB                               |
| CPU        | Four Cortex-A76 cores              |
| Deployment | k3s, single replica, no autoscaler |

### Perf window (The overlays)

| Change                                    | Value        |
| ----------------------------------------- | ------------ |
| `LLM_BASE_URL`                            | unset (stub) |
| `RATE_LIMIT`                              | `off`        |
| `CLERK_ENABLED`                           | `false`      |
| `APP_ENV`                                 | `test`       |
| `nginx.ingress.kubernetes.io/limit-rps`   | `1000000`    |
| `nginx.ingress.kubernetes.io/limit-burst` | `1000000`    |

### Deploy

| Setting          | Value                                         |
| ---------------- | --------------------------------------------- |
| replicas         | 1, no autoscaler, no HPA, no KEDA             |
| ingress-limit    | 30 and 20 burst, raised to 1M(both)           |
| pod memory limit | 256Mi                                         |
| telemetry        | OTLP to the in-cluster Alloy receiver         |
| database         | Neon direct host, not `-pooler`, TLS required |

I use k3s(a smaller k8s) because I deploy my websites on my cluster. because I prefer it on my deployment pipeline since for me has a cleaner git commit push model pipeline with rollbacks rather than doing something like a webhook on docker so personally it's cleaner, but you could use whatever like docker compose or using the machine host to run which has less overhead since you arent paying the tax of much complex software to run on.

Now I change values on the cluster directly using a Kustomize overlay over the base yml file so it's pretty easy to switch on and off kinda like a light switch. The overlay itself lives in the gitops repo, so those values are read from there and git reconcile with ArgoCD when I push an image using my CI/CD pipeline that I already set up.

This type of deployment is not what you should do especially if you have users on your prod machine. Instead what I would do is to spin up another replica with namespace/node/cluster of it or maybe just host your application your testing on another machine. Some of you guys are already raising your eyebrows: “Uhh, why are you testing it on prod?” Dude, I know that’s not best practice. I’m only doing this because my so-called “prod” website doesn’t really have any users to begin with, and I can afford to have my little experiment run on the prod pod directly.

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

At first I considered running this test on a PVC Postgres pod in my K3s cluster. It is not directly equivalent to production: the round-trip latency from my backend to Neon's servers disappears, though that is not significant at my scale. I was worried the Neon free tier would block me because I ran out of compute. I did the numbers, and the free tier is generous enough for this test without hitting storage or compute caps. The sweep runs against prod's default branch, so it spends prod's own budget and the test rows stay in a throwaway database on that branch, not in prod’s application data. The cleanup between levels keeps that bounded, though it’s best-effort. It uses scale-to-zero so we don't pay for compute when the application is not used. That has tradeoffs like cold starts, but at this scale I decided to leave it alone, since we warm the Neon database anyway. It's also good to mention neon branching which I decided to leave, A branch IS a different machine. Cold start, different compute size, copy-on-write storage. If the goal is to measure how prod behaves, running against prod's actual compute is arguably MORE representative than running against a fresh branch(but that might be reach honestly). The cost/complexity of a Secret swap and a second compute is real overhead for a test that runs occasionally. Every VU is one identity either way. More Complex Wiring. Prod has no users so nothing to isolate(albeit its a fragile reason that makes this a lazy reason)

For routing k6 to my app, I used Tailscale to connect them. For anyone who doesnt know, Tailscale is a way to securely have a tunnel or a VPN you frequently see this among homelabbers because it's a mesh VPN. now this Tailscale tunnel exists because of CGNAT because I couldn't forward traffic using an IP address so I use Tailscale to essentially bridge that gap safely, and I was thinking Cloudflare on my first option of this architecture but upon research, Cloudflare's bot protection on Free would prolly block me. That's because when I hit my domain endpoint with alot of traffic in a sudden spike which of Cloudflare will detect it's probably someone DDOSing me. The only lever is an IP Access rule, and any IP Access rule disables BFM zone-wide, not just for the runner. So I simplified the architecture and used Tailscale plus a k3s NodePort so the service is reachable on a node port over the tailnet to connect the load machine and the application machine. Cloudflare could measure production-like latency, but the plan was about SRE principles rather than what real users feel so that's a probably a separate discussion for now.

## What each VU does

| Request                                                                        |
| ------------------------------------------------------------------------------ |
| `POST /interviews`                                                             |
| `POST /interviews/{id}/start`                                                  |
| `POST /interviews/{id}/chat/kickoff`                                           |
| `POST /interviews/{id}/chat/stream`                                            |
| `POST /interviews/{id}/finish`                                                 |
| `GET /interviews/{id}/feedback`                                                |
| `GET /interviews/{id}/messages`                                                |
| `GET /interviews`, `/stats/dimensions`, `/stats/analytics`, `/stats/dashboard` |
| `GET /usage`, `/templates`, `/resumes`, `/settings/llm`, `/voice`              |
| `GET /interviews/{id}/offer`                                                   |
| `POST` and `DELETE /interviews/{id}/archive`                                   |
| `POST /resumes`, `POST /templates`, each deleted in the same run               |
| `POST /client-errors`                                                          |

I want to walk through one virtual user, because otherwise I keep saying "it makes twenty-eight requests" and "the pool is the wall", and neither is obvious from the outside.

A virtual user is one person doing one whole interview, plus everything else a signed-in person can reach. The bytes arrive over Tailscale at the NodePort on 30090. No Nginx, no Cloudflare, no tunnel: the request lands on the pod's socket directly. The app is one Uvicorn process, so every other virtual user's request is interleaved in the same event loop while this one waits.

It starts with a create. POST /api/interviews with a role, a topic, a level and the dials. Nothing is authenticated in the perf window, so there is no token to verify and no Clerk round trip. The identity is a fixed subject that every virtual user shares. The handler inserts one row and hands back the interview, its id, and the arc it will follow, nineteen questions for a standard run.

Then start. One update, to in_progress, because every chat route refuses a run that is not in progress. Then the opener: chat/kickoff, which comes back as a stream. On the server that call reads the
interview, the resume attached to it and the whole transcript in one statement, then asks for a reply and stores it. In the perf window that reply is the stub: it echoes the answer back word by word, with no network and nothing billed. The client reads the frames, checks that the last one is done, and keeps the text.

Now the turns. Two to eight of them, drawn at random, with one to three seconds of think time between each so the shape looks like a person typing rather than a loop. Each turn is the same chat/stream with a few hundred characters of answer. On the server that is three statements: read the interview and transcript again in one, spend the credit and store the message in one, store the reply once the stub has echoed it back. Four in production, where the tier lookup is not skipped. The transcript is re-read every turn and grows every turn, which is why the same route costs more at turn six than at turn one.

Then finish. That one request does the most work in the run: it flips the status and runs the whole feedback pipeline inside the request, which the harness counts at eleven statements. The grading is the stub too, so what that request costs is the statements and not the model. It is not a background job, and the virtual user waits for it.

After that the run is read back, feedback then transcript, and then the surface, the part people forget: the interview list, the stats, usage, templates, resumes, settings, the offer, an archive toggle and back, a resume created and deleted, a template created and deleted, and one browser error beacon. None of it is the interview, and all of it is in the loop.

Twenty-eight requests, one interview, about twenty seconds. At a hundred virtual users that is sixty-something requests a second and about a hundred and twenty-five queries a second, all handed out through different optimization recorded. Every optimisation in this record is one of those steps getting cheaper.

| HTTP                 | Count | Share |
| -------------------- | ----- | ----- |
| read (GET)           | 6,230 | 46%   |
| write (POST, DELETE) | 7,405 | 54%   |

| SQL                            | Count  | Share |
| ------------------------------ | ------ | ----- |
| read (SELECT)                  | 17,210 | 55%   |
| write (INSERT, UPDATE, DELETE) | 12,804 | 41%   |
| either (WITH)                  | 1,558  | 5%    |

Every virtual user is the same identity and they all share one account. One identity is the first cut because it is one candidate moving through the app, and the cleanup has one owner to delete. It is very different from a real deployment which uses accounts as users and many people with different at once, so the next architecture will give different VUs different identities, measured separately as well.

The number of turns per VU is randomized but follows the run's own plan, with a think time to simulate a real user so we just don't have like a predictable robot and instead want as close to prod.

I already setup where endpoints are not carrying model generation and fit for stub design. This includes NvidiaNIM (LLM output) and Cloudflare Workers AI (voice). These vendors use credit and would only limit the workload, which is why NvidiaNIM is stubbed and Cloudflare Workers AI is off. They are outside generation: vendors that could fail the experiment on free-tier, hit rate limits, and also swing latency on our experiment if a model takes too long to generate an ouput.

## What the reads cost

I already know there are already visible gaps in my application, example so some GET request that has no limit on rows keeps growing re-scans the full history.

Well obviously Pagination with something like LIMIT and OFFSET(and also keyset) but for sake for data I was really curious on what those optimization looked like and so I left it out first so we could get a baseline data. I was also thinking about Redis since my endpoint will have hit cache on the reads but I decided to leave to out as our last optimization because first and foremost I don't need coupling to any other optimization strategy since a some are a minimal change to the query or request itself, and some needs a change on the architecture or add a dependency to work, so Redis comes last anything else is added or measured.

now Redis stays out, not because I'm avoiding it but because solely kit is a different tier, a second compute and a cache to invalidate, and I'm really trying to avoid that instinct when something is slow is the solution is to add a cache. No no no, don't a solution the cache to everything, like bro we could optimize first on the code.

## Between levels

So for my testing sweep is relatively simple, first is to warm the database, climb the ladder, bracket the failure, binary search, confirm, and record the data for estimated max vus with consideration of recorded throughput. The sweep is also automated end to end, so there are no human gaps between levels. That matters here because if I leave the app idle long enough, the asyncpg pool closes its idle connections and Neon returns to scale-to-zero, and the next level pays the warming our database again before any number is taken and that only makes it worse for us.

So in alot more detailed.

The sweep opens with a 10 VU smoke on the same workload, with a 10 second window just for checking any wrong before test starts.

We warm the database. The first requests pay pool creation and a fresh TLS handshake, and Neon scale-to-zero warms up.

Then every level is a 30 second ramp to the target VUs and a 60 second hold at them, then a 3 minute measurement window. Only this window counts and gated. After it, a 60 second gap separates this level from the next: 15 seconds of silence, up to 30 seconds of cleanup, 15 seconds of silence again. so in total 60 seconds that stays well inside asyncpg's idle close and Neon's scale-to-zero, so the gap costs neither the pool nor the wake of our cloud database.

The cleanup deletes the k6 identity's rows, so every run starts from the same empty account and each level gets equal footing. That deletion runs for 30 seconds, more than enough time to delete all the data relevant to our account.

Then the ladder starts at the 100 VU level and doubles. Each level passes or fails. If it passes, we go up. If it fails on an SLO, we stop going up. That failure becomes the top of the range, and we split the gap between the last pass and that failure to find the highest level that still passes. If 200 passes and 400 fails, try 300; if 300 passes, try 350. So kinda like a binary search. We only need the estimate between pass and fail, not really an exact number.

Confirm the highest passing level by re-running it 3 times, each measured for 5 minutes, and all three must pass. Since the last recorded pass can move about 10%, so a single pass is not proof.

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

The table below is the application before any optimisation, with the pool at 10 and the NodePort path, read from `results/sweep-*.csv`. Latency, rps and errors come from the harness; CPU, memory, pool wait, the per-route and the per-query numbers are Grafana readings over the same windows. The laptop row is docker compose against the stub; the rest are the prod pod, which is read from those latencies because the harness records no target. `max` is the measure window's max latency: k6's summary does not export p(99) for these runs, so the harness recorded the max while the gate evaluated a real p99 inside k6. The harness exports p(99) now, so every sweep after the baseline carries both.

| Pod    | Phase   | VUs | Window | p50   | p95    | p99 | max   | rps  | errors | verdict | queries/req | wait p50 | wait p95 | query mean | query p95 | CPU (of 4) | memory (256Mi) |
| ------ | ------- | --- | ------ | ----- | ------ | --- | ----- | ---- | ------ | ------- | ----------- | -------- | -------- | ---------- | --------- | ---------- | -------------- |
| laptop | only    | 10  | 10s    | 2.4ms | 11.6ms | n/r | 288ms | 54.0 | 0      | pass    | n/r         | n/r      | n/r      | n/r        | n/r       | n/r        | n/r            |
| laptop | only    | 100 | 3m     | n/r   | n/r    | n/r | n/r   | n/r  | n/r    | pass    | n/r         | n/r      | n/r      | n/r        | n/r       | n/r        | n/r            |
| prod   | only    | 10  | 10s    | 155ms | 705ms  | n/r | 933ms | 25.6 | 0      | pass    | n/r         | n/r      | n/r      | n/r        | n/r       | n/r        | n/r            |
| prod   | ladder  | 100 | 3m     | 1.17s | 3.44s  | n/r | 8.54s | 38.3 | 0      | fail    | n/r         | 940ms    | 2.40s    | n/r        | n/r       | 0.27       | 52%            |
| prod   | ladder  | 10  | 3m     | 155ms | 654ms  | n/r | 2.80s | 16.7 | 0      | pass    | n/r         | n/r      | n/r      | n/r        | n/r       | n/r        | n/r            |
| prod   | ladder  | 20  | 3m     | 205ms | 1.25s  | n/r | 17.6s | 21.6 | 0      | fail    | n/r         | 35ms     | n/r      | n/r        | n/r       | 0.21       | 39%            |
| prod   | confirm | 10  | 5m     | 149ms | 587ms  | n/r | 3.00s | 16.9 | 0      | pass    | n/r         | n/r      | n/r      | n/r        | n/r       | n/r        | n/r            |
| prod   | confirm | 10  | 5m     | 149ms | 569ms  | n/r | 1.38s | 16.7 | 0      | pass    | n/r         | n/r      | n/r      | n/r        | n/r       | n/r        | n/r            |
| prod   | confirm | 10  | 5m     | 147ms | 496ms  | n/r | 2.01s | 17.4 | 0      | pass    | n/r         | n/r      | n/r      | n/r        | n/r       | n/r        | n/r            |

Now you might see alot of n/r, it's because my first k6 harness didn't record it, but overtime I have fixed this and filled these up like the missing p99. That's the beauty of the this journey and learning new things and which I have a baseline to compare to on what I am doing.

So anyways as you can see in the table, I actually ran the same workload on the laptop first, docker compose with the stub model, and it passed at 100 VUs. So I went into the prod run expecting the number to be somewhere in the hundreds, and it failed on the first level instead: p95 3.44s and a max of 8.54s at 100 VUs, and an error rate of zero.

The part that surprised me is that the machine was pretty much idle while it failed, 0.27 of 4 cores and 134Mi of 256Mi. Nothing was out of CPU or memory, so there must be another problem I have to find.

I skipped the manual smoke that time and went straight to the ladder, which turned a sixteen second check into a five minute failed level. And with that, from here on out we smoke 10 VUs first, so we catch what's wrong before the 100 VU ladder starts.

At 100 VUs the pool was my watch: p50 1.17s, and 0.94s of that was wait for a connection that was not doing anything yet. That is where I got worried.

So I dropped to 10 VUs, expecting to find something wrong with the k6 harness. It passed, so the harness was clean and the application was the problem. The 100 VU run
had already finished 348 iterations with every check passing, which I did not read that way at the time. The next level up failed at 20 VUs with a max of 17.6s.

The run also showed two things that are not latency numbers. The endpoint read every run the owner had,
with no limit, and the account grew inside every window: 159 rows at 10 VUs, 241 at 20, 415 at 100.
That is a code gap rather than a measured slow end. It is the read whose cost rises up those numbers.

And so I was already planning at this point what optimization could I apply to my applications.
I wanted the numbers for the application on the day I planned this, before any of the optimization,
so that every later state has its own data and the difference is what the optimisation is actually worth.

## What changed after the first runs

Six changes, all of them on round trips, read size or the pool rather than on the queries themselves.

| Change             | Before                                             | After                                            |
| ------------------ | -------------------------------------------------- | ------------------------------------------------ |
| `/stats/analytics` | five checkouts                                     | one statement                                    |
| `/templates`       | a seed write, then the read                        | the read, seeded only when the endpoint is empty |
| `/usage`           | two checkouts in the window, three to four in prod | one                                              |
| `GET /interviews`  | every run the owner had                            | 50 per page, archived filtered in the query      |
| Home counters      | derived in the browser from that full endpoint     | one statement over the full history              |
| pool               | 10                                                 | 20                                               |

Same workload, same target, the image with the six changes and the analytics fix, pool 20, over the
NodePort. The smoke passed at a 239ms p95, the ladder failed at its first level, and the search put the
boundary between 32 and 55. The `probe` row is the 32 VU re-run from the next section, not a window of
this sweep.

| Phase   | VUs | Window | p50   | p95   | p99   | max   | rps  | errors | verdict | queries/req | wait p50 | wait p95 | query mean | query p95 | CPU (of 4) | memory (of 256Mi) |
| ------- | --- | ------ | ----- | ----- | ----- | ----- | ---- | ------ | ------- | ----------- | -------- | -------- | ---------- | --------- | ---------- | ----------------- |
| smoke   | 10  | 10s    | 145ms | 239ms | 750ms | 769ms | 29.5 | 0      | pass    | n/r         | n/r      | n/r      | n/r        | n/r       | n/r        | n/r               |
| ladder  | 100 | 3m     | 719ms | 1.90s | 3.26s | 27.0s | 54.9 | 0.08%  | fail    | n/r         | 505ms    | 1.31s    | 116ms      | n/r       | 0.38       | 44%               |
| search  | 55  | 3m     | 353ms | 1.10s | 2.48s | 28.6s | 50.0 | 0.36%  | fail    | n/r         | 170ms    | 491ms    | 112ms      | n/r       | 0.41       | 48%               |
| search  | 32  | 3m     | 163ms | 499ms | 879ms | 2.23s | 50.2 | 0      | pass    | 2.3         | 6ms      | 45ms     | 97ms       | n/r       | 0.39       | 48%               |
| confirm | 32  | 5m     | 173ms | 600ms | 1.14s | 8.99s | 45.4 | 0.08%  | fail    | n/r         | n/r      | n/r      | n/r        | n/r       | n/r        | n/r               |
| confirm | 10  | 5m     | 146ms | 289ms | 427ms | 577ms | 18.5 | 0      | pass    | n/r         | n/r      | n/r      | n/r        | n/r       | n/r        | n/r               |
| confirm | 10  | 5m     | 145ms | 287ms | 416ms | 864ms | 18.5 | 0      | pass    | n/r         | n/r      | n/r      | n/r        | n/r       | n/r        | n/r               |
| confirm | 10  | 5m     | 161ms | 800ms | 2.86s | 19.6s | 12.8 | 0      | pass    | n/r         | n/r      | n/r      | n/r        | n/r       | n/r        | n/r               |
| probe   | 32  | 3m     | 166ms | 558ms | 888ms | 1.75s | 50.1 | 0      | pass    | n/r         | n/r      | n/r      | n/r        | n/r       | n/r        | n/r               |

Against the baseline, 100 VUs now carries 54.9 rps instead of 38.3, with p50 719ms instead of 1.17s and
p95 1.90s instead of 3.44s. The highest level that passes moved from 10 to 32, and the first level that
fails moved from 20 to 55. The slow end did not improve: the max at 100 VUs went from 8.54s to 27s, and the
last 10 VU confirmation saw 19.6s.

## What is the bottleneck now

The sweep above ran with the pool at 20, and at 20 the pool was the wall. Each row is read as an
`increase` over the 3 minute measure window: mean query time times queries per second is the number of
queries in flight, and the wait is the other half of the request.

| Pool 20           | 32 VUs | 55 VUs | 100 VUs |
| ----------------- | ------ | ------ | ------- |
| p50               | 163ms  | 353ms  | 719ms   |
| p95               | 499ms  | 1.10s  | 1.90s   |
| p99               | 879ms  | 2.48s  | 3.26s   |
| max               | 2.23s  | 28.6s  | 27.0s   |
| rps               | 50.2   | 50.0   | 54.9    |
| errors            | 0      | 0.36%  | 0.08%   |
| verdict           | pass   | fail   | fail    |
| queries/req       | 2.3    | n/r    | n/r     |
| wait p50          | 6ms    | 170ms  | 505ms   |
| wait p95          | 45ms   | 491ms  | 1.31s   |
| query mean        | 97ms   | 112ms  | 116ms   |
| query p95         | n/r    | 276ms  | 360ms   |
| CPU (of 4)        | 0.39   | 0.41   | 0.38    |
| memory (of 256Mi) | 48%    | 48%    | 44%     |
| queries/s         | 114    | 121    | 116     |
| in flight         | 11.1   | 13.6   | 13.5    |

At 32 VUs nothing waits on the pool, and the latency is the round trips: 2.3 queries per request at about
100ms each. `/stats/analytics` is still the slowest app-owned route at 1.41s p95.

At 55 VUs every route multiplies: analytics 1.41s to 7.75s, messages 0.7s to 5.08s. That is the pool of 20 running out, not the app work changing. At 100 VUs the wait is most of the request: 505ms of a 719ms p50, and 1.31s of a 1.90s p95. The mean query stays flat, 97 to 116ms across

CPU stays near a tenth of the four cores and memory near half of 256Mi in all three windows, so neither is the ceiling.

## The pool probes

So I was wondering why I had 1.31s just for waiting a pool queue at p95 at 100 VUs, and I figured why not increase the pool size to maybe lessen the waiting of the pool and here are the results.

| Pool / VUs        | 20 / 55 | 20 / 100 | 40 / 55 | 40 / 100 | 80 / 55       | 80 / 100 |
| ----------------- | ------- | -------- | ------- | -------- | ------------- | -------- |
| p50               | 353ms   | 719ms    | 218ms   | 498ms    | 216ms         | 482ms    |
| p95               | 1.10s   | 1.90s    | 832ms   | 1.64s    | 820ms         | 1.87s    |
| p99               | 2.48s   | 3.26s    | 1.62s   | 3.43s    | 1.71s         | 4.30s    |
| max               | 28.6s   | 27.0s    | 3.62s   | 59.0s    | 3.87s         | 8.15s    |
| rps               | 50.0    | 54.9     | 70.3    | 66.7     | 71.1          | 75.0     |
| errors            | 0.36%   | 0.08%    | 0       | 0.16%    | 0.008%        | 0        |
| verdict           | fail    | fail     | pass    | fail     | fail (checks) | fail     |
| queries/req       | n/r     | n/r      | n/r     | n/r      | n/r           | n/r      |
| wait p50          | 170ms   | 505ms    | 5ms     | 209ms    | 5ms           | 6ms      |
| wait p95          | 491ms   | 1.31s    | 10ms    | 838ms    | 10ms          | 162ms    |
| query mean        | 112ms   | 116ms    | 150ms   | 163ms    | 124ms         | 248ms    |
| query p95         | 276ms   | 360ms    | 451ms   | 433ms    | 336ms         | 797ms    |
| CPU (of 4)        | 0.40    | 0.39     | 0.54    | 0.52     | 0.59          | 0.64     |
| memory (of 256Mi) | 50%     | 46%      | 52%     | 56%      | 64%           | 74%      |

Raising the pool was the largest single move after the six changes: 40 turned 55 VUs from a failure into
a pass and cut the wait at 100 VUs from 505ms to 209ms. At 80 the wait all but disappears at 100 VUs,
6ms at p50 against 209ms, but the queries themselves slow down: the mean query goes from 163ms to 248ms
and the p95 from 433ms to 797ms. The request p95 ends up worse, 1.87s against 1.64s, and memory goes from
56% to 74% of the 256Mi limit.

That is why 80 is flat at p50 and slower at p95: no one waits for a connection, but every query runs
against a busier Neon. A request that pays two or three queries at the p95 lands near two seconds with no
queue at all.

And so I shipped 40 as my pool size.

So currently 55 VUs is the SLO boundary, not the actual ceiling of the application or machine. The app keeps serving past it because machines don't care about your gates it will always still serve request.

## Result

The boundary after each change, in the order the runs happened:

| When       | Config                      | Passed once  | rps there | First fail |
| ---------- | --------------------------- | ------------ | --------- | ---------- |
| 2026-10-22 | pool 10, before the changes | 10           | 17        | 20         |
| 2026-10-23 | optimized changes (pool 20) | 32           | 50        | 55         |
| 2026-10-23 | pool 40                     | 55           | 70        | 100        |
| 2026-10-23 | pool 80                     | 55 (latency) | 71        | 100        |

Only 10 VUs passed the plan's three 5 minute confirmation. Everything above it is one window.

## Batching

To help me simplify what I used for optimizing request and queries. I made me my own understanding of four layers of batching techniques. And They sit at different points between the client and the database helping me find the bottleneck may be and give me a comparsion what I could be missing.

Request Batching means one request where several used to go out. Think of one call that asks for a batch of records instead of one call per record.

Aggregate Queries means one statement where several reads used to run. Think of one query that returns five counts instead of five queries.

Bulk Write means one statement where several writes used to run. Think of one statement that spends the turn credit and stores the message, instead of one statement each. Used for the chat turn.

Group Commits means several database writes grouped into one round trip or transaction. Think of one transaction for several writes instead of one commit per write. I didn't use this fourth layer here. I often see it handled manually in SQLite, whereas Postgres handles transaction logging automatically via the WAL, with group commits optimized at the database engine level.

| Layer             | What gets fewer    | Where it sits      | Generic software example                              |
| ----------------- | ------------------ | ------------------ | ----------------------------------------------------- |
| Request Batching  | HTTP requests      | client to server   | one call for a batch of records, not one per record   |
| Aggregate Queries | SQL reads          | server to database | one query for five reads, not five queries            |
| Bulk Write        | SQL writes         | server to database | one statement for several writes, not one per write   |
| Group Commits     | commit round trips | database writes    | one transaction for several writes, not one per write |

I also did some extra stuff like parallel request. Parallel requests are a separate technique, not really something I would group to batching. Two calls run at the same time and it is not one call carrying both. So instead of reducing the number of requests to save overhead, parallel requests just pay the full network tax for multiple requests simultaneously instead of waiting for one request at a time.

## Change in harness

| Setting             | The run in this record            | Current harness                   |
| ------------------- | --------------------------------- | --------------------------------- |
| Ladder measurement  | 3 min                             | 2 min                             |
| Confirmation        | 3 runs of 5 min, repeated 3 times | two 5 min windows, both must pass |
| Failed confirmation | Search below, up to 3 times       | Abort; boundary unproven          |
| Search resolution   | 25 VU floor                       | 5 VU floor                        |

I changed the measurement window to 2 minutes and the confirmation to two 5-minute runs because the sweep was taking too much of my time, and I am fine losing some of this data for the experiment. The shorter windows also spend less Neon compute, which is the other reason for the change: the full sweep is paused near the free-tier limit. That is a real trade: fewer samples make p95 and p99 noisier, two runs are weaker proof than the old 3/3. But with my usecase and constraints I opted for that tradeoff for my scale.

## The request batch build at 100 VUs

| At 100 VUs        | Pre-batching, pool 40 | Batched build | Round-trip build |
| ----------------- | --------------------- | ------------- | ---------------- |
| p50               | 498ms                 | 494ms         | 586ms            |
| p95               | 1.64s                 | 1.87s         | 1.76s            |
| p99               | 3.43s                 | 3.78s         | 3.04s            |
| max               | 59.0s                 | 6.45s         | 4.17s            |
| rps               | 66.7                  | 62.8          | 68.5             |
| errors            | 0.16%                 | 0             | 0                |
| verdict           | fail (p95, checks)    | fail (p95)    | fail (p95)       |
| queries/req       | n/r                   | 2.43          | 1.89             |
| wait p50          | 209ms                 | 123ms         | 180ms            |
| wait p95          | 838ms                 | 570ms         | 742ms            |
| query mean        | 163ms                 | 150ms         | 212ms            |
| query p95         | 433ms                 | 462ms         | 649ms            |
| CPU (of 4)        | 0.52                  | 0.47          | 0.59             |
| memory (of 256Mi) | 56%                   | 62%           | 65%              |

### The batched build

| Change      | What changed                             | Counts          | Layer                               |
| ----------- | ---------------------------------------- | --------------- | ----------------------------------- |
| turn credit | one atomic upsert                        | 2 -> 1          | Atomic write                        |
| dashboard   | one statement carries both reads         | 2 requests -> 1 | Request Batching, Aggregate Queries |
| resume page | usage read beside the resume read        | no change       | Parallel requests                   |
| chat page   | transcript read beside the start request | no change       | Parallel requests                   |

### The round-trip build

| Endpoint                                  | Method                                                                                                         | Counts   | Layer                         |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------- |
| `POST /interviews/{id}/chat/stream`       | duplicate tier read removed, transcript folded into the interview read, spend and user insert in one statement | 8 -> 5   | Aggregate Queries, Bulk Write |
| `POST /interviews/{id}/chat/kickoff`      | duplicate tier read removed, transcript folded into the interview read                                         | 7 -> 5   | Aggregate Queries             |
| `GET /interviews/{id}/messages`           | ownership check folded into the read                                                                           | 2 -> 1   | Aggregate Queries             |
| `GET /interviews/{id}/feedback`           | ownership check folded into the read                                                                           | 2 -> 1   | Aggregate Queries             |
| `POST /interviews/{id}/feedback/generate` | four guard reads into one SELECT                                                                               | 14 -> 11 | Aggregate Queries             |
| `POST /resumes/{id}/review`               | duplicate tier read removed                                                                                    | 6 -> 5   | Aggregate Queries             |
| `POST /resumes/{id}/review/rewrite`       | duplicate tier read removed, resume and review in one read                                                     | 7 -> 5   | Aggregate Queries             |
| `GET /templates`, cold account            | seed returns the rows it inserted                                                                              | 3 -> 2   | Aggregate Queries             |

This batched build focused on some of the heavy queries and a pararrel request where I could apply it. As you can see not much of a difference in movement since this was not really the bottleneck and more focused on reducing queries per request, as you can see the latency had marginal shift but our queries per request reduced because of these optimization. I am quite suprise with these results, I though it would move drastically but since the endpoints that I optimized doesn't really focus on the harness on the endpoints that it hits frequently.
