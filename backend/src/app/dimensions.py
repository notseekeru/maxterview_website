# `culture fit` deliberately NOT a dim: scored directly it is a bias proxy with no evidence bar.
DIMENSION_AXES: dict[str, tuple[str, ...]] = {
    "communication": ("clarity", "relevance", "structure", "confidence"),
    "substance": ("technical_depth", "problem_solving", "production"),
    "profile": ("ownership", "collaboration", "growth_potential"),
}

FEEDBACK_DIMS: tuple[str, ...] = tuple(d for dims in DIMENSION_AXES.values() for d in dims)

# A dim declared twice would silently shift every axis mean.
assert len(FEEDBACK_DIMS) == len(set(FEEDBACK_DIMS))
