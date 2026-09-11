"""Target interview-level vocabulary for maxterview.

Single source of truth for the level slugs persisted on `interviews.level`:
the API validation, the LLM system prompt, and the frontend picker all derive
from these. `any` ("None / Not sure") means the mock interviewer calibrates
dynamically off the candidate's demonstrated answers instead of a fixed target.
"""

LEVELS: tuple[str, ...] = ("any", "intern", "junior", "mid", "senior", "staff", "principal")

LABELS: dict[str, str] = {
    "any": "Any / Not sure",
    "intern": "Intern",
    "junior": "Junior",
    "mid": "Mid-level",
    "senior": "Senior",
    "staff": "Staff",
    "principal": "Principal",
}

_ORDER = {slug: idx for idx, slug in enumerate(LEVELS)}


def label(level: str) -> str:
    return LABELS.get(level, level)
