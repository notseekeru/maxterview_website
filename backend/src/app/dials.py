"""Dial vocabulary persisted on `interviews.*` beyond role/topic/level. API validation, the DB
CHECKs (migration 0007), the LLM prompt blocks and the frontend sliders all derive from these.

`level` keeps its own vocabulary (app/levels.py): target seniority, not a tuning knob. No prompt
text here, llm.py owns the words (CYNICISM_PROMPTS, interview_plan).
"""

# `any` = unspecified, and the interviewer sizes its own scenario framing (data volumes, team
# shape, process weight) off the role instead of assuming a startup or a bigco.
COMPANY_SIZES: tuple[str, ...] = ("any", "1-10", "11-50", "51-200", "201-1k", "1k-5k", "5k+")

# How skeptical: kind (benefit of the doubt) -> neutral -> skeptical (reads a polished answer as
# hiding an unproven one and probes for evidence).
CYNICISM: tuple[str, ...] = ("kind", "neutral", "skeptical")

# Per-kind question budget ceiling for the chitchat/behavioural/technical sliders.
MIX_MAX = 4

# Same dials as pydantic field names, in the order every read/write uses. Identical in the DB, so
# one tuple serves the `Dials(**row)` build and every interview-read column.
DIAL_FIELDS: tuple[str, ...] = ("company_size", "cynicism", "brutally_honest", "human_mode", "hardcore", "mix_chitchat", "mix_behavioural", "mix_technical")
