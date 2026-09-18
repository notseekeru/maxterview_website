import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getUsage, type Tier } from "@/lib/api";

// /dashboard?upgrade=pending — the return_url PayMongo sends the customer back to after they pay on Maya.
// The flip is asynchronous (PayMongo posts the webhook, `resolve_tier` reads the DB at read time), so
// this is the "I paid and nothing happened" guard: poll a bounded window, then hand the user a manual
// retry rather than leaving them staring at a Free badge.
//
// On success we do a full `window.location.replace('/dashboard')` instead of patching state: the shell's
// UsageBadge fetches once on mount, and a remount is the only way it, the BillingPage and this notice
// all agree without an event bus. The navigation also strips the query param.
const POLL_MS = 5000;
const POLL_ATTEMPTS = 12; // ~1 minute, then stop and let the user drive

export function UpgradePendingNotice() {
    const [params] = useSearchParams();
    const pending = params.get("upgrade") === "pending";
    const [tier, setTier] = useState<Tier | null>(null);
    const [attempts, setAttempts] = useState(0);

    const check = useCallback(async () => {
        setAttempts((n) => n + 1);
        try {
            setTier((await getUsage()).tier);
        } catch {
            // A failed poll is not worth surfacing: the badge and the manual button still work, and a
            // 401/timeout here says nothing about whether the payment landed.
        }
    }, []);

    useEffect(() => {
        if (!pending || tier === "premium") return;
        void check();
        const tick = setInterval(() => void check(), POLL_MS);
        const stop = setTimeout(() => clearInterval(tick), POLL_MS * POLL_ATTEMPTS);
        return () => {
            clearInterval(tick);
            clearTimeout(stop);
        };
    }, [pending, tier, check]);

    useEffect(() => {
        if (!pending || tier !== "premium") return;
        const go = setTimeout(() => window.location.replace("/dashboard"), 1500);
        return () => clearTimeout(go);
    }, [pending, tier]);

    if (!pending) return null;

    if (tier === "premium") {
        return (
            <div className="flex items-center gap-3 rounded-md border border-dashed p-3 text-sm">
                <Badge>Premium</Badge>
                <span>Payment confirmed — your plan is now Premium. Loading your dashboard…</span>
            </div>
        );
    }

    const givenUp = attempts > POLL_ATTEMPTS;

    return (
        <div className="flex flex-col items-start gap-2 rounded-md border border-dashed p-3 text-sm">
            <div className="flex items-center gap-2">
                <Badge variant="outline">Payment pending</Badge>
                <span className="font-medium">Waiting for Maya to confirm your payment…</span>
            </div>
            <p className="max-w-xl text-muted-foreground">
                {givenUp ? "This is taking longer than usual. If Maya showed a successful payment, it will still land here — no need to pay again. If you cancelled or it failed, you have not been charged." : "This usually takes a few seconds. You will not be charged twice by waiting — do not start another payment."}
            </p>
            <Button size="sm" variant="outline" onClick={() => void check()}>
                Check again
            </Button>
        </div>
    );
}
