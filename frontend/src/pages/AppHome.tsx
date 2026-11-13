import { useUser } from "@clerk/react";
import { Link, useNavigate } from "react-router-dom";

import { CreateInterviewForm } from "@/components/CreateInterviewForm";
import { DashboardStats } from "@/components/DashboardStats";
import { Page } from "@/components/PagePrimitives";
import { UpgradePendingNotice } from "@/components/UpgradePendingNotice";
import { Button } from "@/components/ui/button";
import { useDashboard } from "@/hooks/useInterviewData";
import { clerkEnabled } from "@/lib/config";

export function AppHome() {
    const navigate = useNavigate();
    const { loading, dims, stats, error } = useDashboard();

    return (
        <Page wide title="Dashboard" heading={<Greeting />} actions={<QuickActions />}>
            <UpgradePendingNotice />

            <DashboardStats loading={loading} dims={dims} stats={stats} statsError={error} />

            <section id="new-interview" className="scroll-mt-20">
                <CreateInterviewForm onCreated={(id) => navigate(`/interviews/${id}`)} />
            </section>
        </Page>
    );
}

function greeting(hour: number): string {
    if (hour < 5) return "Working late";
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
}

function Greeting() {
    const part = greeting(new Date().getHours());
    // clerkEnabled gates the PROVIDER, and useUser throws without one, so the hook needs its own
    // component rather than a conditional call here.
    return clerkEnabled ? <GreetingName part={part} /> : `${part}.`;
}

function GreetingName({ part }: { part: string }) {
    const { user } = useUser();
    const name = user?.firstName ?? user?.fullName ?? user?.username ?? user?.primaryEmailAddress?.emailAddress.split("@")[0];
    return <>{`${part}${name ? `, ${name}` : ""}.`}</>;
}

function QuickActions() {
    return (
        <>
            <Button asChild>
                <a href="#new-interview">New interview</a>
            </Button>
            <Button variant="outline" asChild>
                <Link to="/resume">Resume</Link>
            </Button>
            <Button variant="ghost" asChild>
                <Link to="/analytics">Analytics</Link>
            </Button>
        </>
    );
}
