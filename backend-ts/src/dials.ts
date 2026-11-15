export const COMPANY_SIZES = ["any", "1-10", "11-50", "51-200", "201-1k", "1k-5k", "5k+"] as const;

export const CYNICISM = ["kind", "neutral", "skeptical"] as const;

export const DEPTHS = ["screen", "standard", "full"] as const;

export const DIAL_FIELDS = ["company_size", "cynicism", "brutally_honest", "human_mode", "hardcore", "depth"] as const;

export type CompanySize = (typeof COMPANY_SIZES)[number];
export type Cynicism = (typeof CYNICISM)[number];
export type Depth = (typeof DEPTHS)[number];

export type PlanCounts = { rapport: number; background: number; competency: number; technical: number };

export const PLAN_COUNTS: Record<Depth, PlanCounts> = {
    screen: { rapport: 1, background: 1, competency: 2, technical: 2 },
    standard: { rapport: 1, background: 1, competency: 3, technical: 5 },
    full: { rapport: 2, background: 1, competency: 4, technical: 7 },
};

export const GRADED_PHASES = ["background", "competency", "competency_followup", "technical", "technical_followup"] as const;

function repeat(count: number, kinds: readonly string[]): string[] {
    return Array.from({ length: count }, () => kinds).flat();
}

// The depth a run was created with fixes its length: main.send_turn reads the closing turn off this length.
export function planPhases(depth: Depth): string[] {
    const counts = PLAN_COUNTS[depth];
    return [...repeat(counts.rapport, ["rapport"]), ...repeat(counts.background, ["background"]), ...repeat(counts.competency, ["competency", "competency_followup"]), ...repeat(counts.technical, ["technical", "technical_followup"]), "questions", "close"];
}
