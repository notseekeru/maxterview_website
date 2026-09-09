// Interview option vocabulary (mirrors backend app/models + app/levels).
// Role presets are significant tech roles offered as quick picks; the free-text
// input remains for anything not listed. Levels are the canonical seniority slugs.

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
