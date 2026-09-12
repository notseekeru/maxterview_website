import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getUsage, startSubscription, type Usage } from "@/lib/api";
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

    // `dev` is only reachable in no-Clerk mode (resolve_tier grants it solely to the
    // DEV_USER identity).
    const isDev = usage.tier === "dev";
    const tierBadge = usage.tier === "premium" ? <Badge>Premium</Badge> : isDev ? <Badge variant="outline">DEV</Badge> : <Badge variant="outline">Free</Badge>;

    return (
        <div className="flex items-center gap-2">
            {!clerkEnabled && !isDev && <Badge className="bg-muted text-muted-foreground">DEV</Badge>}
            {/* BYOK: turns run on the user's own provider account, so the daily cap is not enforced. */}
            {usage.byok && (
                <Badge variant="secondary" title="Your own provider key pays for the turns; the daily chat-turn limit does not apply.">
                    BYOK
                </Badge>
            )}
            {tierBadge}
        </div>
    );
}

// Lockout / upsell notice with an "Upgrade" CTA when quota is exhausted.
export function UpgradeNotice({ reason }: { reason: string }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(false);

    async function upgrade() {
        setBusy(true);
        setError(false);
        try {
            const url = await startSubscription();
            window.location.assign(url);
        } catch {
            setError(true);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed bg-muted/50 p-4 text-sm">
            <div className="space-y-1">
                <p className="font-medium">Free limit reached</p>
                <p className="w-full max-w-sm text-muted-foreground">You can’t start another interview or send more turns right now. This round {reason}. Upgrade to premium for unlimited interviews and chats.</p>
            </div>
            <div className="flex items-center gap-3">
                <Button size="sm" onClick={() => void upgrade()} disabled={busy}>
                    {busy ? "Opening Maya…" : "Upgrade to Premium"}
                </Button>
                {/* No provider portal exists; plan management (incl. cancel) lives on the billing page. */}
                <a href="/app/settings/billing" className="text-xs text-muted-foreground underline underline-offset-2">
                    Manage billing
                </a>
            </div>
            {error && <p className="text-xs text-destructive">Payment is unavailable right now. Try again in a moment.</p>}
        </div>
    );
}
