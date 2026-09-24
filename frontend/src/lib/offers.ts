import type { Offer } from "./api";

/** USD, no cents: an offer is spoken in whole dollars, and the letter is a document, not a quote.
 *  `$176,203`. */
export const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/** For axes and band edges: `$176k`. The exact figure belongs in the tooltip or the table. */
export const compactMoney = (n: number) => (Math.abs(n) >= 1000 ? `$${Math.round(n / 1000)}k` : money(n));

/** Signed percentage against the average base, or null when there is no average to compare with. */
export function vsAverage(offer: Offer, avgBase: number): number | null {
    return avgBase > 0 ? Math.round((100 * (offer.base_salary - avgBase)) / avgBase) : null;
}

/** How far up its own level's band the money landed, 0-100. Computed from the stored numbers rather
 *  than read off `performance`: rounding the base to a round salary is what separates the two, and the
 *  letter is about where the money sits. */
export function bandPosition(offer: Offer): number {
    const span = offer.band_high - offer.band_low;
    return span <= 0 ? 100 : Math.max(0, Math.min(100, Math.round((100 * (offer.base_salary - offer.band_low)) / span)));
}

// Tone per backend tier slug (app/offer.py owns the slugs and the labels; this owns only the colour).
// Literal classes, not a computed `bg-[var(--chart-${n})]`: Tailwind only extracts names it can see.
const TIER_TONES: Record<string, string> = {
    below: "border-muted-foreground/40 text-muted-foreground",
    meets: "border-[var(--chart-3)] text-[var(--chart-3)]",
    strong: "border-[var(--chart-2)] text-[var(--chart-2)]",
    top: "border-[var(--chart-1)] text-[var(--chart-1)]",
};

export const tierTone = (tier: string) => TIER_TONES[tier] ?? TIER_TONES.meets;

/** SVG fills for the tier bars the band chart draws: a chart needs a colour token, not a class
 *  (Tailwind cannot see a computed `bg-[var(--chart-${n})]`). Same scale as the tier chip. */
const TIER_FILLS: Record<string, string> = {
    below: "var(--muted-foreground)",
    meets: "var(--chart-3)",
    strong: "var(--chart-2)",
    top: "var(--chart-1)",
};

export const tierFill = (tier: string) => TIER_FILLS[tier] ?? TIER_FILLS.meets;
