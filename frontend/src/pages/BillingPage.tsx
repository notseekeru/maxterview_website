import type { ReactNode } from "react";
import { useState } from "react";
import { Page } from "@/components/PagePrimitives";
import { PlanPitch } from "@/components/PlanPitch";
import { useQrCheckout } from "@/components/QrCheckout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useUsage } from "@/hooks/useUsage";
import { apiDetail, cancelUpgrade, type Usage } from "@/lib/api";
import { clerkEnabled } from "@/lib/config";
import { PLANS } from "@/lib/plans";

// Free vs Pro cards. The CTA posts to /billing/checkout, which answers with a QR to scan. PayMongo has no
// billing portal, so our own copy carries the billing terms.
// The cards sell; PlanPitch inside them carries the prices and the feature lists.
// the two tiers and nothing else. What the caller is on only decides which CTA a card shows.
// GET /usage reports the live mode: `period` is a one-time top-up that never renews, so show the expiry
// and offer no cancel; `subscription` is provider-managed and cancel is ours. `dev` gets a read-only
// summary and no upgrade path.
// The tier value stays `premium` (DB column, JWT claim, plan name): Pro is the display name only.

export function BillingPage() {
    // One GET /usage feeds both PlanCards, so do not hoist it into each.
    const { usage } = useUsage();
    return (
        <Page title="Billing" description="Your plan sets your daily allowance and your resume library.">
            <div className="grid gap-4 md:grid-cols-2">
                <PlanCard tier="free" usage={usage} />
                <PlanCard tier="premium" usage={usage} />
            </div>
        </Page>
    );
}

// Figures come from lib/plans (MONETIZATION §0): the docs page quotes the numbers, the pitch does not.
// Subscriptions are PHP-only, so the price is in pesos.
// Ratio across every metered cap (turns, resumes, redos); read from turns rather than typed again.
const PLAN_RATIO = PLANS.premium.turns / PLANS.free.turns;

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
                    <CardTitle className="flex flex-1 items-center justify-between gap-2">
                        {plan.name}
                        {isPremium && <p className="text-md">{PLAN_RATIO}x</p>}
                    </CardTitle>
                </div>
            </CardHeader>
            <CardContent className="flex-1 pb-6">
                <PlanPitch tier={tier} />
            </CardContent>
            <CardFooter className="flex-col items-stretch gap-2 pt-0">
                {cta}
                {isPremium && periodMode && onPremium && <p className="text-xs text-muted-foreground">One payment, no auto-renew. Buy again when it ends.</p>}
                {ctaError && <p className="text-xs text-destructive">{ctaError}</p>}
                {modal}
            </CardFooter>
        </Card>
    );
}
