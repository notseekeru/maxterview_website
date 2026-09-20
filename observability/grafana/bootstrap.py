#!/usr/bin/env python3
"""Portable Grafana observability kit: one folder, one Loki alert rule group, one logs dashboard.

  ./bootstrap.py <project> [app-label] [--datasource UID] [--receiver NAME] [--url URL] [--dry-run] [--delete]

Creates folder `<project>`, rule group `<project>-logs` (four rules on the `app` label, alerting on
5xx, LLM failures, error-level tracebacks and browser errors) and dashboard `<project>-logs`.
`app-label` defaults to `<project>-backend`. Reruns converge by uid: the live rule group is read
first and its rule uids are merged back, so alert state, silences and resolved/unresolved
progression survive.

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
DEFAULT_RECEIVER = "slack-maxterview"


def fail(msg):
    sys.exit(f"FAIL: {msg}")


def token():
    env = os.environ.get("GRAFANA_SERVICE_ACCOUNT_TOKEN")
    if env:
        return env.strip()
    for base in (Path.cwd(), HERE):
        for parent in (base, *base.parents):
            envfile = parent / ".env"
            if envfile.is_file():
                for line in envfile.read_text().splitlines():
                    if line.startswith("GRAFANA_SERVICE_ACCOUNT_TOKEN="):
                        value = line.split("=", 1)[1].strip()
                        if value:
                            return value
    fail("GRAFANA_SERVICE_ACCOUNT_TOKEN not in the environment or any .env up the tree")


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
    values = {"PROJECT": args.project, "APP": app,
              "DATASOURCE": args.datasource, "RECEIVER": args.receiver}
    rules = load("rules/alerting.json", values)
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
             "back. The four rules have noDataState=OK, so a project whose logger emits different "
             "field names never fires and never complains — a "
             "quiet stack and a dead rule look identical. Fix the label or the field names, then rerun.")
    print("installed; rules report health=unknown until their first evaluation (~1 minute)")


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("project", help="folder / rule-group / dashboard prefix, e.g. payments")
    parser.add_argument("app_label", nargs="?",
                        help="Loki app label the rules alert on (default <project>-backend)")
    parser.add_argument("--datasource", default=DEFAULT_DATASOURCE,
                        help=f"Loki datasource uid (default {DEFAULT_DATASOURCE}, shared by the stack)")
    parser.add_argument("--receiver", default=DEFAULT_RECEIVER,
                        help=f"contact point set on each rule, so the global notification tree stays "
                             f"untouched (default {DEFAULT_RECEIVER})")
    parser.add_argument("--url", default=os.environ.get("GRAFANA_URL") or DEFAULT_URL)
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
