"""Create-interview dial vocabulary for maxterview.

Single source of truth for the knobs persisted on `interviews.*` beyond role/topic/level:
API validation, the DB CHECKs (migration 0007), the LLM prompt blocks, and the frontend
sliders all derive from these. `level` keeps its own vocabulary (app/levels.py) - it is the
target seniority, not a tuning knob.

No prompt text lives here: llm.py owns the words (see CYNICISM_PROMPTS, HUMAN/PLAIN register,
and interview_plan for the question mix).
"""

# Target employer size. `any` = unspecified, and the interviewer then sizes its own scenario
# framing (data volumes, team shape, process weight) off the role instead of assuming a
# startup or a bigco.
COMPANY_SIZES: tuple[str, ...] = ("any", "1-10", "11-50", "51-200", "201-1k", "1k-5k", "5k+")

# How skeptical the interviewer is: kind (benefit of the doubt) -> neutral -> skeptical
# (assumes a polished answer is hiding an unproven one and probes for evidence).
CYNICISM: tuple[str, ...] = ("kind", "neutral", "skeptical")

# Per-kind question budget ceiling for the chitchat/behavioural/technical sliders.
MIX_MAX = 4
