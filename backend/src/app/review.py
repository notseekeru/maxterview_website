"""One resume review: a ladder over the bands a resume is screened against, a call on each block the
page carries, and the edits that move it. The shape lives here so the prompt, the response model, the
DB and the tests read the same vocabulary; app/llm.py writes the words into it."""

import hashlib
import re

from app import levels

# The bars a resume is actually screened against, cheapest first. `any` is a dial, not a bar.
RUNGS: tuple[str, ...] = levels.LEVELS[1:]

# Worst to best on both vocabs: the index IS the rank `staircase` clamps with.
CALLS: tuple[str, ...] = ("fails", "close", "passes")
SECTION_CALLS: tuple[str, ...] = ("bloat", "weak", "fine", "strong")

MAX_SECTIONS = 6
MAX_REWRITES = 3
NAME_MAX = 40
FIELD_MAX = 300
LINE_MAX = 400
VERDICT_MAX = 1200

_RUNG = {rung: idx for idx, rung in enumerate(RUNGS)}
_CALL = {call: idx for idx, call in enumerate(CALLS)}


def source_hash(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def slug(value) -> str | None:
    if not isinstance(value, str):
        return None
    return re.sub(r"[\s-]+", "_", value.strip().lower()) or None


def rung(value) -> str | None:
    # The schema enum already carries the slugs; this is the weak-backend path, where a model answers
    # with the label it was shown ("Mid-level") instead of the id.
    got = slug(value)
    if got in _RUNG:
        return got
    return next((r for r in RUNGS if got and got.startswith(r)), None)


def claim(value, limit: int = FIELD_MAX) -> str:
    # The prompt asks for one line; the server flattens it anyway, or the model's own newlines land in
    # the card as literal markup.
    return " ".join(value.split())[:limit] if isinstance(value, str) else ""


def staircase(calls: list[tuple[str, str]]) -> tuple[list[tuple[str, str]], bool]:
    """A resume that fails a band cannot clear the band above it, so a model that grades it higher is
    contradicting itself: the lower read wins and the clamp is reported."""
    ceiling = len(CALLS) - 1
    clamped = False
    out: list[tuple[str, str]] = []
    for rung, call in sorted(calls, key=lambda pair: _RUNG[pair[0]]):
        rank = min(_CALL[call], ceiling)
        clamped |= rank != _CALL[call]
        ceiling = rank
        out.append((rung, CALLS[rank]))
    return out, clamped


def reads_at(calls) -> str | None:
    passed = [rung for rung, call in calls if call == "passes"]
    return max(passed, key=_RUNG.__getitem__) if passed else None


# AI HERE: one framework-free self-check (AGENTS rule 5). A clamp that stops clamping would let the
# page render "senior: fails" above "staff: passes", which is the one contradiction the ladder exists
# to prevent.
# AI HERE: one framework-free self-check (AGENTS rule 5). A clamp that stops clamping would let the
# page render "senior: fails" above "staff: passes", which is the one contradiction the ladder exists
# to prevent.
assert staircase([("mid", "passes"), ("senior", "fails"), ("staff", "passes")]) == ([("mid", "passes"), ("senior", "fails"), ("staff", "fails")], True)
assert staircase(list(zip(RUNGS, ("passes", "passes", "passes", "close", "fails", "fails"), strict=True)))[1] is False
assert (reads_at([("junior", "passes"), ("senior", "fails")]), reads_at([("junior", "fails")]), reads_at([])) == ("junior", None, None)
assert (slug("Mid Level"), slug(" senior "), slug(7)) == ("mid_level", "senior", None)
assert (rung("Mid-level"), rung(" SENIOR "), rung("staff engineer"), rung("nonsense")) == ("mid", "senior", "staff", None)
# The ladder grades bars, not dials: a reordered levels vocabulary must not smuggle `any` onto it.
assert RUNGS == levels.LEVELS[1:] and "any" not in RUNGS
assert claim(" a\n\n b ") == "a b" and len(claim("x" * 999)) == FIELD_MAX
assert source_hash("") == hashlib.sha256(b"").hexdigest()
