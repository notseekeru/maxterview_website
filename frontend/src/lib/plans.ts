// Marketed plans — the ONE place the public numbers live, so the landing page and the billing
// page cannot disagree about what Premium costs.
//
// These are display defaults from MONETIZATION §2. The server caps are env-overridable
// (FREE_CHAT_TURNS / PREMIUM_CHAT_TURNS) and GET /usage reports the caller's OWN tier, so any
// surface that can see a live number must show that one instead (see BillingPage).
export const PLANS = {
    free: { name: "Free", monthly: "₱0", turns: 30, pitch: "Practice every day on the free model." },
    premium: { name: "Premium", monthly: "₱499/mo", turns: 250, pitch: "A larger daily allowance on the bigger model." },
} as const;

export type PlanId = keyof typeof PLANS;
