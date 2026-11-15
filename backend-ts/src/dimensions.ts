// `culture fit` deliberately absent: scored directly it is a bias proxy with no evidence bar.
export const DIMENSION_AXES: Record<string, readonly string[]> = {
    communication: ["clarity", "relevance", "structure", "confidence"],
    substance: ["technical_depth", "problem_solving", "production"],
    profile: ["ownership", "collaboration", "growth_potential"],
};

export const FEEDBACK_DIMS: readonly string[] = Object.values(DIMENSION_AXES).flat();

// A dim declared twice would silently shift every axis mean.
if (new Set(FEEDBACK_DIMS).size !== FEEDBACK_DIMS.length) throw new Error("dimensions: a dim is declared twice");
