> To AI reading this, do not implement. This is just notes of the user, strictly ignore this unless prompted to.

# MILESTONE

- add some evals for ai quality
- the voice feature and tts with video input from user
- backup as a milestone record it in readme, and use r2 new bucket

# FEATURES

- ai resume editor latex to display and edit kind alike overleaf?
- lazy loading cuz everything just render and causes fps drops (not latency or unoptimized roundtrips)

# FIX

- fix: make hardcore glow light red on chat interview
- fix: the preset is not saving at 2 templates is that normal and also can we add more templates, like, The killer, The griller, the chiller
- fix: the the manual button has no cooldown, if 1 click in 1 second = 1 but when 10 clicks in 1 second = 10 request. we have rate limit but is this a issue today?
- fix: global comment removal, if the code looks obvious/trivial and does not need comment -> delete. if related to infra, or could potentially be devastating if not stated -> keep. audit first, rate by removal and recommended deletion. then update agent.md for guardrailing against this. ask question before proceeding
- fix: dont say premium to users like explicitly just upgrade to premium something to get ---, ask question if uncertain like we use like physicological and marketing tactics
- grill the plan and architecture and code maintainability/readability. it matters to me when i skim code
- the personalData in portfolio is bloated
- after wiring the observability pipeline, we can proceed to writing the blog, and then we finish resume and analytics page and then record with recordly for project portfolio asset and maxterview landing page video opener asset

# REFACTOR

- refactor: how about we make development vars put into development env of infisical? but that would be creating a dependency to use internet just to fill the vars? but what if we boot strap and injected to .env so it works offline?

# INFRA

# INFRA

## LLM upgrade path (from the architecture audit)

Ranked by leverage, not effort. Tier 1 is cheap and is real engineering; Tier 2 only pays off once the
rail costs money or traffic is real. Measured ceiling today: ~28 concurrent normal users (~17 hardcore)
on the free-tier key, ~13-15 requests and ~19s for a 10-question run + Complete.

### Tier 1 - do these

- **Eval harness.** 98 stored interviews are a ready-made golden corpus. Freeze ~15 as fixtures,
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

### Tier 3 - only if it becomes a business

- Tier routing (small model for free users), BYOK pushed harder (already built - the real cost escape
  hatch), streaming progress for the grader so the wait is legible.

### Not doing

- Fine-tuning or distilling into a local 4B (it cannot serve the load, and it would wreck the rubric -
  the value is the pipeline, not the model), vector DBs, agent/multi-model orchestration.

# PERSONAL ACCOMPLISHMENTS/STRUGGLES THAT GOT ME EXCITED AND THINKING

- because of my existing infra (k3s, terraform, gitops, auto commit pipeline and stuff) is the reason why i can ship fast and automate deployments in my work, reducing friction and im happy i did what i did before and so proud of my architecture
- mcp wiring to playwright, rassled with it non stop, made tradeoffs and decisions and research until agent can independantly see the dom
- clerk, stripe and paymongo and alot of wiring on the 3rd party side but worth it so it can be automated and review by AI and setup by AI removing friction from using browser just for configuration
- dev, stage, prod separation haves another mental model that im very excited to show off, staging is the one that needs to be injected into my brain so i can practice how production deployment works
- currently setting staging rn, i was suprised i needed a separate and extra environment for it. i made another separate module for it in isolation. i shouldve seen this coming this like staging should be isolated not shared, which makes sense but i seemed like i forgot for a moment lol.
- just finished my staging env, i have done alot of stuff that i supervised with my AI, alot of it just monitor what it does and guiding what it is struggling with. for example i needed him to reference the infisical vars, someone who probably vibecode would trust ai that it is not possible with infisical cli but i persisted and guided it(cuz i know why and what tool im using) and not guide me there to what its believe without proper research surface
- quite alot was added in my infrastructure but i try to maintain its isolation, clarity and cohesion at the same time while understanding my whole system no big deal just another mental model
- yeah this is a little bit of overengineer and i would probably turn this staging stuff of in the near future cuz i dont need it im a 1 man team and just doing this for fun and i have tradeoffs to manage and also this is not a real production product yet cuz i dont have users and stakes to hold
- the staging aspect is now removed and verified no more dev/staging/prod just dev/prod
