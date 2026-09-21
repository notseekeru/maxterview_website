> To AI reading this, do not implement. This is just notes of the user, strictly ignore this unless prompted to.

# MILESTONE

- add some evals for ai quality
- the voice feature and tts with video input from user
- add caching in redis

# FEATURES

- feat: comment per interview messages, so it gives tips on every messages might be complicated cuz you need to make a comment for every messages can create N problems but seems doable considering small N number of messages. ask me question if needed and uncertain
- feat: offer letter simulation for soft skill communication assesment and add average offer and benefits analytics
- feat: ai resume editor latex to display and edit kind alike overleaf?

# FIX

- fix: make hardcore path at the end llm generated cuz currently its determistic and auto complete on the callout and also make all the message caps automatic and seemed angry and then we audit also that we dont have to recompute at something here right cuz we recalculate the moves bluneder to brilliant all over again when hit complete. it seems architecture is mangled. ask question if uncertain of understanding and scope
- fix: global comment removal, if the code looks obvious/trivial and does not need comment -> delete. if related to infra, or could potentially be devastating if not stated -> keep. audit first, rate by removal and recommended deletion. then update agent.md for guardrailing against this. ask question before proceeding
- fix: dont say premium to users like explicitly just upgrade to premium something to get ---, ask question if uncertain like we use like physicological and marketing tactics
- grill the plan and architecture and code maintainability/readability. it matters to me when i skim code
- observability shipped (tier 1 app-side, tier 2 Loki + alerts) → next: blog post, then resume + analytics page, then recordly assets (portfolio + landing opener)

# REFACTOR

- refactor: how about we make development vars put into development env of infisical? but that would be creating a dependency to use internet just to fill the vars? but what if we boot strap and injected to .env so it works offline?

# INFRA

## Observability pipeline (shipped, see OBSERVABILITY.md)

Logs are the only signal; every number is derived from them. No app-side metric/trace SDK, and the app
never holds a telemetry credential.

- **Emission** — structlog + a `ProcessorFormatter` bridge, so our events _and_ stdlib records (uvicorn
  tracebacks, httpx) become one JSON line to stdout in prod. `request_id` is bound per request and echoed
  as `X-Request-ID`; identity comes from `scope["state"]` because the rate limiter's `BaseHTTPMiddleware`
  blocks contextvars from travelling back up. `/health` is skipped at the source — that IS the log shaping.
- **Shipping** — Alloy, a 1-replica Deployment (not a DaemonSet), tails pod logs through the Kubernetes
  API: no hostPath, no privileged container, and the namespaced Role _is_ the scope
  (`namespaces { own_namespace = true }` — discovery lists cluster-wide by default and 403s otherwise).
  `drop` on Succeeded/Failed phases, or a finished Job pod gets re-tailed in a hot loop.
- **Store** — Grafana Cloud Loki, 14-day retention. Lines stay unparsed JSON; parsing happens at query
  time (`| json`), so labels stay low-cardinality (namespace/pod/container/app + cluster).
- **Derived metrics** — every number is a LogQL aggregate (`count_over_time`, `quantile_over_time` over
  `duration_ms`). True histograms and history past 14 days are exactly the OTel trigger, not a now-need.
- **Alerts** — 3 Grafana-managed rules in folder `maxterview`, default policy → Slack (webhook at Infisical
  `/sources/webhooks`). Always `noDataState: OK`: a quiet stack stays quiet.
- **Credential homes** — Loki write token: Infisical → TF secret `maxterview-logs` (scope `logs:write`,
  verified write-only); Grafana service-account token: root `.env`, read by `.mcp.json` via `!sed`;
  browser error path holds no third-party credential.
- **Gotcha** — Alloy reads its config at startup and Argo restarts nothing on a ConfigMap change, so the
  `maxterview/config-hash` annotation must be bumped with any config edit.
- **Parked, with triggers** — OTel/OTLP (a number needing true percentiles or >14d history), Tempo
  (latency crossing more than one hop), Faro (only after Tempo).

## LLM upgrade path (from the architecture audit)

Ranked by leverage, not effort. Tier 1 is cheap and is real engineering; Tier 2 only pays off once the
rail costs money or traffic is real. Measured ceiling today: ~28 concurrent normal users (~17 hardcore)
on the free-tier key, ~13-15 requests and ~19s for a 10-question run + Complete.

### Tier 1 - do these

- **Eval harness.** 98 stored interviews are a ready-made golden corpus. Freeze ~15 as fixtures,
  assert invariants (decision present, certainty in band, scores in range, classes valid, no
  self-contradiction like `reject` + all-floor scores + certainty 0), run before/after every prompt
  edit. Highest-leverage item here, and it is a script rather than a system. Today prompt changes
  ship unmeasured - including the injection guard.
- **Provider fallback chain.** primary -> secondary -> stub, so a 429/503/EOL id degrades instead of
  failing the turn or leaving Complete unscored. We hit all three in one day (429 burst, 503 under
  load, 410 end-of-life). `LLMConfig` is OpenAI-compatible everywhere, so this is a loop and a retry
  budget, not a rewrite.
- **Cheap lane for the mechanical hops.** Judge, moves and grader are classification, not writing.
  `LLM_GRADER_*` already routes two; the hardcore judge rides the same config and sits on the
  critical path (serialized before every hardcore reply). Config-only change.

### Tier 2 - when the rail costs money or traffic is real

- **Cache-aware prompt layout.** Move the volatile phase directive AFTER the transcript so system +
  transcript becomes a stable prefix. Worthless on NIM today (reports no cached tokens; repeat TTFT
  2.87s -> 0.89s, n=1), decisive on any provider that meters cached input.
- **Collapse grader -> formatter into one strict-schema call** for models that hold JSON. Takes
  Complete from 3 requests to 1 and deletes a hop that only exists because weak models drift.
- **Complete as a background job.** It is ~19s of held connection for zero user-facing reason (the
  grader alone is ~17.7s of it); queue it and let the review page poll.
- **Resume retrieval instead of re-sending 8k chars** every turn - pull only the sections the
  question touches. ~10x input reduction on resume-attached runs.

### Tier 3 - only if it becomes a business

- Tier routing (small model for free users), BYOK pushed harder (already built - the real cost escape
  hatch), streaming progress for the grader so the wait is legible.

### Not doing

- Fine-tuning or distilling into a local 4B (it cannot serve the load, and it would wreck the rubric -
  the value is the pipeline, not the model), vector DBs, agent/multi-model orchestration.

# PERF

Measured with a real browser, not guessed (headless Chromium, 1280x720, 102 interviews / 82 scored runs; Vite dev build, so StrictMode double-renders inflate both sides of any comparison).

- /analytics fps is mount work, not bundle weight. Warm reload is identical to cold (787ms vs 781ms main-thread task, same dip), so the 353KB recharts chunk and its parse have nothing to do with the frames, and AnalyticsPage was already lazy. Idle is 60fps with 0 mutations inside the chart subtrees, scroll 60fps, hover 59.5fps, so nothing leaks past mount. What did cost: three charts mounting in one commit, one 250ms bucket at 2fps, then 31/47/50/31/48/53, then 60 and stable.
- Shipped: `defer` charts queue at mount and are released in DOM order, 250ms apart, one slot open at a time (`GAP_MS`), with a Skeleton in the reserved box; every series draws in over `DRAW_MS` (350ms) instead of recharts' 1500ms default. Warm load, no scrolling: first paint mounts 0 charts and 5 skeletons, then the five land at 723/935/1231/1462/1723ms (gaps 212/296/231/261), the last draw-in settles at ~2.1s, and no skeleton survives the run. Long tasks 157/135/85/104/71/71ms, five blocks instead of one 341ms. The five boxes sit at 349/693/1005/1429px in an 8710px document with skeletons and with charts alike.
- Not taken: `isAnimationActive={false}` (measured 65,60,3,61,60,60 and a single long task back when three charts shared a commit) and `dot={false}`, which drops most of the 246 layers the nine series draw. Each mount still costs 70-135ms of long task and the draw-in only owns the tail, so neither lever buys the thing that hurts.

# MAXTERVIEW JOURNAL

- my existing infra (k3s, terraform, gitops, auto-commit pipeline) is why I can ship fast and automate deployments now. I built it before I needed it and I'm proud of that architecture
- wiring the Playwright MCP: I wrestled with it non-stop, making tradeoffs and doing research until the agent could see the DOM on its own
- Clerk, Stripe and PayMongo took a lot of third-party wiring, but it was worth it: setup and review happen by an agent now instead of me clicking through dashboards
- dev/stage/prod separation is another mental model I'm excited to show off. Staging is the one that needs injecting into my brain so I can practise how production deployment works
- setting up staging right now — I was surprised it needed a separate, extra environment, so I made another module for it in isolation. It should've been isolated, not shared; I should've seen that coming lol
- just finished staging: a lot of it I supervised with my AI, mostly watching it work and guiding what it struggled with. When it needed the Infisical vars it decided the CLI couldn't do it, and I pushed instead of accepting the model's word — I know the tool and why I'm using it. Someone who vibecodes would have trusted the model and moved on
- a lot got added to my infrastructure, and I try to keep it isolated, clear and cohesive while holding the whole system in my head. No big deal, just another mental model
- this is a little overengineered, and I'll probably turn staging off in the near future: I don't need it, I'm a 1-man team doing this for fun, and I have tradeoffs to manage. This isn't a real production product yet — no users, no stakes
- the staging aspect is now removed and verified: no more dev/staging/prod, just dev/prod
- next step was observability. I knew I needed it when my dev and prod weren't behaving exactly the same — at least then I could justify needing it
- been contemplating whether I needed Sentry, iterating on the same question a couple of times: is it really needed at this scale? The extra complexity for frontend error observability didn't feel worth it
- wired Sentry, verified delivery from a production bundle, then deleted it the same session. Its own gap list killed it: without sourcemaps the stacks were decoration, so 146 kB gz on every signed-in load bought grouping, an issue lifecycle and an email channel for traffic I don't have
- the one leg it held alone is the beacon's now: a render crash swallowed by ErrorBoundary never reaches window.onerror, so the boundary reports by hand — message + component stack. Backend tracebacks were always in Loki, and nothing on either side needs a third party
- Sentry comes back only with real users AND a decision to publish sourcemaps: symbolication is the one thing it's actually for
- I added a portable script for bootstrapping my grafana cloud stack so it replicates logs, alerts and dashboard which contains 3 of the 4 golden signals only missing is saturation(which I can't for now for pods. Database on the otherhand is captured at cloud at Neon database)
