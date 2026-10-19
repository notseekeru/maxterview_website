import { SignOutButton, useUser } from "@clerk/react";
import { Fragment } from "react";
import { Link } from "react-router-dom";

import { LABEL, Page } from "@/components/PagePrimitives";
import { TurnsMeter } from "@/components/TurnsMeter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { StateNote } from "@/components/ui/state";
import { useUsage } from "@/hooks/useUsage";
import { turnsToday, type Usage } from "@/lib/api";
import { clerkEnabled } from "@/lib/config";
import { TIER_NAME } from "@/lib/plans";

export function AccountSettingsPage() {
    const { usage, failed, loading } = useUsage();
    const tierLabel = TIER_NAME[usage?.tier ?? "free"];
    const today = usage ? turnsToday(usage) : null;

    return (
        <Page title="Account" description="Your sign-in details and subscription.">
            <Card>
                <CardHeader className="flex-row items-center justify-between space-y-0">
                    <div>
                        <CardTitle>Plan</CardTitle>
                        <CardDescription className="mt-1">{planLine(usage, failed, loading, tierLabel)}</CardDescription>
                    </div>
                    {usage && <Badge variant={usage.tier === "premium" ? "default" : "secondary"}>{tierLabel}</Badge>}
                </CardHeader>
                {usage && today && (
                    <CardContent className="pb-6">
                        <TurnsMeter usage={usage} />
                    </CardContent>
                )}
                <CardFooter className="flex flex-row flex-wrap items-center gap-3">
                    {usage?.tier !== "premium" && usage?.tier !== "dev" && (
                        <Button asChild size="sm">
                            <Link to="/settings/billing">Upgrade to Pro</Link>
                        </Button>
                    )}
                    {usage?.tier === "premium" && (
                        <Button asChild variant="outline" size="sm">
                            <Link to="/settings/billing">Manage billing</Link>
                        </Button>
                    )}
                    <Button asChild variant="ghost" size="sm">
                        <Link to="/settings/system">Bring your own key</Link>
                    </Button>
                </CardFooter>
            </Card>

            {/* Profile — the name, the mail and the session are Clerk's; no backend row drives them. */}
            <Card>
                <CardHeader>
                    <CardTitle>Profile</CardTitle>
                    <CardDescription>Manage your sign-in and profile via Clerk.</CardDescription>
                </CardHeader>
                {clerkEnabled ? (
                    <CardContent>
                        <ProfileFields />
                    </CardContent>
                ) : (
                    <CardContent>
                        <StateNote>No session in dev mode.</StateNote>
                    </CardContent>
                )}
                {clerkEnabled && (
                    <CardFooter>
                        <SignOutButton>Sign out</SignOutButton>
                    </CardFooter>
                )}
            </Card>
        </Page>
    );
}

function planLine(usage: Usage | null, failed: boolean, loading: boolean, tierLabel: string): string {
    if (loading) return "Loading…";
    if (failed || !usage) return "Couldn’t load your plan. Refresh to retry.";
    if (usage.tier === "dev") return "Dev mode: no Clerk key, so runs bill to the backend DEV_USER.";
    if (usage.byok) return "Your own provider key pays for these turns.";
    return `You are on ${tierLabel}.`;
}

function ProfileFields() {
    const { user } = useUser();
    const rows = [
        { label: "Name", value: user?.fullName ?? user?.firstName ?? "Not set" },
        { label: "Email", value: user?.primaryEmailAddress?.emailAddress ?? "Not set" },
        { label: "Member since", value: user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : "Unknown" },
    ];
    return (
        <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[9rem_1fr]">
            {rows.map((row) => (
                <Fragment key={row.label}>
                    <dt className={LABEL}>{row.label}</dt>
                    <dd className="min-w-0 truncate">{row.value}</dd>
                </Fragment>
            ))}
        </dl>
    );
}
