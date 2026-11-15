import { DIMENSION_AXES } from "./dimensions.ts";
import { LEVELS } from "./levels.ts";
import type { OfferBenefit, Rung, Terms } from "./models.ts";

// (floor, ceiling, title prefix) per level. `any` prices as mid: guessing seniority off a role string is
// how a junior gets a principal's band.
const MID: readonly [number, number, string] = [110_000, 150_000, ""];

export const BANDS: Record<string, readonly [number, number, string]> = {
    intern: [45_000, 70_000, "Intern"],
    junior: [85_000, 115_000, "Junior"],
    mid: MID,
    senior: [145_000, 200_000, "Senior"],
    staff: [190_000, 255_000, "Staff"],
    principal: [240_000, 330_000, "Principal"],
    any: MID,
};

export const WEIGHTS = { communication: 0.5, substance: 0.25, accuracy: 0.25 } as const;

// Performance -> what the letter calls it (slug, floor, label). The percentage is the number, this is the
// sentence a candidate reads next to it.
export const TIERS: readonly (readonly [string, number, string])[] = [
    ["below", 0, "Below the bar"],
    ["meets", 40, "Meets the bar"],
    ["strong", 65, "Strong offer"],
    ["top", 85, "Top of the ladder"],
];

export const NOTICE_DAYS = 21;

export const PTO_KEY = "pto";
export const PTO_MIN = 12;
export const PTO_SPAN = 12;

// Ascending by threshold: the order IS the progression the analytics page draws.
export const LADDER: readonly Rung[] = [
    { key: "health", label: "Health insurance", threshold: 20, value: "Medical, dental and vision premiums covered" },
    { key: "retirement", label: "401(k) match", threshold: 30, value: "4% of base, vested immediately" },
    { key: "remote", label: "Remote setup", threshold: 40, value: "$1,500 one-time stipend" },
    { key: "learning", label: "Learning budget", threshold: 50, value: "$2,500 a year for courses, books and conferences" },
    { key: "wellness", label: "Wellness allowance", threshold: 55, value: "$900 a year" },
    { key: "equity_refresh", label: "Annual equity refresh", threshold: 65, value: "A new grant every year, not only at hire" },
    { key: "relocation", label: "Relocation support", threshold: 80, value: "Up to $12,000, or the remote equivalent" },
    { key: "sabbatical", label: "Paid sabbatical", threshold: 92, value: "Four weeks, after three years" },
];

// Python's round() breaks a tie to even and Math.round() breaks it up: on a band boundary (1250/500 = 2.5)
// the two differ by a full step, which is a wrong offer.
export function roundHalfEven(value: number): number {
    const floor = Math.floor(value);
    const rest = value - floor;
    if (rest > 0.5) return floor + 1;
    if (rest < 0.5) return floor;
    return floor % 2 === 0 ? floor : floor + 1;
}

function roundTo(value: number, step: number): number {
    return roundHalfEven(value / step) * step;
}

export function ptoDays(performance: number): number {
    return PTO_MIN + roundHalfEven((PTO_SPAN * performance) / 100);
}

export function benefits(performance: number): OfferBenefit[] {
    const cleared: OfferBenefit[] = [
        { key: PTO_KEY, label: "Paid time off", value: `${ptoDays(performance)} days a year` },
    ];
    for (const rung of LADDER) {
        if (performance >= rung.threshold) {
            cleared.push({ key: rung.key, label: rung.label, value: rung.value });
        }
    }
    return cleared;
}

export function ladder(): [string, string][] {
    return [[PTO_KEY, "Paid time off"], ...LADDER.map((rung): [string, string] => [rung.key, rung.label])];
}

// Object.hasOwn, not `in`: a level named "constructor" is not a band, and a plain dict lookup is what Python did.
export function bandKey(level: string): string {
    return Object.hasOwn(BANDS, level) ? level : "mid";
}

export function bandRange(level: string): readonly [number, number, string] {
    return BANDS[bandKey(level)];
}

export function tier(performance: number): [string, string] {
    let found = TIERS[0];
    for (const candidate of TIERS) {
        if (performance >= candidate[1]) found = candidate;
    }
    return [found[0], found[2]];
}

function axisMean(scores: Record<string, unknown>, axis: string): number | null {
    const dims = DIMENSION_AXES[axis];
    const present: number[] = [];
    for (const [key, value] of Object.entries(scores)) {
        if (dims.includes(key) && typeof value === "number") present.push(value);
    }
    return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0) / present.length;
}

export function performance(scores: Record<string, unknown>, accuracy: number | null): number | null {
    const signals: [number, number][] = [];
    for (const axis of ["communication", "substance"] as const) {
        const mean = axisMean(scores, axis);
        // Off the scale's own floor: the lowest score is no performance, not a tenth of one.
        if (mean !== null) signals.push([WEIGHTS[axis], (Math.min(10, Math.max(1, mean)) - 1) / 9]);
    }
    if (accuracy !== null) signals.push([WEIGHTS.accuracy, Math.min(100, Math.max(0, accuracy)) / 100]);
    if (signals.length === 0) return null;
    const blended = signals.reduce((sum, [weight, value]) => sum + weight * value, 0);
    return roundHalfEven((100 * blended) / signals.reduce((sum, [weight]) => sum + weight, 0));
}

export function title(role: string, level: string): string {
    const prefix = bandRange(level)[2];
    return prefix !== "" && role.toLowerCase().startsWith(prefix.toLowerCase())
        ? role
        : `${prefix} ${role}`.trim();
}

export function terms(
    role: string,
    level: string,
    scores: Record<string, unknown>,
    accuracy: number | null,
): Terms | null {
    const perf = performance(scores, accuracy);
    if (perf === null) return null;
    const [floor, ceiling] = bandRange(level);
    const base = roundTo(floor + ((ceiling - floor) * perf) / 100, 500);
    const equity = perf < 30 ? 0 : roundTo(base * (0.02 + (0.18 * perf) / 100), 1000);
    const signing = perf < 45 ? 0 : roundTo((base * 0.1 * (perf - 45)) / 55, 500);
    return {
        title: title(role, level),
        band: bandKey(level),
        base_salary: base,
        signing_bonus: signing,
        equity,
        performance: perf,
        benefits: benefits(perf),
    };
}

const DAY_MS = 86_400_000;

// Python added the notice to a datetime and read off its calendar date; the only caller passes `created_at`,
// a TIMESTAMPTZ, which arrives as UTC, so the UTC day is that same date.
export function startDate(offered: Date): string {
    return new Date(offered.getTime() + NOTICE_DAYS * DAY_MS).toISOString().slice(0, 10);
}

// AI HERE: the framework-free self-check offer.py ran at import, kept in one place. A level with no band
// would silently price as mid, and a half-up round would land the wrong centavo on a band boundary.
if (Object.keys(BANDS).sort().join() !== [...LEVELS].sort().join()) {
    throw new Error("offer: bands and levels drifted");
}
if (TIERS.some((t, i) => i > 0 && t[1] <= TIERS[i - 1][1])) throw new Error("offer: tiers do not ascend");
if (LADDER.some((r, i) => i > 0 && r.threshold <= LADDER[i - 1].threshold)) {
    throw new Error("offer: ladder does not ascend");
}
if ((Object.keys(WEIGHTS) as string[]).some((k) => k !== "accuracy" && !(k in DIMENSION_AXES))) {
    throw new Error("offer: a weight names no axis");
}
if (Math.abs(WEIGHTS.communication + WEIGHTS.substance + WEIGHTS.accuracy - 1) > 1e-9) {
    throw new Error("offer: weights do not sum to 1");
}
if (
    roundTo(1250, 500) !== 1000 ||
    roundTo(1750, 500) !== 2000 ||
    performance({}, null) !== null ||
    performance({ clarity: "high" }, null) !== null ||
    ptoDays(0) !== PTO_MIN ||
    ptoDays(100) !== PTO_MIN + PTO_SPAN
) {
    throw new Error("offer: rounding, blend or PTO scaling is wrong");
}
