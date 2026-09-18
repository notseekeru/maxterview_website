export const PLANS = {
    free: { name: "Free", monthly: "₱0", turns: 30, pitch: "Practice every day on the free model." },
    premium: { name: "Premium", monthly: "₱499/mo", turns: 250, pitch: "A larger daily allowance on the bigger model." },
} as const;

export type PlanId = keyof typeof PLANS;
