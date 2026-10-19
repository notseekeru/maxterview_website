import type { Tier } from "@/lib/api";

// The ONLY place the caps are stated, and it is read by the docs page (MONETIZATION §0 owns them).
// The caps are env-overridable server-side, so these can drift from what a deployment serves: nothing
// that gates or meters a request reads them. The BYOK ceilings are deliberately absent: the live meter
// reads the caller's own from GET /usage.
export const PLANS = {
    free: { name: "Free", price: "₱0", term: "", turns: 10, resumes: 1, redos: 1, audience: "For practising on your own, no card required." },
    premium: { name: "Pro", price: "₱99", term: "30 days", turns: 100, resumes: 10, redos: 10, audience: "For the month before a real loop." },
} as const;

export const TIER_NAME: Record<Tier, string> = { free: "Free", premium: "Pro", dev: "Developer (dev)" };
