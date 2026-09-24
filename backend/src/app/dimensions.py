"""The 1-10 feedback dimensions, grouped into axes: the membership only.

Shared by the grader's prompt (`llm.py`, which owns the rubric PROSE) and the offer rate card
(`offer.py`), so an axis cannot mean one thing to one reader and another thing to the next. Deliberately
import-free: anything importing it (offer pricing included) must not drag the LLM client in with it.
"""

# Axis -> dims, in render order. Communication is the original four, kept as-is so old runs stay
# comparable; substance is the reviewer's read on the work, profile on the person. `culture fit` is
# deliberately NOT a dim: scored directly it is a bias proxy with no evidence bar, so it is split
# into the two things people actually mean by it - did they own the work, and how do they work with
# others (ownership, collaboration).
DIMENSION_AXES: dict[str, tuple[str, ...]] = {
    "communication": ("clarity", "relevance", "structure", "confidence"),
    "substance": ("technical_depth", "problem_solving", "production"),
    "profile": ("ownership", "collaboration", "growth_potential"),
}

FEEDBACK_DIMS: tuple[str, ...] = tuple(d for dims in DIMENSION_AXES.values() for d in dims)

# AI HERE: one framework-free self-check (AGENTS rule 5). A dim declared twice would silently shift
# every axis mean.
assert len(FEEDBACK_DIMS) == len(set(FEEDBACK_DIMS))
