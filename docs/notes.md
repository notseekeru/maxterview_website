> To AI reading this, do not implement. This is just notes of the user, strictly ignore this unless prompted to.

# MILESTONE

- resume ai reviewer for resume page so it can pass what the ai thinks for every level
- add some evals for ai quality
- redis caching
- make a job queue for not losing some works eg when you retry and go to another page it loses the retry and u have to try again the retry
- jev for classifier of grading, potentially cutting request limits, cost, latency or speed. maybe on nvidianim
- ask questions pi extensions limits questions need to fix

# FEATURES

- feat: port the ~/diagram_website failure mttr/mttd injection with an actual realistic metrics reinvented.
- feat: higher tier models for pro
- feat: add metrics in readme for hr stuff via from grafana is that possible
- feat: ai resume editor latex to display and edit kind alike overleaf?

# FIX

- grill the plan and architecture and code maintainability/readability. it matters to me when i skim code

# REFACTOR

- refactor: the phases dials maybe a bit weird, can we have a structured interview phased dialed with actual evidence and research how real interviews are usually conducted. always ask question.

# INFRA

## LLM upgrade path (from the architecture audit)

- **Eval harness.** stored interviews are a ready-made golden corpus. Freeze ~15 as fixtures,
  assert invariants (decision present, certainty in band, scores in range, classes valid, no
  self-contradiction like `reject` + all-floor scores + certainty 0), run before/after every prompt
  edit. Highest-leverage item here, and it is a script rather than a system. Today prompt changes
  ship unmeasured - including the injection guard.
- **Cheap lane for the mechanical hops.** Judge, moves and grader are classification, not writing.
  `LLM_GRADER_*` already routes two; the hardcore judge rides the same config and sits on the
  critical path (serialized before every hardcore reply). Config-only change.
- **Collapse grader -> formatter into one strict-schema call** for models that hold JSON. Takes
  Complete from 3 requests to 1 and deletes a hop that only exists because weak models drift.
- **Resume retrieval instead of re-sending 8k chars** every turn - pull only the sections the
  question touches. ~10x input reduction on resume-attached runs.

# BILLING (keys do not fix these)

- fix: no early renewal. `payments._resubscribe_block` answers 409 while a paid period is live, so
  nobody can extend before lapse; with no auto-renew, every 30 days is a fresh opt-in.
- feat: expiry reminder before the period ends. The stack has no email surface at all (no SMTP or
  Resend dep), so every lapse is silent.
- feat: receipts/invoices to the customer. Same missing email surface.

# OPTIMIZATION

- Optimize pool, maybe could use Neon Pooler
- Redis with caching strategies
- Set uvicorn workers to CPU Core count or less(probably 3)
- Limit Backend Query using paramaters and Pagination, Lazy-loading for frontend(dont matter in test but helpful for browser)
- Batching querys
- Async request, non blocking potentially parrarel
