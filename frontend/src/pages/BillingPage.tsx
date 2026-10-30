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

export function BillingPage() {
    const { usage } = useUsage();
    return (
        <Page title="Billing">
            <div className="grid gap-4 md:grid-cols-2">
                <PlanCard tier="free" usage={usage} />
                <PlanCard tier="premium" usage={usage} />
            </div>
        </Page>
    );
}

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
                {ctaError && <p className="text-xs text-destructive">{ctaError}</p>}
                {modal}
            </CardFooter>
        </Card>
    );
}
