"""Level slugs persisted on `interviews.level`. API validation, LLM system prompt and frontend
picker all derive from these. `any` = calibrate off the candidate's demonstrated answers."""

LEVELS: tuple[str, ...] = ("any", "intern", "junior", "mid", "senior", "staff", "principal")

LABELS: dict[str, str] = {
    "any": "Any",
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
