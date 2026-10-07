import { useCallback, useEffect, useState } from "react";

import { useQrCheckout } from "@/components/QrCheckout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getUsage, turnsToday, type Usage } from "@/lib/api";
import { clerkEnabled } from "@/lib/config";

// Quota-status badge (GET /usage, MONETIZATION §3).
export function UsageBadge() {
    const [usage, setUsage] = useState<Usage | null>(null);
    const [error, setError] = useState(false);

    const load = useCallback(async () => {
        try {
            setUsage(await getUsage());
            setError(false);
        } catch {
            setError(true);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    if (error) return null;
    if (!usage) return <Badge variant="secondary">…</Badge>;

    const isDev = usage.tier === "dev";
    const tierBadge = usage.tier === "premium" ? <Badge>Pro</Badge> : isDev ? <Badge variant="outline">DEV</Badge> : <Badge variant="outline">Free</Badge>;
    const today = turnsToday(usage);

    return (
        <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
                {!clerkEnabled && !isDev && <Badge className="bg-muted text-muted-foreground">DEV</Badge>}
                {usage.byok && (
                    <Badge variant="secondary" title={`Your own provider key pays for the turns: a higher daily ceiling applies (${today?.limit ?? 0} turns).`}>
                        BYOK
                    </Badge>
                )}
                {tierBadge}
            </div>
            {today && (
                <span className="truncate text-[11px] text-muted-foreground" title={`${today.remaining} of ${today.limit} daily chat turns left. Resets at 00:00 UTC.`}>
                    {today.remaining} of {today.limit} turns left today
                </span>
            )}
        </div>
    );
}

export function UpgradeNotice() {
    const { start, busy, error, modal } = useQrCheckout();
    const [usage, setUsage] = useState<Usage | null>(null);

    useEffect(() => {
        getUsage()
            .then(setUsage)
            .catch(() => {});
    }, []);

    const paid = usage?.tier === "premium" || usage?.tier === "dev";
    const body = !usage ? "Turns come back at 00:00 UTC." : paid ? "Every turn in today's allowance is spent. It comes back at 00:00 UTC." : usage.byok ? "Free runs on a modest ceiling even on your own key. Pro raises it." : "Free runs on a small daily allowance. Pro raises it, and gives you more room for resumes.";

    return (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed bg-muted/50 p-4 text-sm">
            <div className="space-y-1">
                <p className="font-medium">Out of turns for today</p>
                <p className="w-full max-w-sm text-muted-foreground">{body}</p>
            </div>
            <div className="flex items-center gap-3">
                {!paid && (
                    <Button size="sm" onClick={() => void start()} disabled={busy || !usage}>
                        {busy ? "Starting…" : "Upgrade to Pro"}
                    </Button>
                )}
                <a href="/settings/billing" className="text-xs text-muted-foreground underline underline-offset-2">
                    See plans
                </a>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            {modal}
        </div>
    );
}
