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
contemplating---

- currently thinking using terraform + helm with k3s + postgres pods pvc (using my local raspi5 on my network) [the most simple to integrate becuz i have k3s running]
- or use cloud with but a little more complex if aws cuz if we use aws then we will need rds, bedrock ai, then ec2 instances
- or maybe use cloud postgres like neon then aws lamba for serverless fuctions but more refactor of code
  - real cost is NOT the db: an ASGI->Lambda adapter (mangum) + pool lifecycle under container freeze/thaw (asyncpg pool can hold a dead conn after thaw). LLM calls are seconds, so DB is not the bottleneck anyway.
- and also if we gonna we local ai on my pc then we need tailscale network on an ec2 instance or pods(if k3s or eks) or subnet something im not quite sure
- note worth only change is swapping to a cloud postgres like neon for better ci and seamless integration for it alot of bonus and offering some downside (eg availability and latency if query are far from the server but regardless net positive cuz i dont have to spin up pods on k3s i just replace the url)
  - constraint: use the DIRECT neon host, not `-pooler`. The pooler is PgBouncer transaction mode, which breaks asyncpg's implicit prepared statements (intermittent `prepared statement "__asyncpg_stmt_N__" does not exist`); that path needs `statement_cache_size=0`. Direct host = zero code changes.
  - latency caveat: pi->neon round trip is real network distance, unlike localhost. Measure before committing to it.
