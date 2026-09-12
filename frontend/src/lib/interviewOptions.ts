// Interview option vocabulary (mirrors backend app/models + app/levels).
// Role presets are significant tech roles offered as quick picks; the free-text
// input remains for anything not listed. Levels are the canonical seniority slugs,
// decisions the canonical post-interview hire/reject spectrum.

import type { CompanySize, Cynicism, Decision } from "@/lib/api";

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

// Interview dressing dials (mirrors backend app/dials.py). Slider positions are ARRAY INDEXES, so
// these orders are the API order and must not be re-sorted for display: company size runs
// unspecified -> biggest, cynicism kind -> skeptical.
export const COMPANY_SIZES: { value: CompanySize; label: string }[] = [
    { value: "any", label: "Any / Not sure" },
    { value: "1-10", label: "1-10" },
    { value: "11-50", label: "11-50" },
    { value: "51-200", label: "51-200" },
    { value: "201-1k", label: "201-1,000" },
    { value: "1k-5k", label: "1,000-5,000" },
    { value: "5k+", label: "5,000+" },
];

/** Suffix for the company-size value caption; "any" reads as a phrase, not a headcount. */
export function companySizeLabel(size: string): string {
    if (size === "any") return "Any / Not sure";
    return `${size} people`;
}

export const CYNICISM: { value: Cynicism; label: string; hint: string }[] = [
    { value: "kind", label: "Kind", hint: "gives you the benefit of the doubt" },
    { value: "neutral", label: "Neutral", hint: "neither talks you up nor tears you down" },
    { value: "skeptical", label: "Skeptical", hint: "assumes a polished answer hides an unproven one" },
];

/** The chitchat/behavioural/technical sliders are question budgets, 0..MIX_MAX. */
export const MIX_MAX = 4;
export const MIX_FIELDS = [
    { field: "mix_chitchat", label: "Chitchat", hint: "warm-up before the real questions" },
    { field: "mix_behavioural", label: "Behavioural", hint: "past-experience questions" },
    { field: "mix_technical", label: "Technical", hint: "role-specific questions" },
] as const;

export function mixCountLabel(n: number): string {
    return n === 0 ? "none" : n === 1 ? "1 question" : `${n} questions`;
}
