import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Page } from "@/components/PagePrimitives";
import { useQrCheckout } from "@/components/QrCheckout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { apiDetail, cancelUpgrade, chatTurns, getUsage, turnsToday, type Usage } from "@/lib/api";
import { clerkEnabled } from "@/lib/config";
import { PLANS, TIER_NAME } from "@/lib/plans";

// Free vs Pro cards + current-plan summary. The CTA posts to /billing/checkout, which answers with a QR
// to scan. PayMongo has no billing portal, so our own copy carries the billing terms.
// GET /usage reports the live mode: `period` is a one-time top-up that never renews, so show the expiry
// and offer no cancel; `subscription` is provider-managed and cancel is ours. `dev` gets a read-only
// summary and no upgrade path.
// The tier value stays `premium` (DB column, JWT claim, plan name): Pro is the display name only.

export function BillingPage() {
    // One GET /usage feeds Summary + both PlanCards, so do not hoist it into each.
    const usageState = useUsage();
    return (
        <Page title="Billing & Plan" description="Your plan sets your daily chat turns and how many resumes you can keep.">
            <Summary {...usageState} />
            <div className="grid gap-4 md:grid-cols-2">
                <PlanCard tier="free" usage={usageState.usage} />
                <PlanCard tier="premium" usage={usageState.usage} />
            </div>
            <p className="text-xs text-muted-foreground">Running your own model key replaces the daily cap with a higher ceiling, on any plan (Settings, System).</p>
        </Page>
    );
}

// Figures come from lib/plans (MONETIZATION §0) because the landing page quotes the same numbers. The
// caps are env-overridable server-side, so where the caller's tier is known, GET /usage wins.
// Subscriptions are PHP-only, so the price is in pesos.

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

function Summary({ usage, failed, loading }: { usage: Usage | null; failed: boolean; loading: boolean }) {
    const today = usage ? turnsToday(usage) : null;
    return (
        <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between space-y-0">
                <div className="space-y-1">
                    <CardTitle>Current plan</CardTitle>
                    <CardDescription>Turn allowances are shared across all of your interviews.</CardDescription>
                </div>
                {usage && !failed && !loading && <Badge variant={usage.tier === "premium" ? "default" : "secondary"}>{TIER_NAME[usage.tier]}</Badge>}
            </CardHeader>
            <CardFooter className="text-sm">
                {usage ? (
                    <span className="text-muted-foreground">
                        {usage.byok ? (
                            <>
                                Your own provider key pays for these turns, so <span className="font-medium text-foreground">{chatTurns(usage)}</span> a day is the ceiling instead of your plan cap.
                            </>
                        ) : today ? (
                            <>
                                <span className="font-medium text-foreground">{today.remaining}</span> of {today.limit} turns left today. Resets at 00:00 UTC.
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
    const { start, busy, error: checkoutError, modal } = useQrCheckout();
    const [cancelling, setCancelling] = useState(false);
    // The server's own `detail`, never a generic failure: a refusal read as an outage is how this
    // shipped broken once.
    const [cancelError, setCancelError] = useState<string | null>(null);
    const ctaError = checkoutError ?? cancelError;
    const plan = PLANS[tier];
    const isPremium = tier === "premium";
    const isCurrent = !!usage && usage.tier === tier;
    // Period mode pays once for a stretch of time: nothing is scheduled provider-side to cancel, so
    // the card shows when the paid time ends instead of a button that would cancel nothing.
    const periodMode = usage?.billing_mode === "period";
    const until = usage?.premium_until ? new Date(usage.premium_until).toLocaleDateString() : null;
    // Live caps for the caller's own tier (env can move them); the marketing default only for the
    // tier they are not on, where no live number exists to show.
    const today = isCurrent && usage ? turnsToday(usage) : null;
    const turns = today?.limit ?? plan.turns;
    const resumes = (isCurrent ? usage?.resume_limit : null) ?? plan.resumes;

    // Cancelling is our own endpoint (no provider portal), so confirm first: the user keeps the
    // period they already paid for.
    const stop = async () => {
        if (!window.confirm("Cancel Pro? You keep access until the end of the period you already paid for.")) return;
        setCancelling(true);
        setCancelError(null);
        try {
            await cancelUpgrade();
            window.location.reload();
        } catch (e) {
            setCancelError(apiDetail(e, "Couldn’t cancel just now. Try again in a moment."));
            setCancelling(false);
        }
    };

    const onPremium = usage?.tier === "premium";
    // Shared by both cards: the non-current one still has to say why buying again is not possible yet
    // (the backend refuses a second purchase inside a paid period).
    const paidThrough = (
        <Button className="w-full" variant="outline" disabled>
            {until ? `Pro until ${until}` : "Pro active"}
        </Button>
    );
    let cta: ReactNode;
    if (isCurrent && isPremium) {
        cta = periodMode ? (
            paidThrough
        ) : (
            <Button className="w-full" variant="outline" onClick={() => void stop()} disabled={cancelling || !usage}>
                {cancelling ? "Cancelling…" : "Cancel Pro"}
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
                Dev mode, no upgrade
            </Button>
        );
    } else if (!isPremium && onPremium) {
        // Downgrading means cancelling and there is no portal to hand this off to. In period mode
        // there is no renewal to stop, so the same date replaces the button.
        cta = periodMode ? (
            paidThrough
        ) : (
            <Button className="w-full" variant="outline" onClick={() => void stop()} disabled={cancelling || !usage}>
                {cancelling ? "Cancelling…" : "Cancel Pro"}
            </Button>
        );
    } else {
        cta = (
            <Button className="w-full" onClick={() => void start()} disabled={busy || !usage}>
                {busy ? "Starting…" : "Upgrade to Pro"}
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
                <CardDescription className="text-lg font-semibold text-foreground">
                    {plan.price}
                    {plan.term && <span className="text-sm font-normal text-muted-foreground"> / {plan.term}</span>}
                </CardDescription>
            </CardHeader>
            <CardContent className="flex-1 space-y-2.5 text-sm text-muted-foreground">
                <Feature>
                    <strong>{turns}</strong> chat turns a day
                    {isPremium && <span> · {plan.turns / PLANS.free.turns}x the free plan</span>}
                    {today && <span className="text-foreground"> · {today.remaining} left today</span>}
                </Feature>
                <Feature>
                    <strong>{resumes}</strong> resume {resumes === 1 ? "slot" : "slots"}
                </Feature>
                <Feature>Unlimited interviews, full review and verdict on every run</Feature>
                {isPremium && <Feature>About ₱3.30 a day</Feature>}
            </CardContent>
            <CardFooter className="flex-col items-stretch gap-2 pt-0">
                {cta}
                {/* The one billing term period mode must state: nothing renews. */}
                {isPremium && periodMode && onPremium && <p className="text-xs text-muted-foreground">One payment, no auto-renew. Buy again when it ends.</p>}
                {ctaError && <p className="text-xs text-destructive">{ctaError}</p>}
                {modal}
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
