# AGENT TASK — portable Grafana observability kit

**Delete this file once `bootstrap.py` exists and is verified.** The script's `--help` and docstring then own
the usage facts; this brief exists only to carry the context that is expensive to rediscover.

## Goal

Make the observability setup behind `maxterview` copyable. A new project should get an isolated, reproducible Grafana
presence with one command, run from inside that project's repo:

```sh
./observability/grafana/bootstrap.py <project> [app-label]
# e.g. ./bootstrap.py payments payments-backend
```

Isolation means: its own folder, its own alert rules, its own dashboard — not its own datasource and not its own
stack. `cp -r observability/grafana <new-repo>/observability/grafana` must be the whole install step.

## Deliverables

- `observability/grafana/bootstrap.py` — **Python 3, standard library only** (`urllib.request`, `json`, `argparse`,
  `pathlib`). No `requests`, no venv, no `pip install`. Python over bash is decided, not cosmetic: a correct rerun must
  `GET` the live rule group, strip read-only fields, merge the existing rule `uid`s and `PUT` it back, and in bash that
  is `curl` + `sed` + a jq/python3/node resolution chain, while in Python it is `json.load`, a dict merge, `json.dumps`.
  `#!/usr/bin/env python3`, `chmod +x`, run as `./bootstrap.py <project> [app-label]`. Verified on this host: `python3`
  3.14.7. Do not wrap it in a bash shim.
- `observability/grafana/rules/alerting.json` — rule-group payload template for the four rules below.
- `observability/grafana/dashboards/logs.json` — dashboard template, generic (no maxterview nouns).
- Optional: `observability/grafana/.gitignore` if anything transient lands there.

The rule-group and dashboard templates must be **exported from the live Grafana, not hand-written**: commit the output of
`GET /api/v1/provisioning/folder/maxterview/rule-groups/maxterview-logs` (parameterized on `{{APP}}`) and a dashboard
JSON exported from the UI. Grafana's own shape is then the shape of the file, so the template can never drift from the
API you are posting to.

Provenance decision: write rules **without** `disable_provenance`, so Grafana marks them provisioned and locks them
from UI edits — the repo template is then the only writer and cannot silently diverge. (The existing `maxterview` rules
are UI-editable because they were made through the MCP, which defaults `disable_provenance: true`; that asymmetry is
expected, do not "fix" it.) Note the consequence in the script's `--help`: changing a rule means editing the template
and rerunning, not clicking in Grafana.

Interface: `bootstrap.py <project> [app-label] [--datasource <uid>] [--receiver <name>] [--url <stack-url>] [--dry-run] [--delete]`.
`app-label` defaults to `<project>-backend`. `--delete` removes the folder (with `forceDeleteRules=true`, which then
removes its rules and dashboards). `--dry-run` prints the payloads and sends nothing. Reruns must be no-ops that
converge by uid. Auth: `GRAFANA_SERVICE_ACCOUNT_TOKEN` from the environment, falling back to the repo-root `.env`;
never print it, and log requests without the `Authorization` header.

## Environment facts (already verified — don't re-derive)

- Stack: `https://sturdypoplar3317.grafana.net`, `org_id = 1`.
- Loki datasource uid: `grafanacloud-logs`. (Prometheus: `grafanacloud-prom`.) Datasources are per **stack**, shared by
  every project; there is no per-project datasource and none should be created. Project separation is the `app` label.
- Existing folder: `maxterview` (uid `maxterview`). Existing rule group: `maxterview-logs`, interval 60s, four rules:
  | Rule | Expression | Threshold | for | severity |
  | --- | --- | --- | --- | --- |
  | `maxterview: backend 5xx` | `sum(count_over_time({app="maxterview-backend"} \| json \| status >= 500 [5m]))` | > 5 | 1m | critical |
  | `maxterview: llm failures` | `sum(count_over_time({app="maxterview-backend"} \| json \| event=~"llm.*(unavailable\|failed\|transport_error)" [10m]))` | > 2 | 1m | warning |
  | `maxterview: backend tracebacks` | `sum(count_over_time({app="maxterview-backend"} \| json \| level="error" [10m]))` | > 3 | 2m | warning |
  | `maxterview: browser errors` | `sum(count_over_time({app="maxterview-backend"} \| json \| event="browser.error" [10m]))` | > 2 | 1m | warning |
  All four: `noDataState: OK`, `execErrState: Error`, reduce `last` (B) → threshold `gt` (C), condition `C`.
- Contact point: `slack-maxterview` (uid `dfys2agrrsr9ce`, type slack). Its webhook is a secret in Infisical — never
  create or copy the contact point from this script; default to **reusing the shared one**.
- Root notification policy routes to `slack-maxterview`, `group_by = [grafana_folder, alertname]`. Prefer leaving it
  alone: give **each rule** `notification_settings.receiver` instead, so one project's kit never rewrites the global
  tree that another project also uses.
- Auth: `GRAFANA_SERVICE_ACCOUNT_TOKEN` in the repo-root `.env`; `GRAFANA_URL` may be env or the literal above. The
  script reads the token itself (`sed -n 's/^GRAFANA_SERVICE_ACCOUNT_TOKEN=//p' .env | head -1`, the same pattern
  `.mcp.json` uses). **Never print, echo, log, or commit the token** — and never read it into context while testing.

## Idempotency: verified API semantics (measured, do not re-derive)

These were probed live on the stack; building on assumptions here is how you move someone else's alert rules.

- Folder: `POST /api/folders` creates, and a second POST with the same uid returns **412**. `PUT /api/folders/<uid>`
  also returns **412 unless the body includes `"overwrite": true`**. So: GET first (404 → POST, 200 → PUT with
  overwrite). `DELETE /api/folders/<uid>` returns **400 unless `?forceDeleteRules=true`** is passed — without it the
  folder and its rule group survive the delete.
- Rule group: **`PUT /api/v1/provisioning/folder/<folderUid>/rule-groups/<group>` is the upsert** — it created the group
  when it did not exist and updated it afterwards, 200 both times. `POST` to that path returns **404** (it serves
  GET/PUT/DELETE only); do not use POST.
- Rule `uid` is a **global primary key, not per-folder**:
  - Omitting `uid` from the rules in a PUT regenerates all four uids (measured), which drops the old rule objects —
    losing alert state history, silences and any resolved/unresolved progression.
  - Echoing *another folder's* uids into a PUT **moves those rules out of that folder** (measured: it emptied
    `maxterview`'s group to 404 until it was restored from the export).
  - Therefore: create once, persist the returned uids into the committed template, and never write a uid you did not
    read from the folder you are writing to.
- Export round-trip: `GET` returns read-only fields that must be stripped before writing back — `id`, `orgID`,
  `folderUID`, `ruleGroup`, `updated`, `record`. The writable subset is `uid`, `title`, `condition`, `data`,
  `noDataState`, `execErrState`, `for`, `keep_firing_for`, `annotations`, `labels`, `isPaused`,
  `notification_settings`.
- After any group write, rule `health` reads `unknown` until the next evaluation (~1 minute). Not a failure.

## Endpoints

- Folders: `POST /api/folders` · `PUT /api/folders/<uid>` · `GET /api/folders/<uid>` · `DELETE /api/folders/<uid>`
  (deleting a folder deletes its dashboards and alert rules — that is the whole of `--delete`).
- Provisioning rule groups: `/api/v1/provisioning/folder/<folderUid>/rule-groups/<group>` — `PUT` upserts, `GET`
  reads, `DELETE` removes (see the measured semantics above). **Get the wire shape right empirically**: `GET` the
  existing `maxterview` group with the token and mirror that exact JSON (field casing matters).
- Dashboards: `POST /api/dashboards/db` with `{"dashboard": {...}, "folderUid": "<project>", "overwrite": true}`.
  Verify with `GET /api/search?folderUIDs=<project>`.
- Health of a rule after writing: `GET /api/v1/provisioning/alert-rules/<uid>` — `health: ok` means the expression
  parsed; a bad LogQL shows as `health: error`.

## Log-schema contract (why the rules look the way they do)

Rules are a contract on the app's structlog line, not on the app itself: `event`, `level`, `timestamp`,
`request_id` always; `status` and `duration_ms` on `event="http.request"`; `message`, `route` and `component_stack`
on the beacon's `event="browser.error"`. The `app` label comes from the gitops k8s manifests,
not from the app. Consequence worth one printed warning in the script: with `noDataState: OK`, a project whose logger
emits different field names gets rules that **never fire and never complain** — a quiet stack and a dead rule look
identical. Suggest in the output that the new project's first check is an instant query proving its `app` label
returns rows.

## Dashboard

Generic, four panels, Loki only, no project nouns in labels: log volume by `level`; request rate with a 5xx overlay;
p95 `duration_ms`; a logs panel for `level="error"`. Two template variables: `DS_LOKI` (datasource, so the file is
portable across stacks) and `app` (query on that datasource, defaulting to `{{APP}}`). Keep the JSON hand-written and
small — no builder, no npm dependency.

## Style and constraints

- Follow `AGENTS.md`: minimal, no unrequested abstraction, comments only where the code cannot say it. One `AI HERE:`
  note for the ceiling (no state, no drift detection, no plan step — if this ever gains a second writer or a change
  that must land in several projects at once, move it to Terraform, where `grafana_rule_group` imports today's groups
  with `terraform import grafana_rule_group.x "maxterview:maxterview-logs"`).
- Do **not** touch the existing `maxterview` folder, rules, dashboard-less state, contact point, or policy tree. Test
  with a throwaway project name.
- Portability boundary to state plainly in `--help`, because it is the question people actually ask: datasources are
  per **stack** on Grafana Cloud and shared by every project, so a project is isolated by folder + `app` label and never
  by a datasource. Portable datasources are a self-hosted-Grafana concern (file provisioning) and out of scope here.
- Paths already researched and rejected — do not re-open: Grizzly (removed), `grafanactl` (superseded by `gcx`),
  Git Sync (dashboards/folders only, no alert rules), `grafana_apps_rules_alertrule_v0alpha1` (alpha, feature-gated),
  Terraform (correct but a second system for four rules — see the `AI HERE` note).

## Verification the agent must perform, not hand over

1. `./bootstrap.py smoke smoke-backend` — capture the full output.
2. Prove each object: `GET /api/folders/smoke`; `GET /api/v1/provisioning/folder/smoke/rule-groups/smoke-logs` shows
   four rules whose expressions carry `app="smoke-backend"` and the right thresholds; `GET /api/search?folderUIDs=smoke`
   shows the dashboard.
3. Rerun the same command — second run must converge (no duplicate group, no duplicate dashboard), and its output must
   say so. **Prove it with uids, not counts**: capture the four rule uids after run 1 (`GET` the group), rerun, and
   assert the uids are byte-identical. Counts being equal while the uids changed means the rerun silently replaced the
   rules.
4. Prove you did not move anyone else's rules: `GET /api/v1/provisioning/folder/maxterview/rule-groups/maxterview-logs`
   before and after the whole smoke test must return the same four uids (`cfys2cemal24ga`, `efys2cf010ykgc`,
   `afys2cfcxi2v4e`, `afystat9eb1tsb`). Rule uids are global — this is the regression that a naive uid handoff causes.
5. Confirm the rules evaluate: after ~1 minute every rule reports `health: ok` (NoData is fine and expected).
6. `./bootstrap.py smoke --delete`, then prove the folder is gone and the four uids from step 4 are still in place. A
   `DELETE` that returns 400 means `forceDeleteRules=true` is missing.
7. Report: exact commands, their output, and anything that needed a second attempt.

Then commit the kit as one atomic conventional commit (`feat(obs): portable Grafana bootstrap kit`), delete this file
in the same commit, and leave `notes.md` alone.
