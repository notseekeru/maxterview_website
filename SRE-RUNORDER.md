# SRE run order

## The target

| Thing            | Value                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| API base         | `$API_URL` (`http://<node-host>:30090/api` in `.env`), a NodePort created with the perf-val-change and deleted with it |
| Host header      | none. The NodePort points at the backend Service, so no name routing is involved                                     |
| TLS              | none on this hop. It is plain HTTP over Tailscale, and Tailscale does the encryption                                 |
| Measured latency | single digit ms over the tailnet from the desktop, about 44ms from the laptop, which relays; 54ms on the public path |
| Server access    | `ssh -i "$KEY" "$TARGET"`; both come from `.env`, and the default identity list does not offer that key |

The public URL works with k6, but it carries about half a second of Cloudflare and tunnel per request,
and it answers 403 with Cloudflare code 1010 to any client whose user agent it dislikes. It is the
probe's target, not the sweep's.

The sweep runs from the laptop, so the 44ms relay is in every number it produces. The desktop reaches
the Pi directly, which is how a boundary near the gates gets attributed to the app rather than the relay.

## 0. Prerequisites on this laptop

```sh
cd ~/k6-load-testing
direnv allow .
k6 version                  # k6 v2.2.0, from the flake
python3 sweep.py --help     # --start, --max-vus, --only, --floor, --smoke, --label, --confirm-runs, --cleanup-only, --identity

cat > .env <<EOF
API_URL=$API_URL
SWEEP_SUB=k6-sweep-testing
# The standard perf window's tag. A probe passes its own --label, which wins over this.
LABEL=pool40-nodeport
EOF

docker ps --format '{{.Names}}'   # stop services first using their docker compose files
```

## 1. Pre-flight, no load

Read `apps/maxterview/overlays/perf` before it is applied. The values it must carry are `SRE.md`
`Perf window` and `Deploy`, and `DEV_USER_SUB=k6-sweep-testing` has to be the name the harness uses.

The endpoint is the one with no alarm on it. Unset, the database and pool numbers never appear, and
every metric rule reads NoData, which is OK, so the loss is silent.

## 1b. Deploy the code under test

The perf window runs whatever image the prod overlay names, and the perf overlay inherits it (`resources:
../prod`). Push to main so CI passes and the CD workflow builds both images, rewrites the prod `newTag`
to that commit, and Argo syncs. Opening the perf window before that measures the previous image.

Confirm the backend deployment is on the pushed commit before any load:

```sh
ssh -i "$KEY" "$TARGET" \
  'k3s kubectl -n maxterview get deploy maxterview-backend -o jsonpath="{.spec.template.spec.containers[0].image}"'
```

The tag has to match the pushed commit: `git fetch`, then `git rev-parse origin/main`. If it does not,
the build or the sync is still in flight.

## 2. Open the perf-val-change

The whole change is one line. Swap `apps/maxterview/overlays/prod` for `overlays/perf` in
`apps-of-apps/maxterview.yaml`, commit, push, wait for the sync, and confirm the pod was replaced.
Argo prunes what leaves the manifests, so reverting the line in step 5 removes the NodePort with it
and nothing stays open.

```sh
~/maxterview_website/scripts/perf-window.sh on
```

## 3. Prove it from the ladder's side

```sh
curl -s -o /tmp/u.json -w '%{http_code}\n' "$API_URL/billing/usage"
cat /tmp/u.json        # want 200 and "tier":"dev". A 401 means the perf-val-change is still closed

python3 sweep.py --cleanup-only
python3 sweep.py --only 10 --smoke
```

`--cleanup-only` is the only destructive path: it asserts every listed row belongs to `SWEEP_SUB`
before deleting, and stops at the 30 second budget. `--only 10 --smoke` is 10 VUs for about 16 seconds,
the first real contact. The sweep runs the same smoke as its first window, so this only proves the
target before you commit to the ladder. Both must exit 0.

## 4. The sweep

```sh
python3 sweep.py
```

It opens with a floor window on `/api/health`, then the mandatory 10 VU smoke, then 100, 200, 400, 800.
Each level is a 30 second ramp, a 60 second warm, and a 120 second measurement. A failed smoke aborts
before the first level. A failed level is the boundary, and the search runs down from the last pass. The
winner gets two 5 minute windows, both must pass; `--confirm-runs 1` prints UNCONFIRMED for the same
reason. Every window writes a row to `results/sweep-<utc>.csv` and a k6 summary to
`results/level-<n>-<phase>-<run_id>.json`, the same `run_id` the row carries.

## 4b. A one-level probe

A probe runs one level at a different pool. The override goes in the perf overlay, never in prod:

```sh
cd ~/gitops
$EDITOR apps/maxterview/overlays/perf/env.yaml     # DB_POOL_MAX, value "80"
git add apps/maxterview/overlays/perf/env.yaml
git commit -m "chore(gitops): run the perf window at pool 80"
git push
~/maxterview_website/scripts/perf-window.sh on
# wait for the replacement pod, then prove it as in step 3
cd ~/k6-load-testing
python3 sweep.py --cleanup-only
python3 sweep.py --only 55 --label pool80-nodeport
```

Close as in step 5, then remove the override and push again. `--label` is the only place a row names its
pool, so a probe without it writes a row that lies. A probe still opens prod and spends Neon compute;
check the budget before it, not after.

## 5. Close the perf-val-change

Clean up first, while the NodePort still answers: the app authenticates with the perf window's
`DEV_USER_SUB`, so once the overlay is back to prod the cleanup cannot reach it and its rows stay. Then
swap the overlay back to prod, commit, push, wait for the sync, and confirm `/api/billing/usage` answers 401 on
the public URL. The perf-val-change turns authentication and the rate limit off, so it must not outlive
the run.

```sh
cd ~/k6-load-testing
python3 sweep.py --cleanup-only

~/maxterview_website/scripts/perf-window.sh off
```

## 6. Read the result

`results/sweep-<utc>.csv`, one row per level, and one k6 summary per run named by its `run_id`. The
`phase=floor` row carries no database columns, by design.

In Grafana, `maxterview-logs` from `measure_start` for `measure_s`: read server numbers as `increase`
over that window (`SRE.md`, What is the bottleneck now). `db_pool_wait` against `db_query` says whether Neon's
queue or the SQL ran out first, and container memory against its limit says whether the pod did. That is
the "which resource runs out first" half of the question.

## Time

About an hour for a sweep from 100 VUs, including the floor window and the two confirmation windows. A
one-level probe is about ten minutes, and `--floor` alone is about five with the syncs.

## Abort and rollback

| Situation                                      | Action                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 30090 refuses the connection                   | The overlay is not live: check that `apps-of-apps` says `overlays/perf` and the sync ran |
| The perf-val-change will not open              | Stop and fix the overlay. `main.js` refuses to load without `tier=dev`                   |
| `--cleanup-only` aborts on foreign owners      | Stop. The identity does not match the target's `DEV_USER_SUB`                            |
| Cleanup leaves rows behind after 30 seconds    | Stop. The next perf-val-change would read a bigger account than the last                 |
| The pool override is still in the perf overlay | Remove it after the probe; the next perf window would silently run that pool             |
| Anything unexpected                            | Close the perf-val-change first, then debug. Leaving it open leaves prod unauthenticated |
