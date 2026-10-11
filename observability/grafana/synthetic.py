#!/usr/bin/env python3
"""The one check that watches this stack from outside the node.

  ./synthetic.py <job> <target> [--probe NAME] [--frequency SECONDS] [--url URL] [--delete] [--dry-run]

A Grafana Cloud Synthetic Monitoring HTTP check, run from a public probe, so it is the only signal
here that survives the node, its Alloy pod and its network. `<target>` should be the app's pulse
route (`/api/ping`), never `/api/health`: health is exempt from logging, sampling and spans, so a
check pointed at it proves the app is up but says nothing about whether the export path still works.

Converges by job name: a rerun updates the check that already carries the job instead of stacking a
second one. The alerting lives in the rule group (`rules/alerting.uptime.json`), not in the check,
so one place pages a human and the check keeps `alertSensitivity=none`.

Auth: `SM_ACCESS_TOKEN` from the environment, else the first `.env` walking up from $PWD and from
this script (`bootstrap.token`, the same reader bootstrap.py uses, never printed). That token is
minted in the Synthetic Monitoring app (Testing & synthetics > Synthetics > Config > Access tokens);
it is not the Grafana Cloud access policy token bootstrap.py uses.

AI HERE: no plan step and no drift detection beyond job name, the same boundary bootstrap.py draws:
the repo is the only writer. If either gains a second writer, move both to Terraform.
"""

import argparse
import json
import os

from bootstrap import api, fail, token

DEFAULT_URL = "https://synthetic-monitoring-api-ap-southeast-1.grafana.net"
HTTP_GET = 0
TIMEOUT_MS = 5000
UPDATE_FIELDS = ("alertSensitivity", "basicMetricsOnly", "channels", "description", "enabled",
                 "folderUid", "frequency", "id", "labels", "offset", "probes", "settings",
                 "target", "tenantId", "timeout", "job")


def probe_id(url, tok, wanted):
    probes = api(url, tok, "/api/v1/probe") or []
    public = [p for p in probes if p.get("public")]
    if str(wanted).isdigit():
        match = [p for p in public if p["id"] == int(wanted)]
    else:
        match = [p for p in public if p["name"].lower() == str(wanted).lower()]
    if not match:
        fail(f"no public probe named {wanted!r}. Available: "
             + ", ".join(sorted(p["name"] for p in public)))
    chosen = match[0]
    print(f"  probe {chosen['name']} (id {chosen['id']}, online={chosen['online']})")
    return chosen["id"]


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("job", help="check name; also the `job` label on every metric, so it has to "
                                    "match the rule in rules/alerting.uptime.json")
    parser.add_argument("target", help="absolute URL to probe, e.g. https://<host>/api/ping")
    parser.add_argument("--probe", default="Singapore",
                        help="public probe location, by name or id (default Singapore)")
    parser.add_argument("--frequency", type=int, default=60, help="seconds between runs (default 60)")
    parser.add_argument("--url", default=os.environ.get("SM_URL") or DEFAULT_URL,
                        help=f"Synthetic Monitoring backend address (default {DEFAULT_URL})")
    parser.add_argument("--delete", action="store_true", help="delete the check with this job name")
    parser.add_argument("--dry-run", action="store_true", help="print the payload, send nothing")
    args = parser.parse_args()

    if not args.target.startswith(("http://", "https://")):
        fail("target must be an absolute http(s) URL")
    if args.target.rstrip("/").endswith("/api/health"):
        fail("that is the exempt path: the probe would prove nothing about the pipeline, use /api/ping")

    tok = token("SM_ACCESS_TOKEN")
    live = [c for c in (api(args.url, tok, "/api/v1/check") or []) if c["job"] == args.job]
    existing = live[0] if live else None

    if args.delete:
        if args.dry_run:
            print(f"\n--- delete ---\nDELETE /api/v1/check/{existing['id'] if existing else 0}")
            return
        if not existing:
            print(f"check {args.job} does not exist, nothing to delete")
            return
        api(args.url, tok, f"/api/v1/check/{existing['id']}", "DELETE")
        print(f"deleted check {args.job} (id {existing['id']})")
        return

    desired = {
        "job": args.job,
        "target": args.target,
        "frequency": args.frequency * 1000,
        "timeout": TIMEOUT_MS,
        "enabled": True,
        "alertSensitivity": "none",
        "probes": [probe_id(args.url, tok, args.probe)],
        "settings": {"http": {"method": HTTP_GET}},
    }
    body = {k: existing[k] for k in UPDATE_FIELDS if k in existing} | desired if existing else desired

    if args.dry_run:
        print(f"\n--- {'update' if existing else 'create'} ---\n"
              f"{json.dumps(body, indent=2, sort_keys=True)}")
        return

    api(args.url, tok, f"/api/v1/check/{existing['id']}" if existing else "/api/v1/check", "POST", body)

    after = [c for c in (api(args.url, tok, "/api/v1/check") or []) if c["job"] == args.job]
    assert len(after) == 1 and after[0]["target"] == args.target and after[0]["enabled"], after
    print(f"check {args.job} -> {args.target} every {args.frequency}s from {after[0]['probes']}; "
          f"metrics appear as probe_success{{job=\"{args.job}\"}} within a minute")


if __name__ == "__main__":
    main()
