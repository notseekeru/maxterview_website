import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Page } from "@/components/PagePrimitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { chatTurns, createCheckoutSession, getUsage, openBillingPortal, type Tier, type Usage } from "@/lib/api";
import { clerkEnabled } from "@/lib/config";

// /app/settings/billing. Free vs Premium cards + current-plan summary. The upgrade
// CTA posts to /billing/checkout (Stripe hosted); Premium gets Stripe portal mgmt.
// `dev` (no-Clerk-only) gets a read-only summary and no upgrade path.

export function BillingPage() {
    // One GET /usage feeds Summary + both PlanCards — do not hoist into each.
    const usageState = useUsage();
    return (
        <Page title="Billing & Plan" description="Your plan gates your daily chat-turn credits (all interviews). Compare tiers and manage your subscription.">
            <Summary {...usageState} />
            <div className="grid gap-4 md:grid-cols-2">
                <PlanCard tier="free" usage={usageState.usage} />
                <PlanCard tier="premium" usage={usageState.usage} />
            </div>
        </Page>
    );
}

// Free/premium figures from MONETIZATION §0 (env-overridable server-side:
// FREE_CHAT_TURNS=10 / PREMIUM_CHAT_TURNS=250). `dev` (500) isn't marketed.
export const PLANS: Record<"free" | "premium", { name: string; monthly: string; turns: number }> = {
    free: { name: "Free", monthly: "$0", turns: 10 },
    premium: { name: "Premium", monthly: "$9.99/mo", turns: 250 },
};

// --- shared data hook ---

function useUsage() {
    const [usage, setUsage] = useState<Usage | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let alive = true;
        getUsage()
            .then((u) => alive && setUsage(u))
            .catch(() => alive && setFailed(true));
        return () => {
            alive = false;
        };
    }, []);
    return { usage, failed, loading: !usage && !failed };
}

const TIER_NAME: Record<Tier, string> = { free: "Free", premium: "Premium", dev: "Developer (dev)" };

function Summary({ usage, failed, loading }: { usage: Usage | null; failed: boolean; loading: boolean }) {
    return (
        <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between space-y-0">
                <div className="space-y-1">
                    <CardTitle>Current plan</CardTitle>
                    <CardDescription>Resolved from your Clerk JWT merged with any active subscription.</CardDescription>
                </div>
                {usage && !failed && !loading && <Badge variant={usage.tier === "premium" ? "default" : "secondary"}>{TIER_NAME[usage.tier]}</Badge>}
            </CardHeader>
            <CardFooter className="text-sm">
                {usage ? (
                    <span className="text-muted-foreground">
                        Daily chat turns (all interviews): <span className="font-medium text-foreground">{chatTurns(usage)}</span>
                    </span>
                ) : failed ? (
                    <span className="text-destructive">Couldn’t load your plan. Refresh to retry.</span>
                ) : (
                    <span className="text-muted-foreground">Loading…</span>
                )}
            </CardFooter>
        </Card>
    );
}

function PlanCard({ tier, usage }: { tier: "free" | "premium"; usage: Usage | null }) {
    const [busy, setBusy] = useState(false);
    const [ctaError, setCtaError] = useState(false);
    const plan = PLANS[tier];
    const isPremium = tier === "premium";
    const isCurrent = !!usage && usage.tier === tier;

    // Stripe-hosted checkout/portal URLs must actually be followed.
    const go = async (open: () => Promise<string>) => {
        setBusy(true);
        setCtaError(false);
        try {
            window.location.assign(await open());
        } catch {
            setCtaError(true);
            setBusy(false);
        }
    };

    let cta: ReactNode;
    if (isCurrent) {
        cta = isPremium ? (
            <Button className="w-full" variant="outline" onClick={() => void go(openBillingPortal)} disabled={busy || !usage}>
                {busy ? "Opening…" : "Manage billing (Stripe)"}
            </Button>
        ) : (
            <Button className="w-full" disabled>
                Your current plan
            </Button>
        );
    } else if (!clerkEnabled) {
        cta = (
            <Button className="w-full" disabled>
                Dev mode — no upgrade
            </Button>
        );
    } else {
        cta = (
            <Button className="w-full" onClick={() => void go(createCheckoutSession)} disabled={busy || !usage}>
                {busy ? "Opening Stripe…" : isPremium ? `Upgrade · ${plan.monthly}` : "Switch to Free"}
            </Button>
        );
    }

    return (
        <Card className="flex flex-col">
            <CardHeader>
                <div className="flex items-center justify-between gap-2">
                    <CardTitle>{plan.name}</CardTitle>
                    {isCurrent && <Badge variant={isPremium ? "default" : "secondary"}>Your plan</Badge>}
                </div>
                <CardDescription className="text-lg font-semibold text-foreground">{plan.monthly}</CardDescription>
            </CardHeader>
            <CardContent className="flex-1 space-y-2.5 text-sm text-muted-foreground">
                <Feature>
                    <strong>{plan.turns}</strong> chat turns allowed per day
                </Feature>
                <Feature>Unlimited interviews — no daily cap</Feature>
                <Feature>{isPremium ? "Priority on the interviewer model + bigger scope" : "Free model keeps quality for everyday practice"}</Feature>
                <Feature>Full feedback &amp; dimension scoring on every run</Feature>
            </CardContent>
            <CardFooter className="flex-col items-stretch gap-2 pt-0">
                {cta}
                {ctaError && <p className="text-xs text-destructive">Payment is unavailable right now. Try again in a moment.</p>}
            </CardFooter>
        </Card>
    );
}

function Feature({ children }: { children: ReactNode }) {
    return (
        <div className="flex items-start gap-2">
            <span aria-hidden="true" className="mt-0.5">
                •
            </span>
            <span>{children}</span>
        </div>
    );
}
