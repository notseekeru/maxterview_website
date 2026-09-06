import { SignOutButton } from "@clerk/react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Page } from "@/components/PagePrimitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { chatTurns, getUsage, openBillingPortal, type Usage } from "@/lib/api";
import { clerkEnabled } from "@/lib/config";

// /app/settings/account — single-user account + plan. Rest of "account
// management" (managed accounts) lives under /app/manage/accounts (a place for
// multiple roles/tenants once D4's single-owner scoping is widened — see the
// PRD "Future" notes). Here we show the auth + billing reality we already have.
export function AccountSettingsPage() {
    const [usage, setUsage] = useState<Usage | null>(null);
    const load = useCallback(async () => setUsage(await getUsage()), []);
    useEffect(() => {
        void load().catch(() => setUsage(null));
    }, [load]);

    const tierLabel = usage?.tier === "premium" ? "Premium" : usage?.tier === "dev" ? "Developer (dev)" : "Free";

    return (
        <Page title="Account Settings" description="Your sign-in details and subscription.">
            {/* Plan — summary only; the full tiers + upgrade/portal surface lives on
                /app/settings/billing (see BillingPage). Show what tier the user is on
                and the daily chat-turn credit (all interviews) it grants. */}
            <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0">
                    <div>
                        <CardTitle>Plan</CardTitle>
                        <CardDescription className="mt-1">{usage?.tier === "dev" ? "Dev mode — no Clerk key; runs against the backend DEV_USER." : `You are on ${tierLabel}. ${usage ? `Daily chat turns (all interviews): ${chatTurns(usage)}.` : ""}`}</CardDescription>
                    </div>
                    <Badge variant={usage?.tier === "premium" ? "default" : "secondary"}>{tierLabel}</Badge>
                </CardHeader>
                <CardFooter className="flex flex-row flex-wrap items-center gap-3">
                    {usage?.tier !== "premium" && usage?.tier !== "dev" && (
                        <Button asChild size="sm">
                            <Link to="/app/settings/billing">Upgrade to Premium</Link>
                        </Button>
                    )}
                    {usage?.tier === "premium" && (
                        <Button variant="outline" size="sm" onClick={() => void openBillingPortal()}>
                            Manage billing
                        </Button>
                    )}
                    <Button asChild variant="ghost" size="sm">
                        <Link to="/app/settings/billing">See plans</Link>
                    </Button>
                </CardFooter>
            </Card>

            {/* Profile — the mail/space is owned by Clerk; no backend row drives it. */}
            {/* AI HERE: Clerk holds first/last/email. A bespoke display name isn't in the
                data model; add client-side pref later if needed. Skip: keep zero-touch. */}
            <Card>
                <CardHeader>
                    <CardTitle>Profile</CardTitle>
                    <CardDescription>Manage your sign-in and profile via Clerk.</CardDescription>
                </CardHeader>
                <CardFooter className="flex flex-row items-center gap-3">
                    {clerkEnabled && <SignOutButton>Sign out</SignOutButton>}
                    {!clerkEnabled && <span className="text-sm text-muted-foreground">No session in dev mode.</span>}
                </CardFooter>
            </Card>
        </Page>
    );
}
