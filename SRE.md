# SRE

This file owns the run: the architecture it measures, the indicators it produces, the workload, the config the app runs under, and the decisions behind all of it.

Some tables below restate owners that already exist, on purpose, so a run can be read from one file: the manifests hold the dependency lists, the modules hold the constants, `OBSERVABILITY.md` holds the metrics, README holds the request path. Those stay the owners. This file is the copy that goes stale.

## The question

At what load does the prod deployment stop behaving acceptably, and which resource runs out first.

Not a user count, because that is not answerable without fixing what a user does. Not a host-versus-k3s comparison either, since I am keeping k3s and that run had no decision attached to it.

## Architecture

Two paths, both ending in the same pod.

```
Run 1, the public path
  k6 (Windows box) -> Internet -> Cloudflare edge -> cloudflared -> ingress-nginx -> pod

Run 2, the capacity path
  k6 (Windows box) -> Tailscale -> ingress-nginx -> pod

Either way
  pod -> Neon            (direct host, TLS)
  pod -> Alloy           (in-cluster) -> Grafana Cloud
```

The app's own request path, its middleware order and the layer breakdown are in the README's `## Architecture` section. What matters here is the composition of a single turn.

- two reads to open the session, the interview row and then its transcript
- one read and one upsert for the turn credit
- sometimes a delete and an insert, the trailing-user-turn repair
- one insert for the reply

**Every one of those reads is a network round trip to Neon, not a local call.** That is the material the number is made of.

There is no model hop to account for. Every stub branch in `llm.py` returns before the HTTP client is constructed, so the sweep measures the app's own work: HTTP, JSON, SSE framing, and the database round trips. `llm.client.call.duration` still records one sample per turn from the local stub, so a near-zero series is the expected shape and not a missing one.

`finish` adds the review computation and its writes. The generator is deterministic under the stub and never returns None, so the retry loop's three attempts and 800ms pauses stay unarmed unless a write itself fails.

## The two runs, in order

| #   | Run        | Path                                                     | What it is for                                                    |
| --- | ---------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | Cloudflare | k6 -> Internet -> Cloudflare -> tunnel -> ingress -> pod | 5 VUs. Does the public path add latency, and does SSE survive it. |
| 2   | Capacity   | k6 -> Tailscale -> ingress -> pod                        | The sweep.                                                        |

One k6 script, one workload, one think-time distribution, both paths. Only the network changes, and the two results are reported separately, never merged. The Cloudflare run goes first because bot protection has to come off for it anyway, and I would rather put that window behind me.

The generator is the Windows box, off-node, so k6 does not compete with the app for the same four cores. Tailscale adds WireGuard and a 1280 MTU, so the capacity number describes an isolated remote client and not a loopback baseline.

The public run passes when, over its step: every response is a real API response rather than an HTML challenge, no 429 appears, every SSE stream reaches its `done` frame instead of being truncated, and p95 sits within a multiple of the same workload on the capacity path. The first three are k6 thresholds, so a trip fails the run rather than being read past, and the latency figure is only reported from a run that passed them. A trip is not an app result: it says the edge will not carry automated traffic, which is a finding about Cloudflare and belongs in its own note.

## What is measured

| Indicator          | Source                                                      | Carries                                                                 |
| ------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| Request latency    | `http.server.request.duration`, and k6 on the client side   | method, route, status                                                   |
| Model-call latency | `llm.client.call.duration`                                  | stage (chat, judge, grader, formatter, classify, shout), model, outcome |
| Error rate         | the same two histograms, plus k6 broken down by status code | status                                                                  |
| Throughput         | k6 RPS, and the server histogram's own sample count         | route                                                                   |
| Database pressure  | connections in use against a pool of 10                     |                                                                         |
| Saturation         | CPU, frequency, temperature, load, memory                   |                                                                         |

Bucket boundaries are pinned in the SDK rather than left to its defaults, and they run from 0.01 to 120 seconds.

Four more are recorded for this experiment. `db.pool.wait.duration` and `db.query.duration` are sampled apart inside `db.py`, so a queued connection and a slow query are distinguishable, and the query label is the statement's first keyword, which keeps the label set bounded and the query text off the metric. The pod's restart count and last termination reason say whether a failure was the 256Mi limit rather than the node. Alloy's own CPU and its dropped-batch signal, which already feeds a Grafana alert, say whether the collector became the bottleneck.

Three properties of the instrumentation matter to this experiment.

`/api/health` creates no span, no sample and no line, by design. Health probes never appear in the server-side metrics, so load put on that path is invisible from the server's own account.

The route label is the matched template and never the raw path, so the label set stays bounded and a scanner sweeping URLs cannot mint a series per URL.

The server histogram covers the whole response body, which means an SSE turn's sample is time-to-last-byte. That is why streams report separately from the plain reads.

The access line carries `request_id`, `trace_id`, `span_id`, `status` and `duration_ms`, and it is the join between a k6 failure and the server's own account of what happened.

Both server-side indicators only exist when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. With it unset the SDK is never installed and every call site is a no-op, so the server emits nothing at all.

The runner's own CPU and network get sampled on the Windows box during each step, `Get-Counter` or `typeperf` to a CSV per step, recorded with the k6 summary. k6 saturates before the target does at some point, and without that baseline a flattening curve has two possible authors.

The turn counter's contention has no app metric. If the curve bends before the hardware explains it, `turn_usage` is the first suspect, and the evidence is lock waits on the Neon side rather than anything in the dashboards.

## SLO

One gate shape, and the gates themselves come from the baseline.

A step passes when, for that step, p95 latency stays under the gate, the error rate stays under the gate, and neither is explained by my own config. A quota 402, a template or resume cap 409, and the arc-spent 409 are all excluded from the error rate by status and route. They are walls I built, not capacity.

Everything else that comes back has a class, so the error rate is a count rather than a judgement made after the fact.

| Result                                 | Class                                        |
| -------------------------------------- | -------------------------------------------- |
| 402 from the turn quota                | my config                                    |
| 409 from a cap, or the arc-spent 409   | my config                                    |
| 422 from a malformed test payload      | test bug, and the script is the fix          |
| 429                                    | whichever limiter produced it, so config     |
| 5xx                                    | app failure                                  |
| timeout                                | capacity                                     |
| a stream that ends without `done`      | app or network failure                       |
| a dropped k6 iteration                 | the runner is the suspect                    |
| a pool acquire timeout                 | dependency saturation                        |
| a pod restart                          | the 256Mi limit, which is not node capacity  |

The gates, one per indicator that can fail a step:

| Indicator                          | Gate                                               |
| ---------------------------------- | -------------------------------------------------- |
| p95 latency, plain reads           | from the baseline                                  |
| p95 time-to-last-byte, SSE turns   | from the baseline                                  |
| error rate, my own config excluded | from the baseline                                  |
| throughput                         | none. It is the experiment's output, not a target. |

The rule for setting them: run the baseline at a load the box is comfortably not stressed by, take its p95, and multiply it by a factor. The factor is chosen and written down **before the sweep starts**, because the baseline is the only input it is allowed to have. Picking one after a step looks bad is moving the goalposts, and that is the whole reason the gates are empty until then.

Until then this table stays empty on purpose. A threshold invented before the measurement is a threshold I would then spend the sweep trying to justify.

Stop conditions: I stop at the first step where the error rate moves for a reason that is not my own config, and I call it saturated when two consecutive steps show a latency inflection with the resource that moved first identified.

## What one virtual user does

A virtual user drives the app the way a person would. It creates an interview, answers it, finishes it, reads the review, then moves on to whatever else the app offers. Any endpoint a signed-in user can reach is in scope, so this measures the app's surface and not one route.

The number of chat turns is randomized per run. A fixed count makes every virtual user do identical work, and the arc is a function of the interview's dials, so a fixed count also has to be tuned to sit inside that arc or the send takes a 409.

`finish` is the heaviest single request in the loop. It generates and persists the review inside the same call, with up to three attempts and an 800ms pause between them, so the stub makes the generation cheap but the retries multiply the writes if the database is slow.

Three caps bound how much of the surface the loop can actually reach, because every virtual user is the same identity and they all share one account. Chat turns per UTC day, one counter for the whole sweep, a 402 when it runs out, and with a random turn count the total is not known before the sweep. Templates, capped at 20 (a constant, not an env). Resumes, 10 on this tier. Those last two answer with a 409. All three are walls in my own config, so a 402 or a 409 from them is not capacity and does not belong in the 5xx count.

Two endpoints are not stubbed by anything in the perf window: `/voice/tts` and `/voice/stt` call Cloudflare Workers AI and spend a real daily allocation. Putting them in the loop brings a third vendor inside the measurement.

Two exclusions, for different reasons.

**PDF import is out of the loop.** `PLAN.md` has the measurement: a 40MB `/Contents` peaks 1.74GB for zero characters of text against a 256Mi pod limit, so one upload can OOMKill the only replica. That would read as a capacity failure when it is a known unfixed bug, and it is its own piece of work.

**`hardcore` stays off.** It is a dial on the create payload, defaulting to false. Under the stub the judge indexes a fixed cycle, `good, inaccuracy, great, book, mistake`, by turn, and `inaccuracy` is a failing class, so a hardcore run ends at turn 2 and every later turn is a 409. Nothing is broken: that is the feature working. It is simply a two-turn workload rather than a full one, and the script has to know which it is running.

## What each iteration asserts

Latency says nothing about whether the app worked, so each iteration checks, as k6 checks, that a failure lands in the same report as the timings.

- the interview was created and came back with an id
- the opener streamed and ended with `done`
- every answer streamed and ended with `done`
- the transcript holds one assistant reply per user turn, so a dropped or duplicated turn fails the run
- `finish` returned the completed status
- `GET /feedback` returned a review for that run

A sweep that passes on latency while any of those is false is not a pass.

## What the reads cost

The reads that scale with history are in the loop, so the loop's own writes change them. `GET /api/interviews` returns every run for the owner with no limit, and the stats endpoints re-scan the full history. Left alone, a later step reads a bigger account than an earlier one did, and part of any curve is data the test itself created.

So the rows go between steps. Every other test here cleans up after itself and this one does the same, which holds the account at a constant size and stops growth from presenting itself as capacity loss.

## Perf window

The pod is not patched with `kubectl set env`. Argo reconciles the prod overlay and self-heals drift, so a patch is a race with the reconciler. The values go into the overlay as a commit, Argo syncs, the runs happen, the commit is reverted, Argo syncs back.

| Change              | Value                        |
| ------------------- | ---------------------------- |
| `LLM_BASE_URL`      | unset (stub)                 |
| `RATE_LIMIT`        | `off`                        |
| `DEV_CHAT_TURNS`    | raised past the sweep budget |
| `CLERK_ENABLED`     | `false`                      |
| `APP_ENV`           | `test`                       |
| ingress `limit-rps` | raised                       |

`APP_ENV=test` does two things beyond letting Clerk off, and I am accepting both. `/api/billing/webhook/simulate` becomes reachable and calls `payments.handle_webhook_event` with no auth, so that route is open for the window. And structlog switches to `ConsoleRenderer`, so Loki loses its structured fields: the log-based Grafana rules stop matching, one of them reads `event="browser.error"`, and the derived `trace_id` field goes with them, so log-to-trace linking is dark until the revert. The log volume I record for the window is therefore console output and is not prod's telemetry cost. Analysis during the window comes from the metrics and the k6 output, and Loki is for reading by eye.

The window ends by reverting the commit and waiting for the sync, then reading the running pod's env directly to confirm `CLERK_ENABLED` is true, `RATE_LIMIT` is not `off`, and `APP_ENV` is production. A sync that reports success is not a pod on the real config, and a revert that silently fails leaves prod with the billing simulate route open and no login.

The sweep runs as its own identity. `DEV_USER_SUB` names it and `auth.py` reads it, so the run holds its own interviews and its own `turn_usage` row instead of moving `dev-user`'s. Prod's dev rows and that account's daily turn counter stay where they are, and the cleanup deletes a set of rows that is known to be the sweep's.

The stub is read at import. Confirm it is live before the sweep rather than after.

## Configuration

### The box

RPi5, 8 GB, four Cortex-A76 cores.

### Deploy

| Setting          | Value                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| replicas         | 1, no autoscaler, no HPA, no KEDA                                                                                                                                              |
| pod memory limit | 256Mi                                                                                                                                                                          |
| uvicorn workers  | 1, the Dockerfile passes no `--workers`                                                                                                                                        |
| probes           | `/api/health`, shallow and with no DB call, and the backend drops it from the access log by path (`logs.py::SKIP_PATH`), so probe traffic reaches neither Loki nor the metrics |
| ingress          | `limit-rps 30, burst 20` per source IP, `proxy-body-size 10m`                                                                                                                  |
| telemetry        | OTLP to the in-cluster Alloy receiver, which is the only holder of a write credential                                                                                          |
| database         | Neon direct host, not `-pooler`, TLS required                                                                                                                                  |

The overlay itself lives in the gitops repo, so those values are read from there and not from this file.

### The app's own limits

These bound what one client can do, so they set the roof on the loop.

| Limit                    | Value                                                        |
| ------------------------ | ------------------------------------------------------------ |
| DB pool                  | `max_size=10`, `min_size=0`                                  |
| rate limit               | 120/minute per client IP by default, `off` in the window     |
| chat turns per UTC day   | 10 free, 100 premium, 500 dev                                |
| review redos per run     | 1 free, 10 premium, 10 dev                                   |
| resumes                  | 1 free, 10 premium, 10 dev                                   |
| templates                | 20, a module constant                                        |
| resume parse concurrency | 2                                                            |
| feedback attempts        | 3 attempts, 800ms apart                                      |
| voice                    | 2 concurrent calls, TTS capped at 600 chars, uploads at 8 MB |

## What stops the sweep first

Ordering matters more than the numbers here, because a sweep that dies for a boring reason teaches nothing.

The ingress `limit-rps 30, burst 20` per source IP as the ingress sees it. That is 9,000 requests in a five minute step, and it becomes the front wall as soon as `RATE_LIMIT=off` removes the app limiter. If the box serves more than 30 requests a second, the ingress hides it and the result is an ingress-nginx number, so it gets raised in the same commit.

Then the turn quota, one bucket shared by every VU. Then the turn counter itself: `turn_usage` is keyed `(owner_id, day)` and `bump_chat_turn` upserts that single row on every turn, so all VUs queue on one tuple and each wait costs a Neon round trip. At 30 requests a second that queue can bind before the Pi does, and it belongs to the one-identity choice rather than to the hardware. Then the asyncpg pool at `max_size=10`, which is the database concurrency ceiling. Then pod memory at 256Mi, which on this box is the likelier failure before CPU.

Not on that list: Neon's `max_connections`. It is 104 at the smallest compute and 839 at the Free ceiling, against a pool of ten. The app asks for ten.

## The two vendors

### Neon

The sweep runs against prod's default branch, so it spends prod's own budget and its rows land in prod's data. The cleanup between steps is what keeps that bounded instead of accumulating.

- 100 CU-hours of compute per project per month. 2,932 CPU-s were used at the last check.
- Scale to zero is always on and cannot be disabled. Computes suspend after five minutes idle, so the wake sits on the path of the first request after a gap. Warm it and discard the warmup.
- Autoscaling tops out at 2 CU on Free.
- 5 GB of network transfer per project per month.

### Cloudflare

- Bot Fight Mode cannot be skipped. WAF custom rules and Page Rules both fail against it, because it does not run on the Ruleset Engine. That is the Free plan; Super Bot Fight Mode on Pro is skippable.
- The only lever on Free is an IP Access rule, and any IP Access rule present disables BFM for the whole zone. There is no narrow exception for the runner, only a zone-wide one. Off for the public run, recorded, and restored and verified before the capacity sweep starts, so the two runs never share a configuration state.
- The second question the run answers is whether SSE survives the edge. Every chat turn is a stream, which is why nginx sets `proxy_buffering off`.

## Tools

### The app

| Layer         | What                                                                |
| ------------- | ------------------------------------------------------------------- |
| Runtime       | Python 3.13, FastAPI, uvicorn with a single worker                  |
| Data          | asyncpg against Postgres, yoyo for migrations                       |
| Validation    | Pydantic                                                            |
| Logging       | structlog, one JSON access line per request                         |
| Telemetry     | OpenTelemetry SDK, OTLP over HTTP to the in-cluster collector       |
| Auth          | PyJWT verified against Clerk's JWKS, with a cached key set          |
| HTTP client   | httpx, for the model provider and for Workers AI                    |
| Rate limiting | limits, in-process memory storage, so the budget is per replica     |
| Documents     | pypdf for resume import                                             |
| Frontend      | React 19, Vite, TypeScript, Tailwind, Clerk React, axios, recharts  |

### The experiment

| Purpose               | Tool                                                |
| --------------------- | --------------------------------------------------- |
| Load generation       | k6, on the Windows box                              |
| Private path          | Tailscale                                           |
| Orchestration         | k3s, ingress-nginx, Argo CD, Kustomize              |
| Public edge           | Cloudflare and cloudflared                          |
| Metrics, logs, traces | Grafana Cloud, with Alloy as the in-cluster shipper |
| Database              | Neon, prod's default branch, direct host             |
| Voice                 | Cloudflare Workers AI                               |
| Secrets               | Infisical                                           |
| Images                | GHCR, built in GitHub Actions, scanned with Trivy   |

## Between steps

Warm the database. `min_size=0` means the first requests pay pool creation and a fresh TLS handshake, and Neon scale-to-zero means the first request after an idle gap pays the compute wake.

Every step runs the same four phases and only the third is data: a 30 second ramp to the target, a 60 second warm-up that is discarded, a 300 second measurement window, and a stop. Seven minutes of wall clock, five minutes of measurement, and the warm-up never becomes part of a number.

The ladder is 10, 25, 50, 100, 200 and 400 VUs. Fine-grained at the bottom, where a pool of ten is the expected wall, and coarser above it. The first failing step brackets the answer, the ladder bisects that interval until one rung is left, and then the candidate is confirmed rather than declared: the baseline, the candidate and the first failing step each run three times, and results that differ materially get investigated rather than averaged.

## Decisions

1. k3s only, no host run. I am keeping k8s, so host-versus-k3s had no decision attached. Rejected: the host run, which answers a question I am no longer asking.
2. The prod pod patched, not a second Deployment. On a single node a second pod fights the prod pod for the same four cores, so its number is not prod's number. Rejected: a parallel Deployment, which measures a pod no user will hit.
3. The values go through the gitops overlay. Argo self-heals drift, so `kubectl set env` is a race with the reconciler. Rejected: patching the running pod.
4. Prod's default branch, not a Neon branch. Every VU is one `dev-user` either way, so a branch would isolate rows and change nothing about contention, at the cost of a second compute and a Secret swap. This is a deliberate override of D11, which says branches are for PR and migration rehearsal and that prod's default branch is never used for this. D11 needs a carve-out, or the override needs recording there.
5. The Cloudflare run first and separate, 5 VUs. Rejected: Cloudflare in the capacity path, where the number measures Cloudflare.
6. Bot protection off for that run. Rejected: leaving it on, which makes the run an observation about Cloudflare rather than a latency figure.
7. `APP_ENV=test` with Clerk off, and the simulate route left open. Both side effects accepted and recorded above. Rejected: staying on production with minted Clerk tokens, which keeps JWT verification in the measured path but makes Clerk a dependency of the sweep.
8. A full run per virtual user with a randomized turn count, plus any other endpoint a signed-in user can reach. Rejected: a fixed count, which makes every virtual user do identical work and has to be tuned to sit inside the arc; and a reads-only loop, which never touches the streaming path.
9. Step-load then binary search, with the phases and the ladder written above. Rejected: one high ladder, which assumes where the interesting region is.
10. Telemetry stays on and gets recorded as cost. Rejected: turning it off, which gives a cleaner app number at the price of the deployed configuration.
11. The model stubbed for the sweep. Rejected: real generation, where the ceiling is the provider's quota and not this one.
12. No autoscaler. One replica is the experiment, not a limitation to work around.
13. Direct host, not the pooler. A `-pooler` DSN flips `statement_cache_size`, a different code path than prod runs.
14. SLO gates derived from the baseline, not set in advance. Rejected: provisional thresholds, which are numbers chosen before the measurement they are supposed to judge.
15. The sweep runs under its own identity, named by `DEV_USER_SUB`. Rejected: leaving it as `dev-user`, which puts the run's rows and its daily turn counter on the same account dev uses, and makes the cleanup inseparable from real data.

## Open

- `kubectl top` fails on a kubelet certificate SAN. Fix is `--tls-san` plus a brief apiserver restart. Until then host CPU and temperature come from `vmstat` and `htop`.
- The baseline run itself, which produces every SLO gate.

### Holes found while verifying

1. **The runner sampler is not built.** CPU and network on the Windows box, per step, recorded with the summary, is the method. Nothing produces it yet.
2. **Prod's schema has to be current before the sweep.** With no branch there is nothing to inspect but prod, so confirm `0019_review_redos` is in yoyo's version table first. If prod is behind, the run measures a schema the deployed app does not expect.
3. **Argo self-heal is unconfirmed.** The revert assumes the sync puts the pod back, and the start of the window assumes the same mechanism applies the perf commit. Both directions depend on one setting nobody has read yet.

## AI HERE

One replica, no autoscaler, model stubbed, JWT verification out of the path. Ceiling: the sweep gives this app's capacity with the external generation replaced and the database at whatever RTT the network gives, and it is not a user count. Upgrade path: HPA or KEDA only after this baseline exists, so their effect has something to be measured against.
