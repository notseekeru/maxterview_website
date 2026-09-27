---
name: grafana-operator
description: >-
  Operates the Grafana Cloud stack behind maxterview (sturdypoplar3317) through its HTTP API and the
  grafana MCP server, so nothing has to be clicked in grafana.com. Holds the measured facts: live
  folder / rule-group / rule / contact-point uids, which verb each object needs (folder PUT needs
  overwrite, DELETE needs forceDeleteRules, rule-group POST is 404), why a rule uid is a GLOBAL
  primary key and how to never move someone else's rules, where rule health and provenance actually
  live, Loki access through the datasource proxy, and the one-command portable kit at
  observability/grafana/bootstrap.py. Also carries the verdicts: the MCP alerting tool's
  disable_provenance default silently decides whether rules stay editable in the UI, and Grizzly /
  gcx / Git Sync / the alpha rules API / Terraform were each checked as config-as-code. Load when
  the user asks about dashboards, alert rules, Loki queries, why an alert did or did not fire, or how
  to give a new project observability.
---

# Grafana operator (maxterview)

Stack: `https://sturdypoplar3317.grafana.net`, `org_id = 1`. Everything below is measured on it, not
read from docs. What owns what: `OBSERVABILITY.md` owns the pipeline (Alloy → Loki, labels, tiers);
`observability/grafana/bootstrap.py --help` owns kit usage, provisioning semantics and the
portability boundary; `observability/grafana/rules|dashboards/*.json` own the rule and panel shapes
and are the log-field contract. **Do not restate those here.**

## Auth

Token is `GRAFANA_SERVICE_ACCOUNT_TOKEN` in the repo-root `.env`. `.mcp.json` injects it into the
`grafana/mcp-grafana:latest` docker container (`--transport stdio`, lazy, tools
`alerting,dashboard,loki,prometheus,datasource,search,navigation`) — so MCP calls need no token
handling at all. For raw curl:

```sh
TOKEN=$(sed -n 's/^GRAFANA_SERVICE_ACCOUNT_TOKEN=//p' .env | head -1)   # never echo it
URL=https://sturdypoplar3317.grafana.net
```

## Where things live

| Object | uid / name |
| --- | --- |
| Folder, project | `maxterview` — rule group + dashboard |
| Folder, Grafana's own | `afys5ycv6iv40b` — the 11 Cloud dashboards, all `provisioned: true` with `provisionedExternalId: dashboard.json`, so they are the stack's whole board set beside `maxterview-logs`; leave them |
| Rule group | `maxterview-logs`, interval 60s, 10 rules: the 5 kit rules (2 Prometheus: 5xx, model failures; 3 Loki: tracebacks, browser errors, dropped OTLP batches from the Alloy stream) plus the 5 payment rules `--payments` appends |
| Dashboard | `maxterview-logs` (uid = same slug), 7 panels (3 Loki, 3 Prometheus, 1 traces) |
| Rule uids | backend 5xx `cfys2cemal24ga`, llm failures `efys2cf010ykgc`, backend tracebacks `afys2cfcxi2v4e`, browser errors `afystat9eb1tsb`, telemetry export failing `cfz9q0s3wfncwb`; payments: credited `cfziwcmzvmupsf`, provider failing `cfziwcmzy4r28c`, webhook rejected `efziwcn00mneob`, unattributable `afziwcn034jr4f`, money back `dfziwcn05mg3kb` |
| Contact point | `slack-maxterview` (uid `dfys2agrrsr9ce`, type slack; webhook is a secret in Infisical) |
| Root notification policy | receiver `slack-maxterview`, `group_by = [grafana_folder, alertname]`, `provenance: api` |
| Loki datasource | `grafanacloud-logs` (also `grafanacloud-prom`, `-traces`, `-profiles`) |

Datasources belong to the **stack** and are shared by every project on it. There is no per-project
datasource and none should be created: a project is isolated by folder + the `app` label on logs and
`service_name` on metrics (the app sets it from `telemetry.py`).

The two Prometheus rules and three dashboard panels read the app's OTLP export through the in-cluster
Alloy. A window with no batches is **data loss, not quiet**: measured 2026-09-25, 103 dropped batches
in one hour, every one `lookup ... server misbehaving` (CoreDNS SERVFAIL), and the gap in traces and
metrics is permanent. That is what the dropped-batch rule watches.

A bare instant selector reads **empty for any app idle more than 5 minutes** (Prometheus staleness),
which is how this pipeline looked dead on 2026-09-27 while the same day held 14,202 samples. Check
through a lookback:
`sum(increase(http_server_request_duration_seconds_count{service_name="maxterview-backend"}[24h]))`.
Both metric rules read NoData as OK, so they catch a burst of 5xx while traffic flows and cannot
notice an outage.

## Verb semantics (each one measured; guessing moves other people's rules)

| Call | Behaviour |
| --- | --- |
| `POST /api/folders` | creates; a second POST with the same uid → **412** |
| `PUT /api/folders/<uid>` | **412 unless** the body has `"overwrite": true` |
| `DELETE /api/folders/<uid>` | **400 unless** `?forceDeleteRules=true`; without it folder and rules survive |
| `PUT /api/v1/provisioning/folder/<f>/rule-groups/<g>` | the upsert — 200 whether it created or updated |
| `POST` to that same path | **404**, it serves GET/PUT/DELETE only |
| `POST /api/dashboards/db` | `{"dashboard": {...}, "folderUid": "<f>", "overwrite": true}`; dashboards round-trip **byte-identical** apart from `id`/`version` |
| `DELETE /api/dashboards/uid/<uid>` | 200 unless the board is Cloud-provisioned, which answers **400 `provisioned dashboard cannot be deleted`** although its own `meta.canDelete` reads `true`; a non-provisioned board (the unfiled Insight ones) deletes fine |

Rule `uid` is a **global primary key, not per-folder**. Omitting uids from a group PUT regenerates
all of them (losing alert state, silences, resolved/unresolved history); echoing another folder's
uids **moves those rules out of that folder**. So: GET the group from the folder you are writing to,
merge uids by title, then PUT.

`GET` returns read-only fields to strip before writing back: `id`, `orgID`, `folderUID`,
`ruleGroup`, `updated`, `record`. The writable subset is `uid`, `title`, `condition`, `data`,
`noDataState`, `execErrState`, `for`, `keep_firing_for`, `annotations`, `labels`, `isPaused`,
`notification_settings`.

## Reading state

```sh
curl -s -H "Authorization: Bearer $TOKEN" "$URL/api/v1/provisioning/folder/maxterview/rule-groups/maxterview-logs"
curl -s -H "Authorization: Bearer $TOKEN" "$URL/api/search?folderUIDs=maxterview"        # dashboards in a folder
curl -s -H "Authorization: Bearer $TOKEN" "$URL/api/datasources/proxy/uid/grafanacloud-logs/loki/api/v1/query?query=$(python3 -c 'import urllib.parse;print(urllib.parse.quote("sum(count_over_time({app=\"maxterview-backend\"}[24h]))"))')&time=$(date +%s)"
```

- **Health and provenance are not on `/api/v1/provisioning/alert-rules/<uid>`** (no `health` key on
  this stack). Read them from `/api/prometheus/grafana/api/v1/rules?type=alert` → `health`, `state`,
  `lastEvaluation`, `provenance`; `/api/ruler/grafana/api/v1/rules/<folder>` answers 202 with the raw
  group.
- After any group write, `health` is `unknown` until the next evaluation (~1 minute). NoData is
  `state: inactive`, which is normal.
- A Loki query for a label that has no rows returns an **empty vector, not an error** — the only way
  to tell a quiet project from a mislabelled one. That is why `bootstrap.py` runs
  `sum(count_over_time({app="<label>"}[24h]))` and exits non-zero when it is empty.

## LogQL on this data (measured — the traps cost hours)

- `status` is a number: `| json | status >= 400` matches (34 rows/24h), so the comparison in the rules
  and panels is live, not lexically dead.
- A regex metachar in a label filter has to be folded: `event=~"paymongo[.]webhook_signature[.][a-z]+"`
  → 1 row/30d, the one real mismatch. The obvious single-backslash escape is a 400
  `parse error ... invalid char escape` for the whole query, and the doubled form needs four
  backslashes inside a JSON rule file, so `[.]` is what the payment rules ship. Same alternation
  shape measured: 3 rows.
- `.*` immediately before a `|`-alternation in a **label** regex silently matches nothing here:
  `event=~"llm.*(unavailable|failed|transport_error)"` → 0 rows where
  `event=~"llm[a-z._]*(unavailable|failed|transport_error)"` → all 6, and `level=~".*(error|warning)"`
  works fine — so the trap is narrow, looks healthy (`health: ok`, `state: inactive`), and is invisible
  under `noDataState: OK`. The live `maxterview: llm failures` rule carried it and could never fire.
  Test any new alternation regex against a real row before trusting it.
- `event="browser.error"` (the frontend beacon) is logged at **`level: info`**, so a `level="error"`
  panel or filter misses every browser error while looking healthy. Filter on `event`, not `level`.
- `path` carries interview UUIDs, so `by (path)` or per-path quantiles are **unbounded** — one series
  per interview. Group by `method` / `status` / `level`; those are bounded.
- Metric queries hit a series cap (observed: exactly 300 returned, then truncated). Aggregate, always.
- `| json` turns every field into a label, so `quantile_over_time(... | unwrap duration_ms ...)` with no
  `keep` returns **one series per request** — a wall of lines at the cap, not a latency curve. Fix:
  `| keep status, duration_ms | unwrap duration_ms` (keep the unwrap field; a bare `| keep path` drops
  `duration_ms` and the query silently returns nothing), or a real mean via
  `sum(sum_over_time(... | unwrap duration_ms [$__auto])) / sum(count_over_time(... [$__auto]))`.
- `| drop pod, instance, ...` does **not** collapse streams: Cloud injects `__time_shard__` and
  `detected_level`, so the series stay split. Only an aggregation collapses. A true single-line p95 is
  not available in LogQL over this data — do not fake it by averaging per-request quantiles.

## Provenance — the UI-editable switch, measured

Rules written through the provisioning API are marked `provenance: api` and **cannot be edited or
deleted in the Grafana UI**; `X-Disable-Provenance: true` (`disable_provenance` in the MCP tool)
leaves them UI-editable. Measured on this stack, 3 rules created by
`grafana_alerting_manage_rules`:

| Call | resulting provenance | UI |
| --- | --- | --- |
| `disable_provenance` omitted (schema default `true`) | `none` | editable |
| `disable_provenance: true` | `none` | editable |
| `disable_provenance: false` | `api` | locked |

The four live `maxterview` rules read `provenance: api`, i.e. **locked** — so any claim that they are
UI-editable because the MCP created them is wrong. After any write, read provenance back rather than
assuming.

## MCP server

`grafana/mcp-grafana:latest` via `.mcp.json`, lazy: connect with `mcp({ connect: "grafana" })`, then
`mcpScript` for multi-call work. Use it for reads and single-rule edits; the tool set has no
rule-**group** operation (no interval, no atomic multi-rule PUT), so group-shaped changes belong to
`bootstrap.py`.

- `grafana_query_loki_logs{datasourceUid, logql, startRfc3339, endRfc3339, limit, direction, format}`
  — log lines; `grafana_query_loki_stats`, `grafana_list_loki_label_values`,
  `grafana_analyze_loki_labels` for label/volume/bloat audits.
- `grafana_alerting_manage_rules{operation: list|get|versions|create|update|delete, ...}` — one rule
  at a time; `get` returns the shape `update` needs.
- `grafana_search_dashboards`, `grafana_get_dashboard_summary`, `grafana_get_dashboard_property`,
  `grafana_list_datasources`, `grafana_check_datasources_health`.

## The kit (a new project gets its own folder + rules + dashboard)

```sh
cd observability/grafana && ./bootstrap.py <project> [app-label] [--payments] [--dry-run] [--delete]
```

`cp -r observability/grafana <new-repo>/observability/grafana` is the whole install step; `cp -r` and
one command per project. Dashboards and rules land in folder `<project>`, nothing is shared but the
stack and the contact point. Tuning a template then rerunning is the only supported way to change a
provisioned rule. **Dashboards are not provenance-locked** (only rules are), so a UI edit to
`<project>-logs` is silently overwritten by the next run — edit the template instead.

Dashboard variables are pinned, never discovered: `DS_LOKI` and `app` are `refresh: 0` with a literal
`current` value substituted at install time. A `query`-type variable over `label_values(app)` resolves
to **no options** here — the Loki plugin parses the classic expr as LogQL and answers
`parse error at line 1, col 1: syntax error: unexpected IDENTIFIER` — which wipes `current` and leaves
every panel querying `{app=""}`: every panel red/empty at once, root cause one variable away. The
label values themselves are fine (`/loki/api/v1/label/app/values` lists five apps). After changing
`--datasource` or the app label, rerun `bootstrap.py`; the dashboard reloads values, it does not find
them.

## Guardrails

- Do not touch the `maxterview` folder, its rules, the `GrafanaCloud` folder, the contact point, or
  the root notification tree unless the user asks for exactly that. Route per rule with
  `notification_settings.receiver` instead of rewriting a policy other projects also use.
- Test with a throwaway project name and delete the folder with `forceDeleteRules=true`; verify uids
  before and after with a GET, never by counting objects.
- Never print, log or commit the service-account token. It is real write access to the stack.
- `noDataState: OK` means a project whose logger emits different field names gets rules that never
  fire **and never complain**: a quiet stack and a dead rule look identical.

## Config-as-code, already researched — do not reopen

| Path | Verdict |
| --- | --- |
| Grizzly | removed |
| `grafanactl` | superseded by `gcx` |
| Git Sync | dashboards and folders only, no alert rules |
| `grafana_apps_rules_alertrule_v0alpha1` | alpha, feature-gated |
| Terraform | correct but a second system for four rules; if that ever pays off, `terraform import grafana_rule_group.x "maxterview:maxterview-logs"` imports today's group |
| `bootstrap.py` + this repo | the shipped answer: PUT-based provisioning, folder + label isolation, repo is the only writer |
