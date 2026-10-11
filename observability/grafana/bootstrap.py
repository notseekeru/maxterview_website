#!/usr/bin/env python3
"""Portable Grafana observability kit: one folder, one alert rule group, one dashboard.

  ./bootstrap.py <project> [app-label] [--datasource UID] [--prometheus-datasource UID] [--receiver NAME] [--url URL] [--payments] [--dry-run] [--delete]

Creates folder `<project>`, rule group `<project>-logs` and dashboard `<project>-logs`. The group holds
five rules: 5xx and model failures counted from the OTLP metrics, error-level tracebacks and browser
errors read from the logs. The dashboard covers logs and both metric groups, so a project that only
ships logs still gets a usable board with three dead metric panels.
`app-label` defaults to `<project>-backend`.
`--uptime` appends `rules/alerting.uptime.json`: one rule on the external probe (`probe_success`,
job `<project>-health`) and one on the app's silence. Both are off by default for the same reason as
`--payments`: a project with no Synthetic Monitoring check, or no pulse route the pipeline can see,
would get rules that fire on a quiet night. `synthetic.py` creates the check they read.
`--payments` appends `rules/alerting.payments.json` to the same group: five rules over the PayMongo
events an app logs as `event="paymongo.*"`. Off by default, because a project that never emits those
rows gets rules that neither fire nor complain.
Reruns converge by uid: the live rule group is read
first and its rule uids are merged back, so alert state, silences and resolved/unresolved
progression survive.

The metric panels and the two metric rules select `service_name="<app-label>"`, which only matches an
app whose OTLP `service.name` is the same string as its pod label (the backend sets it in
telemetry.py).

Provisioning: rules are written without `disable_provenance`, so Grafana marks them provisioned and
locks them against UI edits. That is deliberate — this repo stays the only writer. Changing a rule
means editing `rules/alerting.json` and rerunning, not clicking in Grafana.

Portability boundary: on Grafana Cloud datasources belong to the **stack** and are shared by every
project on it, so a project is isolated by folder + `app` label, never by a datasource. Nothing here
creates one. Portable datasources (file provisioning) are a self-hosted concern; out of scope.

Auth: `GRAFANA_SERVICE_ACCOUNT_TOKEN` from the environment, else the first `.env` walking up from
$PWD and from this script. The token is never printed.

AI HERE: no state, no drift detection, no plan step; the repo is the only writer. If this ever gains
a second writer, or a change that must land in several projects at once, move it to Terraform, where
today's groups import with: terraform import grafana_rule_group.x "maxterview:maxterview-logs"
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_URL = "https://sturdypoplar3317.grafana.net"
DEFAULT_DATASOURCE = "grafanacloud-logs"
DEFAULT_PROMETHEUS_DATASOURCE = "grafanacloud-prom"
DEFAULT_RECEIVER = "slack-maxterview"


def fail(msg):
    sys.exit(f"FAIL: {msg}")


def token(name="GRAFANA_SERVICE_ACCOUNT_TOKEN"):
    env = os.environ.get(name)
    if env:
        return env.strip()
    for base in (Path.cwd(), HERE):
        for parent in (base, *base.parents):
            envfile = parent / ".env"
            if envfile.is_file():
                for line in envfile.read_text().splitlines():
                    if line.startswith(f"{name}="):
                        value = line.split("=", 1)[1].strip()
                        if value:
                            return value
    fail(f"{name} not in the environment or any .env up the tree")


def api(url, tok, path, method="GET", body=None):
    request = urllib.request.Request(
        url + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json",
                 **({"Authorization": f"Bearer {tok}"} if tok else {})},
    )
    try:
        with urllib.request.urlopen(request) as response:
            code, raw = response.status, response.read()
    except urllib.error.HTTPError as error:
        code, raw = error.code, error.read()
    print(f"  {method} {path} -> {code}")  # never the Authorization header
    if code == 404:
        return None
    if code >= 400:
        fail(f"{method} {path}: {code} {raw[:300].decode(errors='replace')}")
    return json.loads(raw) if raw else {}


def render(node, values):
    if isinstance(node, str):
        for key, value in values.items():
            node = node.replace("{{" + key + "}}", value)
        return node
    if isinstance(node, list):
        return [render(item, values) for item in node]
    if isinstance(node, dict):
        return {key: render(item, values) for key, item in node.items()}
    return node


def load(name, values):
    return render(json.loads((HERE / name).read_text()), values)


def install(args, app):
    # The Alloy pod carries app=<project>-alloy, and it is the only place a dropped export is visible.
    values = {"PROJECT": args.project, "APP": app, "ALLOY_APP": f"{args.project}-alloy",
              "PROBE_JOB": f"{args.project}-health",
              "DATASOURCE": args.datasource,
              "DS_PROM": args.prometheus_datasource,
              "RECEIVER": args.receiver}
    rules = load("rules/alerting.json", values)
    if args.payments:
        rules["rules"] += load("rules/alerting.payments.json", values)["rules"]
    if args.uptime:
        rules["rules"] += load("rules/alerting.uptime.json", values)["rules"]
    dashboard = load("dashboards/logs.json", values)
    group = f"{args.project}-logs"

    if args.dry_run:
        for what, payload in [("folder", {"uid": args.project, "title": args.project}),
                              ("rule group", rules),
                              ("dashboard", {"dashboard": dashboard, "folderUid": args.project,
                                             "overwrite": True})]:
            print(f"\n--- {what} ---\n{json.dumps(payload, indent=2)}")
        return

    tok = token()
    if api(args.url, tok, f"/api/folders/{args.project}"):
        api(args.url, tok, f"/api/folders/{args.project}", "PUT",
            {"uid": args.project, "title": args.project, "overwrite": True})
    else:
        api(args.url, tok, "/api/folders", "POST", {"uid": args.project, "title": args.project})

    path = f"/api/v1/provisioning/folder/{args.project}/rule-groups/{group}"
    live = api(args.url, tok, path)
    prior = {rule["title"]: rule["uid"] for rule in (live or {}).get("rules", [])}
    for rule in rules["rules"]:
        if rule["title"] in prior:
            rule["uid"] = prior[rule["title"]]
    api(args.url, tok, path, "PUT", rules)

    after = {rule["title"]: rule["uid"] for rule in
             api(args.url, tok, path)["rules"]}
    preserved = {rule["title"]: rule["uid"] for rule in rules["rules"] if "uid" in rule}
    assert all(after.get(title) == uid for title, uid in preserved.items()), \
        f"rerun replaced rule uids: {preserved} -> {after}"
    print(f"rule group {group}: {len(after)} rules, "
          + ("uids unchanged " if preserved else "created ")
          + str(list(after.values())))

    result = api(args.url, tok, "/api/dashboards/db", "POST",
                 {"dashboard": dashboard, "folderUid": args.project, "overwrite": True})
    print(f"dashboard {result['uid']}: version {result['version']} -> {args.url}{result['url']}")

    query = f'sum(count_over_time({{app="{app}"}}[24h]))'
    check = api(args.url, tok, "/api/datasources/proxy/uid/"
                + urllib.parse.quote(args.datasource)
                + "/loki/api/v1/query?"
                + urllib.parse.urlencode({"query": query, "time": int(time.time())}))
    rows = check["data"]["result"]
    print(f"app label check: {query} -> {rows[0]['value'][1] if rows else 0} in the last 24h")
    if not rows:
        fail(f'kit installed, but no Loki rows for app="{app}" in the last 24h — nothing was rolled '
             "back. The log rules have noDataState=OK, so a project whose logger emits different "
             "field names never fires and never complains — a "
             "quiet stack and a dead rule look identical. Fix the label or the field names, then rerun.")

    # Not a failure: an install that precedes the deploy reports zero. It is printed because a metric
    # rule with a mistyped service_name is indistinguishable from a quiet stack. A 24h lookback, never
    # a bare `sum(...)`: Prometheus marks a sample stale after 5m, so an instant selector reads empty
    # for any app idle longer than that and says nothing about whether the pipeline works.
    series = api(args.url, tok, "/api/datasources/proxy/uid/"
                 + urllib.parse.quote(args.prometheus_datasource)
                 + "/api/v1/query?"
                 + urllib.parse.urlencode({"query": f'sum(increase(http_server_request_duration_seconds_count{{service_name="{app}"}}[24h]))'}))
    rows = series["data"]["result"]
    print(f"metric check: service_name={app} -> {rows[0]['value'][1] if rows else 0} requests in the "
          "last 24h (0 = no OTLP export, or no traffic)")
    print("installed; rules report health=unknown until their first evaluation (~1 minute)")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("project", help="folder / rule-group / dashboard prefix, e.g. payments")
    parser.add_argument("app_label", nargs="?",
                        help="Loki app label the rules alert on (default <project>-backend)")
    parser.add_argument("--datasource", default=DEFAULT_DATASOURCE,
                        help=f"Loki datasource uid (default {DEFAULT_DATASOURCE}, shared by the stack)")
    parser.add_argument("--prometheus-datasource", default=DEFAULT_PROMETHEUS_DATASOURCE,
                        help=f"Prometheus datasource uid for the metric panels and rules "
                             f"(default {DEFAULT_PROMETHEUS_DATASOURCE}, shared by the stack)")
    parser.add_argument("--receiver", default=DEFAULT_RECEIVER,
                        help=f"contact point set on each rule, so the global notification tree stays "
                             f"untouched (default {DEFAULT_RECEIVER})")
    parser.add_argument("--url", default=os.environ.get("GRAFANA_URL") or DEFAULT_URL)
    parser.add_argument("--payments", action="store_true",
                        help="add the PayMongo rules (rules/alerting.payments.json) to the group; they "
                             "read event=\"paymongo.*\" rows only this project's app emits")
    parser.add_argument("--uptime", action="store_true",
                        help="add the uptime rules (rules/alerting.uptime.json) to the group; they read "
                             "the external check synthetic.py creates, so a project without one would "
                             "get rules that fire on a quiet night")
    parser.add_argument("--dry-run", action="store_true", help="print the payloads, send nothing")
    parser.add_argument("--delete", action="store_true",
                        help="delete the folder with forceDeleteRules=true, which takes its rules and "
                             "dashboards with it; nothing else on the stack is touched")
    args = parser.parse_args()

    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,29}", args.project):
        fail("project must be a lowercase slug: [a-z0-9-], starting alphanumeric, max 30 chars")
    app = args.app_label or f"{args.project}-backend"
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}", app):
        fail("app label must be a Loki label value: [a-zA-Z0-9_.-], max 63 chars")

    if args.delete:
        if args.dry_run:
            print(f"\n--- delete ---\nDELETE /api/folders/{args.project}?forceDeleteRules=true")
            return
        api(args.url, token(), f"/api/folders/{args.project}?forceDeleteRules=true", "DELETE")
        print(f"deleted folder {args.project}, its rule group and its dashboard")
        return

    install(args, app)


if __name__ == "__main__":
    main()
