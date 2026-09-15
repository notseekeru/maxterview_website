import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Page } from "@/components/PagePrimitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cancelSubscription, chatTurns, getUsage, startSubscription, type Tier, turnsToday, type Usage } from "@/lib/api";
import { clerkEnabled } from "@/lib/config";
import { PLANS } from "@/lib/plans";

// /app/settings/billing. Free vs Premium cards + current-plan summary. The upgrade CTA posts to
// /billing/checkout, which answers with PayMongo's Maya page for the first payment; PayMongo has no
// billing portal, so Premium cancels in-app and keeps access to the end of the paid period.
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

// Free/premium figures come from lib/plans (MONETIZATION §0) because the landing page quotes the
// same numbers. Turn caps are env-overridable server-side, so wherever the caller's own tier is
// known the LIVE number from GET /usage wins over the marketing default.
// PayMongo subscriptions are PHP-only, so the price is stated in pesos (app/billing plans are
// created with amount=49900).

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
                        {usage.byok ? (
                            "Your own provider key pays for the turns, so the daily chat-turn limit does not apply."
                        ) : turnsToday(usage) ? (
                            <>
                                <span className="font-medium text-foreground">{turnsToday(usage)?.remaining}</span> of {turnsToday(usage)?.limit} daily chat turns left, across all interviews. Resets at 00:00 UTC.
                            </>
                        ) : (
                            <>
                                Daily chat turns (all interviews): <span className="font-medium text-foreground">{chatTurns(usage)}</span>
                            </>
                        )}
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
    // Live cap for the caller's own tier (env can move it); the marketing default only for the
    // tier they are not on, where no live number exists to show.
    const today = isCurrent && usage ? turnsToday(usage) : null;

    // PayMongo's Maya page is a real redirect we must follow.
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

    // Cancelling is our own endpoint (no provider portal), so confirm first: the user keeps the
    // period they already paid for.
    const stop = async () => {
        if (!window.confirm("Cancel Premium? You keep access until the end of the period you already paid for.")) return;
        setBusy(true);
        setCtaError(false);
        try {
            await cancelSubscription();
            window.location.reload();
        } catch {
            setCtaError(true);
            setBusy(false);
        }
    };

    const onPremium = usage?.tier === "premium";
    let cta: ReactNode;
    if (isCurrent && isPremium) {
        cta = (
            <Button className="w-full" variant="outline" onClick={() => void stop()} disabled={busy || !usage}>
                {busy ? "Cancelling…" : "Cancel subscription"}
            </Button>
        );
    } else if (isCurrent) {
        cta = (
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
    } else if (!isPremium && onPremium) {
        // Downgrading means cancelling: there is no portal to hand this off to.
        cta = (
            <Button className="w-full" variant="outline" onClick={() => void stop()} disabled={busy || !usage}>
                {busy ? "Cancelling…" : "Cancel Premium"}
            </Button>
        );
    } else {
        cta = (
            <Button className="w-full" onClick={() => void go(startSubscription)} disabled={busy || !usage}>
                {busy ? "Opening Maya…" : `Upgrade · ${plan.monthly}`}
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
                    <strong>{today?.limit ?? plan.turns}</strong> chat turns allowed per day
                    {today && <span className="text-foreground"> · {today.remaining} left today</span>}
                </Feature>
                <Feature>Unlimited interviews — no daily cap</Feature>
                <Feature>{isPremium ? "Priority on the interviewer model + bigger scope" : "Free model keeps quality for everyday practice"}</Feature>
                <Feature>Full answer-by-answer review on every run</Feature>
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
