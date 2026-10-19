import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getUsage, type Tier } from "@/lib/api";

const POLL_MS = 5000;
const POLL_ATTEMPTS = 12; // ~1 minute, then stop and let the user drive
const COOLDOWN_MS = 1000; // floor between checks, poll or click

export function UpgradePendingNotice() {
    const [params] = useSearchParams();
    const pending = params.get("upgrade") === "pending";
    const [tier, setTier] = useState<Tier | null>(null);
    const [attempts, setAttempts] = useState(0);
    const [cooling, setCooling] = useState(false);
    const last = useRef(0);

    const check = useCallback(async () => {
        // One rate-limit bucket per client for the whole API, not per route: unchecked clicking spends
        // the chat's budget and 429s the user's own session. A ref, not state: two clicks in one tick
        // would read the same render.
        if (Date.now() - last.current < COOLDOWN_MS) return;
        last.current = Date.now();
        setCooling(true);
        setTimeout(() => setCooling(false), COOLDOWN_MS);
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
        // Only the poll advances `attempts`: the give-up copy is a claim about elapsed time, and a
        // customer who clicked the button 13 times has waited zero seconds.
        const tick = setInterval(() => {
            setAttempts((n) => n + 1);
            void check();
        }, POLL_MS);
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
                <Badge>Pro</Badge>
                <span>Payment confirmed. Your plan is now Pro. Loading your dashboard…</span>
            </div>
        );
    }

    const givenUp = attempts >= POLL_ATTEMPTS;

    return (
        <div className="flex flex-col items-start gap-2 rounded-md border border-dashed p-3 text-sm">
            <div className="flex items-center gap-2">
                <Badge variant="outline">Payment pending</Badge>
                <span className="font-medium">Waiting for PayMongo to confirm your payment…</span>
            </div>
            <p className="max-w-xl text-muted-foreground">
                {givenUp
                    ? "This is taking longer than usual. If the provider showed a successful payment, it will still land here, so there is no need to pay again. If you cancelled or it failed, you have not been charged."
                    : "This usually takes a few seconds. Waiting will not charge you twice, so do not start another payment."}
            </p>
            <Button size="sm" variant="outline" onClick={() => void check()} disabled={cooling}>
                Check again
            </Button>
        </div>
    );
}
