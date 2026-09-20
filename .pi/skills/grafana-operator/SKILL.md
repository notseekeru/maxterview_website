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
| Folder, project | `maxterview` (dashboard-less; rules only) |
| Folder, Grafana's own | `afys5ycv6iv40b` — holds the 11 built-in Cloud dashboards, never touch |
| Rule group | `maxterview-logs`, interval 60s, 4 rules |
| Rule uids | `cfys2cemal24ga`, `efys2cf010ykgc`, `afys2cfcxi2v4e`, `afystat9eb1tsb` |
| Contact point | `slack-maxterview` (uid `dfys2agrrsr9ce`, type slack; webhook is a secret in Infisical) |
| Root notification policy | receiver `slack-maxterview`, `group_by = [grafana_folder, alertname]`, `provenance: api` |
| Loki datasource | `grafanacloud-logs` (also `grafanacloud-prom`, `-traces`, `-profiles`) |

Datasources belong to the **stack** and are shared by every project on it. There is no per-project
datasource and none should be created: a project is isolated by folder + the Loki `app` label.

## Verb semantics (each one measured; guessing moves other people's rules)

| Call | Behaviour |
| --- | --- |
| `POST /api/folders` | creates; a second POST with the same uid → **412** |
| `PUT /api/folders/<uid>` | **412 unless** the body has `"overwrite": true` |
| `DELETE /api/folders/<uid>` | **400 unless** `?forceDeleteRules=true`; without it folder and rules survive |
| `PUT /api/v1/provisioning/folder/<f>/rule-groups/<g>` | the upsert — 200 whether it created or updated |
| `POST` to that same path | **404**, it serves GET/PUT/DELETE only |
| `POST /api/dashboards/db` | `{"dashboard": {...}, "folderUid": "<f>", "overwrite": true}`; dashboards round-trip **byte-identical** apart from `id`/`version` |

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
cd observability/grafana && ./bootstrap.py <project> [app-label] [--dry-run] [--delete]
```

`cp -r observability/grafana <new-repo>/observability/grafana` is the whole install step; `cp -r` and
one command per project. Dashboards and rules land in folder `<project>`, nothing is shared but the
stack and the contact point. Tuning a template then rerunning is the only supported way to change a
provisioned rule.

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
