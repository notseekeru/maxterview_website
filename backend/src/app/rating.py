from collections.abc import Iterable
from typing import NamedTuple


class Move(NamedTuple):
    cls: str
    comment: str | None = None


# Best -> worst. Seven is the useful resolution: a vague answer and an evasive one want different
# words, and anything finer is noise.
MOVE_CLASSES: tuple[str, ...] = ("brilliant", "great", "good", "book", "inaccuracy", "mistake", "blunder")

# Hardcore mode fails the run on any of these: wrong (mistake), nothing usable (blunder) and vague
# (inaccuracy). `book` and above survive: correct-but-recited is a small deduction, not a failure.
FAIL_CLASSES: tuple[str, ...] = ("inaccuracy", "mistake", "blunder")

# What one classed turn is worth out of 1.0. `book` sits just under `good`: correct but generic is
# a small deduction, not a flaw.
MOVE_POINTS: dict[str, float] = {
    "brilliant": 1.0,
    "great": 1.0,
    "good": 0.85,
    "book": 0.8,
    "inaccuracy": 0.6,
    "mistake": 0.35,
    "blunder": 0.0,
}

# Accuracy -> grade, best first. Accuracy is the continuous number the dashboard trends; the letter
# is what one run reads as.
GRADES: tuple[str, ...] = ("S", "A", "B", "C", "D", "F")
GRADE_BANDS: tuple[tuple[int, str], ...] = ((90, "S"), (80, "A"), (70, "B"), (60, "C"), (50, "D"))

# STUB_MODE only (no LLM configured: dev/seed/tests). Cycled over the transcript so a model-free run
# still exercises the review UI. Opens on `good` so a one-answer smoke run does not read S or F.
STUB_MOVE_CYCLE: tuple[str, ...] = ("good", "inaccuracy", "great", "book", "mistake")

# Canned per class: a model-free run must render the note without spending a model call, and canned text
# never claims to have read the answer.
STUB_MOVE_NOTES: dict[str, str] = {
    "brilliant": "No notes: this one went past what was asked. Repeat it by naming the trade-off and the number that backed it.",
    "great": "A real example with your own decisions in it, which is the bar. Add what you would do differently now.",
    "good": "Correct and complete, which is the job. One number or one outcome would make it stick.",
    "book": "Correct but recited: no sign you have done it. Next time, answer with the time you actually shipped it.",
    "inaccuracy": "Right direction, no evidence: name the situation you were in and the call you made.",
    "mistake": "This answered something other than the question. Restate the question in your first line, then answer it.",
    "blunder": 'Nothing usable landed. Even "I have not done that; here is how I would find out" scores above this.',
}


def accuracy(classes: Iterable[str]) -> int | None:
    graded = [MOVE_POINTS[c] for c in classes if c in MOVE_POINTS]
    if not graded:
        return None
    return int(100 * sum(graded) / len(graded) + 0.5)  # half-up: round() would flip .5 on digit parity


def grade(acc: int | None, *, failed: bool = False) -> str | None:
    if failed:
        return "F"
    if acc is None:
        return None
    return next((g for floor, g in GRADE_BANDS if acc >= floor), "F")


# AI HERE: one framework-free self-check (AGENTS rule 5). A class without a point value, or bands
# that stop matching GRADES, fails here instead of silently dropping turns out of the average.
assert set(MOVE_CLASSES) == set(MOVE_POINTS) and set(STUB_MOVE_CYCLE) <= set(MOVE_CLASSES)
assert set(STUB_MOVE_NOTES) == set(MOVE_CLASSES)  # a stub class with no note would render an empty tip
assert set(FAIL_CLASSES) <= set(MOVE_CLASSES)
assert [g for _, g in GRADE_BANDS] == list(GRADES[: len(GRADE_BANDS)])
assert GRADE_BANDS == tuple(sorted(GRADE_BANDS, reverse=True))
assert (accuracy([]), accuracy(["brilliant"]), accuracy(["blunder"])) == (None, 100, 0)
assert (grade(None), grade(100), grade(89), grade(49), grade(0)) == (None, "S", "A", "F", "F")
assert grade(0, failed=True) == "F" and grade(100, failed=True) == "F"
assert Move("good") == ("good", None)  # a class-only annotation still unpacks as (cls, comment)
