import { createHash } from "node:crypto";
import { LEVELS, type Level } from "./levels.ts";

// The bars a resume is actually screened against, cheapest first. `any` is a dial, not a bar.
export const RUNGS = LEVELS.slice(1);

export const CALLS = ["fails", "close", "passes"] as const;
export const SECTION_CALLS = ["bloat", "weak", "fine", "strong"] as const;
export const LINE_CALLS = ["weak", "safe", "strong"] as const;

export type Call = (typeof CALLS)[number];
export type SectionCall = (typeof SECTION_CALLS)[number];
export type LineCall = (typeof LINE_CALLS)[number];

export const MAX_SECTIONS = 6;
export const MAX_REWRITES = 3;
// Every line is output the model has to write, and the review's token budget has to hold the ladder,
// the sections and the rewrites too. Past this a long resume truncates and the whole review 503s.
export const MAX_LINES = 24;
export const NAME_MAX = 40;
export const FIELD_MAX = 300;
export const LINE_MAX = 400;
export const VERDICT_MAX = 1200;

const RUNG_RANK = new Map<string, number>(RUNGS.map((rung, index) => [rung, index]));
// Worst to best: the index IS the rank `staircase` clamps with.
const CALL_RANK = new Map<string, number>(CALLS.map((call, index) => [call, index]));

function rank(ranks: Map<string, number>, key: string): number {
    const found = ranks.get(key);
    if (found === undefined) throw new Error(`review: unknown vocabulary value ${key}`);
    return found;
}

export function sourceHash(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

export function slug(value: unknown): string | null {
    if (typeof value !== "string") return null;
    return value.trim().toLowerCase().replace(/[\s-]+/g, "_") || null;
}

// The schema enum already carries the slugs; this is the weak-backend path, where a model answers
// with the label it was shown ("Mid-level") instead of the id.
export function rung(value: unknown): Level | null {
    const got = slug(value);
    if (got === null) return null;
    const exact = RUNGS.find((each) => each === got);
    return exact ?? RUNGS.find((each) => got.startsWith(each)) ?? null;
}

export function claim(value: unknown, limit = FIELD_MAX): string {
    // The prompt asks for one line; the server flattens it anyway, or the model's own newlines land in
    // the card as literal markup.
    return typeof value === "string" ? value.split(/\s+/).filter(Boolean).join(" ").slice(0, limit) : "";
}

// A resume that fails a band cannot clear the band above it, so a model that grades it higher is
// contradicting itself: the lower read wins and the clamp is reported.
export function staircase(calls: Iterable<readonly [string, string]>): [[Level, Call][], boolean] {
    let ceiling = CALLS.length - 1;
    let clamped = false;
    const out: [Level, Call][] = [];
    const ordered = [...calls].sort((left, right) => rank(RUNG_RANK, left[0]) - rank(RUNG_RANK, right[0]));
    for (const [rung, call] of ordered) {
        const given = rank(CALL_RANK, call);
        const limited = Math.min(given, ceiling);
        clamped ||= limited !== given;
        ceiling = limited;
        out.push([rung as Level, CALLS[limited]]);
    }
    return [out, clamped];
}

export function readsAt(calls: Iterable<readonly [string, string]>): Level | null {
    let best: Level | null = null;
    for (const [rung, call] of calls) {
        if (call === "passes" && (best === null || rank(RUNG_RANK, rung) > rank(RUNG_RANK, best))) best = rung as Level;
    }
    return best;
}

// AI HERE: the framework-free self-check review.py ran at import, kept in one place. A clamp that stops
// clamping renders "senior: fails" above "staff: passes", the one contradiction the ladder exists to prevent.
const climb = staircase([
    ["mid", "passes"],
    ["senior", "fails"],
    ["staff", "passes"],
]);
if (JSON.stringify(climb) !== JSON.stringify([[["mid", "passes"], ["senior", "fails"], ["staff", "fails"]], true])) {
    throw new Error("review: staircase does not clamp");
}
if (readsAt([["junior", "passes"], ["senior", "fails"]]) !== "junior" || readsAt([["junior", "fails"]]) !== null || rung(" Mid-level ") !== "mid" || claim(" a\n\n b ") !== "a b") {
    throw new Error("review: ladder or slug lookup is wrong");
}
if ((RUNGS as readonly string[]).includes("any")) throw new Error("review: the ladder grades bars, not dials");
