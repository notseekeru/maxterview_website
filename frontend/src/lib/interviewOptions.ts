import type { CompanySize, Cynicism, Decision, Depth } from "@/lib/api";

export const ROLE_PRESETS = [
    "Frontend Engineer",
    "Backend Engineer",
    "Full-Stack Engineer",
    "Software Engineer",
    "Devops Engineer",
    "Site Reliability Engineer",
    "Cloud Engineer",
    "Platform Engineer",
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
    "Engineering Manager",
    "Product Manager",
    "Product Designer",
] as const;

export type InterviewLevel = "any" | "intern" | "junior" | "mid" | "senior" | "staff" | "principal";

export const LEVELS: { value: InterviewLevel; label: string }[] = [
    { value: "any", label: "Any" },
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

export const DECISIONS: { value: Decision; label: string }[] = [
    { value: "reject", label: "Reject" },
    { value: "lean_reject", label: "Lean reject" },
    { value: "lean_hire", label: "Lean hire" },
    { value: "hire", label: "Hire" },
];

export function decisionLabel(decision: string): string {
    return DECISIONS.find((d) => d.value === decision)?.label ?? decision;
}

export function isHiring(decision?: string | null): boolean {
    return decision === "hire" || decision === "lean_hire";
}

export const COMPANY_SIZES: { value: CompanySize; label: string }[] = [
    { value: "any", label: "Any" },
    { value: "1-10", label: "1-10" },
    { value: "11-50", label: "11-50" },
    { value: "51-200", label: "51-200" },
    { value: "201-1k", label: "201-1,000" },
    { value: "1k-5k", label: "1,000-5,000" },
    { value: "5k+", label: "5,000+" },
];

export function companySizeLabel(size: string): string {
    if (size === "any") return "Any";
    return `${size} people`;
}

export const CYNICISM: { value: Cynicism; label: string }[] = [
    { value: "kind", label: "Kind" },
    { value: "neutral", label: "Neutral" },
    { value: "skeptical", label: "Skeptical" },
];

export const DEPTHS: { value: Depth; label: string; minutes: number }[] = [
    { value: "screen", label: "Screen", minutes: 20 },
    { value: "standard", label: "Standard", minutes: 40 },
    { value: "full", label: "Full loop", minutes: 60 },
];

// The form previews the plan before a run exists, so it mirrors backend app/dials.PLAN_COUNTS. Every
// competency and technical question owns a follow-up turn, hence twice the question count.
const PLAN_COUNTS: Record<Depth, { rapport: number; background: number; competency: number; technical: number }> = {
    screen: { rapport: 1, background: 1, competency: 2, technical: 2 },
    standard: { rapport: 1, background: 1, competency: 3, technical: 5 },
    full: { rapport: 2, background: 1, competency: 4, technical: 7 },
};

export const PHASE_LABELS: Record<string, string> = {
    rapport: "Rapport",
    background: "Background",
    competency: "Competency",
    technical: "Technical",
    questions: "Your questions",
    close: "Close",
};

export function segmentsFromPlan(plan: string[]): { label: string; count: number; slots: number; start: number }[] {
    const out: { label: string; count: number; slots: number; start: number }[] = [];
    plan.forEach((phase, i) => {
        const followUp = phase.endsWith("_followup");
        const label = PHASE_LABELS[phase.replace("_followup", "")] ?? phase;
        const last = out[out.length - 1];
        if (last?.label === label) {
            last.slots += 1;
            last.count += followUp ? 0 : 1;
        } else out.push({ label, count: followUp ? 0 : 1, slots: 1, start: i });
    });
    return out;
}

export function planSegments(depth: Depth): { label: string; count: number }[] {
    const c = PLAN_COUNTS[depth] ?? PLAN_COUNTS.standard;
    return [
        { label: PHASE_LABELS.rapport, count: c.rapport },
        { label: PHASE_LABELS.background, count: c.background },
        { label: PHASE_LABELS.competency, count: c.competency },
        { label: PHASE_LABELS.technical, count: c.technical },
        { label: PHASE_LABELS.questions, count: 1 },
        { label: PHASE_LABELS.close, count: 1 },
    ];
}

export function planSummary(segments: { label: string; count: number }[]): string {
    return segments.map((s) => (s.count > 1 ? `${s.count} ${s.label.toLowerCase()}` : s.label.toLowerCase())).join(" · ");
}

export const DIAL_FIELDS = ["company_size", "cynicism", "brutally_honest", "human_mode", "hardcore", "depth"] as const;
