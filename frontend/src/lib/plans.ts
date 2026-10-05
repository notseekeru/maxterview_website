import type { Tier } from "@/lib/api";

// Marketing defaults only (MONETIZATION §0). The caps are env-overridable server-side, so wherever
// the caller's own tier is known the live numbers from GET /usage win over these (`resume_limit`).
export const PLANS = {
    free: { name: "Free", price: "₱0", term: "", turns: 10, resumes: 1, audience: "For practising on your own, no card required." },
    premium: { name: "Pro", price: "₱99", term: "30 days", turns: 100, resumes: 5, audience: "For the month before a real loop." },
} as const;

/** Display name per tier, `dev` included: only reachable in no-Clerk mode. */
export const TIER_NAME: Record<Tier, string> = { free: "Free", premium: "Pro", dev: "Developer (dev)" };
