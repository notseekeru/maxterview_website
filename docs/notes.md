> To AI reading this, do not implement. This is just notes of the user, strictly ignore this unless prompted to.

# MILESTONE

- resume ai reviewer
- add some evals for ai quality
- add caching like redis for a lil bit of scalability
- reconsider ssr
- make a job queue maybe for not losing some works eg when you retry and go to another page it loses the retry and u have to try again the retry
- jev for classifier?

# FEATURES


- feat: diagram architecture just like how infisical does it in landing page somewhere
- feat: higher tier models for pro
- feat: add metrics in readme for hr stuff via from grafana
- feat: ai resume editor latex to display and edit kind alike overleaf?

# FIX

- grill the plan and architecture and code maintainability/readability. it matters to me when i skim code

# REFACTOR


# INFRA

## LLM upgrade path (from the architecture audit)

### Tier 1 - do these

- **Eval harness.** stored interviews are a ready-made golden corpus. Freeze ~15 as fixtures,
  assert invariants (decision present, certainty in band, scores in range, classes valid, no
  self-contradiction like `reject` + all-floor scores + certainty 0), run before/after every prompt
  edit. Highest-leverage item here, and it is a script rather than a system. Today prompt changes
  ship unmeasured - including the injection guard.
- **Provider fallback chain.** primary -> secondary -> stub, so a 429/503/EOL id degrades instead of
  failing the turn or leaving Complete unscored. We hit all three in one day (429 burst, 503 under
  load, 410 end-of-life). `LLMConfig` is OpenAI-compatible everywhere, so this is a loop and a retry
  budget, not a rewrite.
- **Cheap lane for the mechanical hops.** Judge, moves and grader are classification, not writing.
  `LLM_GRADER_*` already routes two; the hardcore judge rides the same config and sits on the
  critical path (serialized before every hardcore reply). Config-only change.

### Tier 2 - when the rail costs money or traffic is real

- **Cache-aware prompt layout.** Move the volatile phase directive AFTER the transcript so system +
  transcript becomes a stable prefix. Worthless on NIM today (reports no cached tokens; repeat TTFT
  2.87s -> 0.89s, n=1), decisive on any provider that meters cached input.
- **Collapse grader -> formatter into one strict-schema call** for models that hold JSON. Takes
  Complete from 3 requests to 1 and deletes a hop that only exists because weak models drift.
- **Complete as a background job.** It is ~19s of held connection for zero user-facing reason (the
  grader alone is ~17.7s of it); queue it and let the review page poll.
- **Resume retrieval instead of re-sending 8k chars** every turn - pull only the sections the
  question touches. ~10x input reduction on resume-attached runs.

# BILLING (keys do not fix these)

- fix: no early renewal. `payments._resubscribe_block` answers 409 while a paid period is live, so
  nobody can extend before lapse; with no auto-renew, every 30 days is a fresh opt-in.
- feat: expiry reminder before the period ends. The stack has no email surface at all (no SMTP or
  Resend dep), so every lapse is silent.
- feat: receipts/invoices to the customer. Same missing email surface.
