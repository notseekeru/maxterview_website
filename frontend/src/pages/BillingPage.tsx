import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Page } from "@/components/PagePrimitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { cancelUpgrade, chatTurns, getUsage, startUpgrade, type Tier, turnsToday, type Usage } from "@/lib/api";
import { clerkEnabled } from "@/lib/config";
import { PLANS } from "@/lib/plans";

// /app/settings/billing. Free vs Premium cards + current-plan summary. The upgrade CTA posts to
// /billing/checkout, which answers with PayMongo's Maya page; PayMongo has no billing portal, so our
// own copy has to carry the billing terms. GET /usage reports which mode is live:
//   `period`       one-time top-up — nothing renews itself, so show the expiry and offer no cancel
//   `subscription` provider-managed recurring — cancel is ours, access runs to the period end
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
    // Period mode pays once for a stretch of time: nothing is scheduled at the provider to cancel, so
    // the card states when the paid time ends instead of offering a cancel that would cancel nothing
    // (backend `cancel_upgrade`).
    const periodMode = usage?.billing_mode === "period";
    const until = usage?.premium_until ? new Date(usage.premium_until).toLocaleDateString() : null;
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
            await cancelUpgrade();
            window.location.reload();
        } catch {
            setCtaError(true);
            setBusy(false);
        }
    };

    const onPremium = usage?.tier === "premium";
    // Paid-through state, shared by both cards: whichever one is not "current" still has to say why
    // the user cannot buy again yet (the backend refuses a second purchase inside a paid period).
    const paidThrough = (
        <Button className="w-full" variant="outline" disabled>
            {until ? `Premium until ${until}` : "Premium active"}
        </Button>
    );
    let cta: ReactNode;
    if (isCurrent && isPremium) {
        cta = periodMode ? (
            paidThrough
        ) : (
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
        // Downgrading means cancelling and there is no portal to hand this off to. In period mode
        // there is no renewal to stop, so the same date replaces the button.
        cta = periodMode ? (
            paidThrough
        ) : (
            <Button className="w-full" variant="outline" onClick={() => void stop()} disabled={busy || !usage}>
                {busy ? "Cancelling…" : "Cancel Premium"}
            </Button>
        );
    } else {
        cta = (
            <Button className="w-full" onClick={() => void go(startUpgrade)} disabled={busy || !usage}>
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
                {/* The one billing term period mode must state: nothing renews. */}
                {isPremium && periodMode && onPremium && <p className="text-xs text-muted-foreground">No auto-renew — premium ends {until ?? "at the end of the period you paid for"}. Buy again when it does.</p>}
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
