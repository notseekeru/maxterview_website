// Display half of the rubric: axis grouping, labels, radar ticks. backend app/llm.py owns the rubric,
// and nothing here decides a score.
//
// A dim the interview never probed is absent, which reads as "not assessed", not zero, so every helper
// takes only the keys a run actually scored.

const AXES = [
    { value: "communication", label: "Communication" },
    { value: "substance", label: "Substance" },
    { value: "profile", label: "Profile" },
] as const;

interface DimMeta {
    label: string;
    /** Radar tick: ten full dim names around one polygon do not fit. */
    short: string;
    axis: string;
}

export const DIMENSIONS: Record<string, DimMeta> = {
    clarity: { label: "Clarity", short: "Clarity", axis: "communication" },
    relevance: { label: "Relevance", short: "Relevance", axis: "communication" },
    structure: { label: "Structure", short: "Structure", axis: "communication" },
    confidence: { label: "Confidence", short: "Confidence", axis: "communication" },
    technical_depth: { label: "Technical depth", short: "Technical", axis: "substance" },
    problem_solving: { label: "Problem solving", short: "Problem", axis: "substance" },
    production: { label: "Production", short: "Production", axis: "substance" },
    ownership: { label: "Ownership", short: "Ownership", axis: "profile" },
    collaboration: { label: "Collaboration", short: "Collab", axis: "profile" },
    growth_potential: { label: "Growth potential", short: "Growth", axis: "profile" },
};

export const dimLabel = (key: string) => DIMENSIONS[key]?.label ?? key.replace(/_/g, " ");
export const dimShort = (key: string) => DIMENSIONS[key]?.short ?? dimLabel(key);

/** The whole rubric, in registry order. The review renders all of it and marks the holes: "the
 *  interviewer never asked" and "the rubric has no such dim" must not look the same. */
export const ALL_DIMS = Object.keys(DIMENSIONS);

/** Registry order, with keys this file does not know yet appended alphabetically: a backend that
 *  ships a dim before its label does still renders it rather than dropping it. */
export function orderDims(keys: string[]): string[] {
    return [...Object.keys(DIMENSIONS).filter((d) => keys.includes(d)), ...keys.filter((k) => !(k in DIMENSIONS)).sort()];
}

export interface AxisGroup {
    axis: string;
    label: string;
    dims: string[];
}

export function groupDims(keys: string[]): AxisGroup[] {
    const groups: AxisGroup[] = [...AXES, { value: "other", label: "Other" }].map((a) => ({ axis: a.value, label: a.label, dims: [] }));
    const byAxis = new Map(groups.map((g) => [g.axis, g]));
    for (const key of orderDims(keys)) byAxis.get(DIMENSIONS[key]?.axis ?? "other")?.dims.push(key);
    return groups.filter((g) => g.dims.length > 0);
}
