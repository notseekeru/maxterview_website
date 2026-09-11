to ai reading this, do not implement this is just notes of users strictly ignore this unless prompted to.

general features:

- have resume feature with import resume with pdf with deps for maintanibility no hand rolling a pdf parser
- and then after the resume feature we can add direct integration to interviews to just pull the resume in the imported by the user (have a toggle to have resume included in the new interview)
- the interview should contain additive prompts (wary of prompt injection), slidable level(level implemented but currently not sliding), company size (slidable but also can be only 1 same as level), cynicism(how kinda mean they are like kind with benefit of the doubt and neutral and mean because skeptical), toogle to turn on brutally honest mode, human mode (removes ai fluff, unstructured response, and remove ai phrasing and vocabulary) custom rubric maybe?(may need schema changes if custom rubric), and also custom chitchat, behavioral, technical sliders.
- add more dimensions. eg (technicals, behavioural, culture, production, potential)
- ssr for first page load and then client side for the rest of the website
- have a rejected and hired state and certainty percentage state after interview because realistically in life its not just pass or fail, there is a spectrum of certainty and also a spectrum of rejection and hiring.

fix:

- repair the prompt steps like i think it skips behavioral
- the llm feedback scoring sometimes fails schema validation, logs say schema_mismatch field=scores has_verdict=True then formatter_unavailable and the generate endpoint 503s. happens on short transcripts (2 messages) but not sure if its only that. it is intermittent, retrying sometimes works. this is why an interview ends up completed with no score. the retry buttons recover it but the root cause is in the feedback generation/validation and probably the prompt or schema, not fixed yet.
- ~~one global quota reset might spike the db~~ RESOLVED: reset is lazy (UTC `day` is part of `turn_usage` PK, no cron/UPDATE) — see `billing.py` docstring + `abd1dc1`. Remaining watch-item is read amplification (1 SELECT per turn), not resets.

infra:
DECIDED (see PLAN.md 3b + README Deployment):

- app stays on k3s (Pi); **DB moves to Neon, direct host**. Not serverless (Lambda rejected: the refactor — ASGI->Lambda adapter + pool lifecycle under freeze/thaw — buys nothing on an LLM-bound workload).
- matches the existing gitops shape (`apps/diagram`): replicas 1, `imagePullSecrets: [ghcr-login]`, terraform-owned `maxterview-secrets`, ingress `/api`->backend:8000 + `/`->frontend:8080. see PLAN.md 3b.
- no DB pod in prod, so `DATABASE_URL` is an external secret and only compose-dev still composes it (D5 amended).
- remaining risks: pi->neon latency + free-tier scale-to-zero cold start. measure before trusting it.
- gitops adoption (manifests + CD tag-bump job) is a pending milestone, not started by design.
- dropped/optional:
  - terraform + helm with k3s + postgres pods pvc on raspi5 — no longer needed for the db (no pvc to babysit)
  - aws (rds + bedrock + ec2) — most work, most cost, no benefit at this scale
  - local ai on pc + tailscale on ec2/pods — still open only if LLM spend becomes the dominant cost
- bonus worth using: neon branching for per-PR test databases instead of a shared CI postgres service
