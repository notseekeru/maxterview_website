from typing import NamedTuple

COMPANY_SIZES: tuple[str, ...] = ("any", "1-10", "11-50", "51-200", "201-1k", "1k-5k", "5k+")

CYNICISM: tuple[str, ...] = ("kind", "neutral", "skeptical")

DEPTHS: tuple[str, ...] = ("screen", "standard", "full")

DIAL_FIELDS: tuple[str, ...] = ("company_size", "cynicism", "brutally_honest", "human_mode", "hardcore", "depth")


class PlanCounts(NamedTuple):
    rapport: int
    background: int
    competency: int
    technical: int


PLAN_COUNTS: dict[str, PlanCounts] = {
    "screen": PlanCounts(rapport=1, background=1, competency=2, technical=2),
    "standard": PlanCounts(rapport=1, background=1, competency=3, technical=5),
    "full": PlanCounts(rapport=2, background=1, competency=4, technical=7),
}

GRADED_PHASES: tuple[str, ...] = ("background", "competency", "competency_followup", "technical", "technical_followup")


def plan_phases(depth: str) -> tuple[str, ...]:
    c = PLAN_COUNTS[depth]
    return (
        *("rapport" for _ in range(c.rapport)),
        *("background" for _ in range(c.background)),
        *(kind for _ in range(c.competency) for kind in ("competency", "competency_followup")),
        *(kind for _ in range(c.technical) for kind in ("technical", "technical_followup")),
        "questions",
        "close",
    )


# A depth the API accepts with no plan would 500 on create, and the closing turn is read off the plan's
# length, so the vocabulary and the shape have to name the same three values.
assert set(PLAN_COUNTS) == set(DEPTHS)
