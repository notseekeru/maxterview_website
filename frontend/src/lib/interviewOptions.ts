// Interview option vocabulary (mirrors backend app/models + app/levels).
// Role presets are significant tech roles offered as quick picks; the free-text
// input remains for anything not listed. Levels are the canonical seniority slugs,
// decisions the canonical post-interview hire/reject spectrum.

import type { Decision } from "@/lib/api";

export const ROLE_PRESETS = [
    "Frontend Engineer",
    "Backend Engineer",
    "Full-Stack Engineer",
    "DevOps / SRE",
    "Cloud / Platform Engineer",
    "Systems Infrastructure Engineer",
    "Security Engineer",
    "Network Engineer",
    "QA Automation Engineer",
    "Data Engineer",
    "Data Scientist",
    "Data Analyst",
    "Machine Learning Engineer",
    "AI / LLM Engineer",
    "Mobile Engineer",
    "Embedded / Firmware Engineer",
    "Game Developer",
    "Site Reliability Engineer",
    "Engineering Manager",
    "Product Manager",
    "Product Designer",
] as const;

export type InterviewLevel = "any" | "intern" | "junior" | "mid" | "senior" | "staff" | "principal";

export const LEVELS: { value: InterviewLevel; label: string }[] = [
    { value: "any", label: "Any / Not sure" },
    { value: "intern", label: "Intern" },
    { value: "junior", label: "Junior" },
    { value: "mid", label: "Mid-level" },
    { value: "senior", label: "Senior" },
    { value: "staff", label: "Staff" },
    { value: "principal", label: "Principal" },
];

export function levelLabel(level: string): string {
    return LEVELS.find((l) => l.value === level)?.label ?? level;
}

// Post-interview decision vocabulary (mirrors backend app/models.DECISIONS, in spectrum
// order). Labels stay short: they render under a four-segment bar.
export const DECISIONS: { value: Decision; label: string }[] = [
    { value: "reject", label: "Reject" },
    { value: "lean_reject", label: "Lean reject" },
    { value: "lean_hire", label: "Lean hire" },
    { value: "hire", label: "Hire" },
];

export function decisionLabel(decision: string): string {
    return DECISIONS.find((d) => d.value === decision)?.label ?? decision;
}

/** Right-of-centre half of the spectrum: the run would likely convert. */
export function isHiring(decision?: string | null): boolean {
    return decision === "hire" || decision === "lean_hire";
}
