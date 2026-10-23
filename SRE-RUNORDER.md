# SRE run order

## The target

| Thing            | Value                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| API base         | `http://100.64.1.1:30090/api`, a NodePort created with the perf-val-change and deleted with it |
| Host header      | none. The NodePort points at the backend Service, so no name routing is involved               |
| TLS              | none on this hop. It is plain HTTP over Tailscale, and Tailscale does the encryption           |
| Measured latency | single digit ms over the tailnet from the desktop, about 44ms from the laptop, which relays; 54ms on the public path |
| Server access    | `ssh -i ~/.ssh/piserver seeker@100.64.1.1`; the default identity list does not offer that key  |

The public URL works with k6, but it carries about half a second of Cloudflare and tunnel per request,
and it answers 403 with Cloudflare code 1010 to any client whose user agent it dislikes. It is the
probe's target, not the sweep's.

## Where things stand

| Thing                       | State                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness `~/k6-load-testing` | Clean. Flake, direnv, workload, ladder, cleanup budget, phase and window columns, both row counts                                                  |
| Plan `SRE.md`               | The spec, the decisions, and the run record                                                                                                        |
| Prod perf-val-change        | Closed. Two sweeps have run against prod; the boundary is in `## Result`                                                                           |
| Generator                   | This laptop: about a quarter of one core at 240 RPS, 1.15 CPU-seconds per 1,000 requests. The desktop is the fallback and has no relay in the path |
| Sweep identity              | `--sweep-sub` or `SWEEP_SUB`, and it must equal the target's `DEV_USER_SUB`                                                                        |
| Local proof                 | The workload runs at 1, 2, 3, 5, 10, 25, 50 and 100 VUs against a stub target with no failing checks                                               |

## Open gaps

`SRE.md` owns what the numbers do not explain (`What the record does not carry`, `Next`). One of those
gaps has a run command attached. The search stops once the gap is under its tolerance, so no level
between 10 and 20 VUs was tried; `--only 15` and `--only 17` fill that band.

## Order

### 0. Prerequisites on this laptop

```sh
cd ~/k6-load-testing
direnv allow .
k6 version                  # k6 v2.2.0, from the flake
python3 sweep.py --help     # --start, --max-vus, --only, --smoke, --cleanup-only

cat > .env <<'EOF'
API_URL=http://100.64.1.1:30090/api
SWEEP_SUB=k6-sweep-testing
LABEL=pool40-nodeport
EOF

docker ps --format '{{.Names}}'   # stop services first using their docker compose files
```

### 0b. Rehearse the same run locally

The same workload and the same identity, against the local stack with the model stubbed. This is how
the harness was verified, and it is where a harness fault shows up instead of during a perf-val-change.

```sh
cd ~/maxterview_website
BACKEND_PORT=8099 docker compose -p maxterview-dev -f compose.yml -f compose.dev.yml run --rm -d \
  --service-ports -e LLM_BASE_URL= -e RATE_LIMIT=off -e DEV_USER_SUB=k6-sweep-testing backend \
  uv run uvicorn app.main:app --host 0.0.0.0 --port 8000

cd ~/k6-load-testing
python3 sweep.py --api-url http://localhost:8099/api --only 10 --smoke
```

`LLM_BASE_URL` empty and `RATE_LIMIT=off` are the two that matter: the local stack otherwise calls the
live model and answers 429 after 120 requests. It writes rows under `k6-sweep-testing`, so nothing of
yours is in the delete set, and the cleanup at the end of the run removes them.

### 1. Pre-flight, no load

Read the overlay before it is applied. It must carry `RATE_LIMIT=off`, `CLERK_ENABLED=false`,
`APP_ENV=test`, `LLM_BASE_URL` unset, `OTEL_EXPORTER_OTLP_ENDPOINT` set, ingress limits at 1M, pod
memory 256Mi, one replica, and `DEV_USER_SUB=k6-sweep-testing`, the same name the harness uses.

The endpoint is the one with no alarm on it. Unset, the database and pool numbers never appear, and
every metric rule reads NoData, which is OK, so the loss is silent.

### 1b. Deploy the code under test

The window runs whatever image the prod overlay names, and the perf overlay inherits it (`resources:
../prod`). Push to main so CI passes and the CD workflow builds both images, rewrites the prod `newTag`
to that commit, and Argo syncs. Opening the window before that measures the previous image.

Confirm the backend deployment is on the pushed commit before any load:

```sh
ssh -i ~/.ssh/piserver seeker@100.64.1.1 \
  'k3s kubectl -n maxterview get deploy maxterview-backend -o jsonpath="{.spec.template.spec.containers[0].image}"'
```

The tag has to match the pushed commit: `git fetch`, then `git rev-parse origin/main`. If it does not,
the build or the sync is still in flight.

### 2. Open the perf-val-change

Swap `apps/maxterview/overlays/prod` for `overlays/perf` in `apps-of-apps/maxterview.yaml`, commit, wait
for the sync, and confirm the pod was replaced.

The whole change is one line. Swap `apps/maxterview/overlays/prod` for `overlays/perf` in
`apps-of-apps/maxterview.yaml`, commit, push, wait for the sync, and confirm the pod was replaced.

That overlay carries everything the run needs: `APP_ENV=test`, `CLERK_ENABLED=false`, `RATE_LIMIT=off`,
`LLM_BASE_URL` empty, `DEV_USER_SUB=k6-sweep-testing`, the raised ingress limits, and, from commit
`792ed2e`, a NodePort on the `maxterview-backend` Service at 30090. Argo prunes what leaves the
manifests, so reverting the line in step 5 removes the NodePort with it and nothing stays open.

The port is on the backend Service rather than the ingress for two reasons: kustomize's `namespace` in
that overlay overwrites any resource's own namespace, so a Service in `ingress-nginx` cannot live there,
and the backend is the app itself, which is what the sweep is measuring.

```sh
~/maxterview_website/scripts/perf-window.sh on
```

### 3. Prove it from the ladder's side

```sh
curl -s -o /tmp/u.json -w '%{http_code}\n' http://100.64.1.1:30090/api/usage
cat /tmp/u.json        # want 200 and "tier":"dev". A 401 means the perf-val-change is still closed

python3 sweep.py --cleanup-only
python3 sweep.py --only 10 --smoke
```

`--cleanup-only` is the only destructive path: it asserts every listed row belongs to `SWEEP_SUB`
before deleting, and stops at the 30 second budget. `--only 10 --smoke` is 10 VUs for about 16 seconds,
the first real contact. The sweep runs the same smoke as its first window, so this only proves the
target before you commit to the ladder. Both must exit 0.

### 4. The sweep

```sh
python3 sweep.py
```

Its first window is the 10 VU smoke, mandatory: a failed smoke aborts before any rung, since that is
the harness or the app and not load. Then it climbs 100, 200, 400, 800. A failed rung is the boundary,
and the search runs between the last pass and it, down to the smoke's 10 VUs when 100 is the rung that
fails. Between windows it waits 15 seconds, cleans up for up to 30, then waits 15 again. The winner is
re-run three times at a 5 minute window; all three must pass, and a failing run ends that phase and
searches below the level again, for at most three phases. Every window writes a row to
`results/sweep-<utc>.csv` and a k6 summary to `results/level-<n>-<phase>-<utc>.json`, one file per run.

### 5. Close the perf-val-change

Clean up first, while the NodePort still answers: the app authenticates with the perf window's
`DEV_USER_SUB`, so once the overlay is back to prod the cleanup cannot reach it and its rows stay. Then
swap the overlay back to prod, commit, push, wait for the sync, and confirm `/api/usage` answers 401 on
the public URL. The perf-val-change turns authentication and the rate limit off, so it must not outlive
the run, and the NodePort is pruned with it.

```sh
cd ~/k6-load-testing
python3 sweep.py --cleanup-only

~/maxterview_website/scripts/perf-window.sh off
```

### 6. Read the result

`results/sweep-<utc>.csv` carries the boundary per window: phase and window length, p50, p95, p99, max,
error rate, rps, iterations, requests, seconds and the account's rows before and after each
perf-val-change.

In Grafana, `maxterview-logs` over the sweep's time range: `db_pool_wait` against `db_query` says
whether Neon's queue or the SQL ran out first, and container memory against its limit says whether the
pod did. That is the "which resource runs out first" half of the question.

## Time

About 5.5 minutes per level at the defaults (30 second ramp, 60 second warm, 3 minute measure, plus the
gap), and about 7.5 for each of the three confirmations at their 5 minute window, so a ladder that
brackets a failure plus the three confirmations is roughly an hour, assuming the first failure is not
at 100 VUs. Each failed confirmation adds a search and another phase, so two of them roughly double the
run.

## Abort and rollback

| Situation                                   | Action                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Step 3 answers 401                          | The perf-val-change is still closed. Fix the overlay before going on                          |
| 30090 refuses the connection                | The overlay is not live: check that `apps-of-apps` says `overlays/perf` and the sync finished |
| The perf-val-change will not open           | Stop and fix the overlay. `main.js` refuses to load without `tier=dev`                        |
| `--cleanup-only` aborts on foreign owners   | Stop. The identity does not match the target's `DEV_USER_SUB`                                 |
| Cleanup leaves rows behind after 30 seconds | Stop. The next perf-val-change would read a bigger account than the last                      |
| The 10 VU smoke fails                       | The sweep aborts. Fix the harness or the app; a failed smoke is not capacity                  |
| A ladder rung fails                         | Expected. That is the boundary; the search runs from the last pass down to 10 VUs             |
| Anything unexpected                         | Close the perf-val-change first, then debug. Leaving it open leaves prod unauthenticated      |

## What this run cannot claim

The 44ms relay is in every number the sweep produces. If the boundary comes back near the gates, the
first question is whether the app or the relay produced it, and the answer is the desktop, which
reaches the Pi without a relay. The CSV records the client side; the server side is in the same
Grafana panels, over the same perf-val-change, and the two together separate them.
