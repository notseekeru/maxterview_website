import { SignOutButton } from "@clerk/react";
import { useCallback, useEffect, useState } from "react";
import { Page } from "@/components/PagePrimitives";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { getUsage, openBillingPortal, type Usage } from "@/lib/api";
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

    const isPremium = usage?.tier === "premium";

    return (
        <Page title="Account Settings" description="Your sign-in details and subscription.">
            {/* Plan */}
            <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0">
                    <div>
                        <CardTitle>Plan</CardTitle>
                        <CardDescription className="mt-1">{clerkEnabled ? "Free and Premium metered by daily interviews." : "Dev mode — no Clerk key; runs against the backend DEV_USER."}</CardDescription>
                    </div>
                    <Badge variant={usage?.tier === "premium" ? "default" : "secondary"}>{isPremium ? "Premium" : "Free"}</Badge>
                </CardHeader>
                <CardFooter className="flex flex-row flex-wrap items-center gap-3">
                    {usage && <span className="text-sm text-muted-foreground">Daily interviews left: {usage.daily_interviews_unlimited ? "unlimited" : String(usage.daily_interviews_remaining)}</span>}
                    <Button variant="outline" size="sm" onClick={() => void openBillingPortal()}>
                        Manage billing
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
