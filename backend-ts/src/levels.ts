export const LEVELS = ["any", "intern", "junior", "mid", "senior", "staff", "principal"] as const;

export type Level = (typeof LEVELS)[number];

export const LABELS: Record<Level, string> = {
    any: "Any",
    intern: "Intern",
    junior: "Junior",
    mid: "Mid-level",
    senior: "Senior",
    staff: "Staff",
    principal: "Principal",
};

export function label(level: string): string {
    return LABELS[level as Level] ?? level;
}
