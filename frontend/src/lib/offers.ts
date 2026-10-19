import type { Offer, OfferMonth } from "./api";

export const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

export const compactMoney = (n: number) => (Math.abs(n) >= 1000 ? `$${Math.round(n / 1000)}k` : money(n));

export const signedMoney = (n: number) => `${n < 0 ? "-" : "+"}${money(Math.abs(n))}`;

export const deltaTone = (n: number) => (n > 0 ? "text-success" : n < 0 ? "text-destructive" : "text-muted-foreground");

export function baseDelta(activity: OfferMonth[]): { amount: number; month: string } | null {
    if (activity.length < 2) return null;
    const [before, last] = activity.slice(-2);
    return { amount: last.avg_base - before.avg_base, month: before.month };
}

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

const TIER_FILLS: Record<string, string> = {
    below: "var(--muted-foreground)",
    meets: "var(--chart-3)",
    strong: "var(--chart-2)",
    top: "var(--chart-1)",
};

export const tierFill = (tier: string) => TIER_FILLS[tier] ?? TIER_FILLS.meets;
