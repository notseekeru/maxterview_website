import { useCallback, useEffect, useState } from "react";

import { useQrCheckout } from "@/components/QrCheckout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getUsage, turnsToday, type Usage } from "@/lib/api";
import { clerkEnabled } from "@/lib/config";
import { PLANS } from "@/lib/plans";

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

    // `dev` is only reachable in no-Clerk mode (resolve_tier grants it solely to the
    // DEV_USER identity).
    const isDev = usage.tier === "dev";
    const tierBadge = usage.tier === "premium" ? <Badge>Pro</Badge> : isDev ? <Badge variant="outline">DEV</Badge> : <Badge variant="outline">Free</Badge>;
    // The cap is a hard gate (402 mid-interview, no warning), so the remaining count belongs in
    // the shell rather than only on the billing page.
    const today = turnsToday(usage);

    return (
        <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
                {!clerkEnabled && !isDev && <Badge className="bg-muted text-muted-foreground">DEV</Badge>}
                {/* BYOK: the turns run on the user's own provider account, so the tier cap is swapped
                    for the higher (still finite) BYOK ceiling the server reports above. */}
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

// Lockout notice for a 402 on the daily turn cap. Tier-aware on purpose: "Free limit reached, upgrade"
// is a lie to someone who already paid, so the copy resolves the caller's own tier first.
export function UpgradeNotice() {
    const { start, busy, error, modal } = useQrCheckout();
    const [usage, setUsage] = useState<Usage | null>(null);

    useEffect(() => {
        getUsage()
            .then(setUsage)
            .catch(() => {});
    }, []);

    // A saved key outranks the tier on the provider-paid ceiling, but only free has Pro above it, so
    // the upsell decision belongs to the TIER and not to `byok`.
    const paid = usage?.tier === "premium" || usage?.tier === "dev";
    const body = !usage
        ? "Turns come back at 00:00 UTC."
        : paid
          ? "Every turn in today's allowance is spent. It comes back at 00:00 UTC."
          : usage.byok
            ? `Free gives you ${PLANS.free.byokTurns} turns a day on your own provider key. Pro gives you ${PLANS.premium.byokTurns}.`
            : `Free gives you ${PLANS.free.turns} turns a day. Pro gives you ${PLANS.premium.turns}, plus ${PLANS.premium.resumes} resume slots.`;

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
                {/* No provider portal exists; plan management (incl. cancel) lives on the billing page. */}
                <a href="/settings/billing" className="text-xs text-muted-foreground underline underline-offset-2">
                    See plans
                </a>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            {modal}
        </div>
    );
}
