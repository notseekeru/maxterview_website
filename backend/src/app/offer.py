"""Deterministic offer simulation: one graded run in, one offer's numbers out.

Priced off the SOFT-SKILL read first (the communication axis: clarity, relevance, structure,
confidence), then substance, then the move-review accuracy, so the letter mirrors how the candidate
communicated rather than forming a second opinion about them. Deterministic on purpose: the same
scores always price the same offer, which is what lets the analytics built on top of it mean anything,
and it costs no model call.

No prose lives here. The letter's wording is the frontend's, rendered around these numbers, so this
file is the only thing that decides what an offer is worth.
"""

from datetime import date, datetime, timedelta
from typing import Any, NamedTuple

from app import levels
from app.dimensions import DIMENSION_AXES

# USD annual base, per target level: (floor, ceiling, title prefix). `any` is priced as mid - the
# target level was never set, and guessing seniority off a role string is how a mock interview ends up
# paying a junior a principal's band.
MID: tuple[int, int, str] = (110_000, 150_000, "")
BANDS: dict[str, tuple[int, int, str]] = {
    "intern": (45_000, 70_000, "Intern"),
    "junior": (85_000, 115_000, "Junior"),
    "mid": MID,
    "senior": (145_000, 200_000, "Senior"),
    "staff": (190_000, 255_000, "Staff"),
    "principal": (240_000, 330_000, "Principal"),
    "any": MID,
}

# What prices the offer, and how much. Communication carries half because this is a communication
# assessment: it is the axis a transcript can actually evidence. Substance and the move review vote
# only when the run has something to score them on - see performance(). Profile (ownership,
# collaboration, growth) is deliberately unpriced: it is the axis a single interview reads least
# reliably, and paying for it would turn a vibe into a number.
WEIGHTS: dict[str, float] = {"communication": 0.5, "substance": 0.25, "accuracy": 0.25}

# Performance -> what the letter calls it (slug, floor, label). The percentages above are the number,
# this is the sentence a candidate reads next to it.
TIERS: tuple[tuple[str, int, str], ...] = (
    ("below", 0, "Below the bar"),
    ("meets", 40, "Meets the bar"),
    ("strong", 65, "Strong offer"),
    ("top", 85, "Top of the ladder"),
)

# The notice the letter promises before day one.
NOTICE_DAYS = 21

# Paid time off is the one rung everybody clears and nobody gets a fixed number of, so it is scaled
# rather than gated: 12 days at the bottom of the ladder, 24 at the top.
PTO_KEY = "pto"
PTO_MIN, PTO_SPAN = 12, 12


class Rung(NamedTuple):
    key: str
    label: str
    # The performance floor that unlocks it.
    threshold: int
    value: str


# Ascending by threshold: the rung order is the progression, which is what the analytics page draws.
# Thresholds are deliberately spread over the 0-100 scale so a history of runs is partly a history of
# benefits earned and partly one of benefits missed.
LADDER: tuple[Rung, ...] = (
    Rung("health", "Health insurance", 20, "Medical, dental and vision premiums covered"),
    Rung("retirement", "401(k) match", 30, "4% of base, vested immediately"),
    Rung("remote", "Remote setup", 40, "$1,500 one-time stipend"),
    Rung("learning", "Learning budget", 50, "$2,500 a year for courses, books and conferences"),
    Rung("wellness", "Wellness allowance", 55, "$900 a year"),
    Rung("equity_refresh", "Annual equity refresh", 65, "A new grant every year, not only at hire"),
    Rung("relocation", "Relocation support", 80, "Up to $12,000, or the remote equivalent"),
    Rung("sabbatical", "Paid sabbatical", 92, "Four weeks, after three years"),
)


class Terms(NamedTuple):
    title: str
    band: str
    base_salary: int
    signing_bonus: int
    equity: int
    performance: int
    benefits: list[dict[str, str]]


def _round_to(value: float, step: int) -> int:
    """Salaries are spoken in round numbers: an offer that reads $137,431 looks computed, not offered."""
    return int(round(value / step) * step)


def pto_days(performance: int) -> int:
    return PTO_MIN + round(PTO_SPAN * performance / 100)


def benefits(performance: int) -> list[dict[str, str]]:
    """The ladder this offer cleared. PTO first: it is the one rung every offer carries, so the letter
    opens with days rather than with a perk."""
    cleared = [{"key": PTO_KEY, "label": "Paid time off", "value": f"{pto_days(performance)} days a year"}]
    cleared += [{"key": r.key, "label": r.label, "value": r.value} for r in LADDER if performance >= r.threshold]
    return cleared


def ladder() -> tuple[tuple[str, str], ...]:
    """Every rung as (key, label), in ladder order. The analytics counts offers against THIS list, so a
    rung nobody has cleared yet still appears on the page instead of vanishing."""
    return ((PTO_KEY, "Paid time off"),) + tuple((r.key, r.label) for r in LADDER)


def band_key(level: str) -> str:
    """The band a target level prices against. An unknown slug is priced as mid rather than refused:
    the alternative is a letter with no numbers on it because a vocabulary grew a word."""
    return level if level in BANDS else "mid"


def band_range(level: str) -> tuple[int, int, str]:
    return BANDS[band_key(level)]


def tier(performance: int) -> tuple[str, str]:
    """(slug, label) for a performance number. Scanned worst-first, so the rung's floor is the bar."""
    key, _, label = next((t for t in reversed(TIERS) if performance >= t[1]), TIERS[0])
    return key, label


def _axis_mean(scores: dict[str, Any], axis: str) -> float | None:
    """Mean of the axis's dims that were ASSESSED, or None when the axis was never probed. A hole is
    absence, not a zero: a run that only covered communication must not be docked for substance."""
    dims = DIMENSION_AXES[axis]
    present = [v for k, v in scores.items() if k in dims and isinstance(v, (int, float)) and not isinstance(v, bool)]
    return sum(present) / len(present) if present else None


def performance(scores: dict[str, Any], accuracy: int | None) -> int | None:
    """0-100 read of the run, or None when nothing about it was scored.

    Each signal is normalized to 0-1 and the weights renormalize over the signals present, so a run
    scored on communication alone is priced on communication alone rather than diluted toward zero."""
    signals: list[tuple[float, float]] = []
    for axis in ("communication", "substance"):
        mean = _axis_mean(scores, axis)
        if mean is not None:
            # 1-10 -> 0-1 off the scale's own floor: a 1 is no performance, not 10%.
            signals.append((WEIGHTS[axis], (min(10.0, max(1.0, mean)) - 1) / 9))
    if accuracy is not None:
        signals.append((WEIGHTS["accuracy"], min(100, max(0, accuracy)) / 100))
    if not signals:
        return None
    return round(100 * sum(w * v for w, v in signals) / sum(w for w, _ in signals))


def title(role: str, level: str) -> str:
    """The offer's job title. A role that already names its own seniority keeps it, so the letter does
    not read "Senior Senior Product Manager"."""
    prefix = band_range(level)[2]
    return role if prefix and role.lower().startswith(prefix.lower()) else f"{prefix} {role}".strip()


def terms(role: str, level: str, scores: dict[str, Any], accuracy: int | None) -> Terms | None:
    """Price one offer, or None when the review scored nothing (an unpriced offer is a guess).

    The base sits inside the band by construction, so a run can be paid poorly for its level but never
    paid off-scale: whatever the model scores, the level the candidate dialled in still bounds it.
    """
    perf = performance(scores, accuracy)
    if perf is None:
        return None
    floor, ceiling, _ = band_range(level)
    base = _round_to(floor + (ceiling - floor) * perf / 100, 500)
    # Both are gated at the middle of the ladder: an offer below the bar pays the band floor and PTO,
    # which is what a letter looks like when the run was weak, and it keeps equity from reading as a
    # participation trophy at the bottom.
    equity = 0 if perf < 30 else _round_to(base * (0.02 + 0.18 * perf / 100), 1000)
    signing = 0 if perf < 45 else _round_to(base * 0.10 * (perf - 45) / 55, 500)
    return Terms(title(role, level), band_key(level), base, signing, equity, perf, benefits(perf))


def start_date(offered: datetime) -> date:
    return (offered + timedelta(days=NOTICE_DAYS)).date()


# AI HERE: one framework-free self-check (AGENTS rule 5). A level with no band cannot be priced (it
# would silently fall back to mid), the ladder must climb, and the axis weights must name real axes.
assert set(BANDS) == set(levels.LEVELS), sorted(set(BANDS) ^ set(levels.LEVELS))
assert [floor for _, floor, _ in TIERS] == sorted(floor for _, floor, _ in TIERS)
assert [r.threshold for r in LADDER] == sorted(r.threshold for r in LADDER)
assert set(WEIGHTS) - {"accuracy"} <= set(DIMENSION_AXES)
assert abs(sum(WEIGHTS.values()) - 1.0) < 1e-9
assert (performance({}, None), performance({"clarity": "high"}, None)) == (None, None)
assert (pto_days(0), pto_days(100)) == (PTO_MIN, PTO_MIN + PTO_SPAN)
