import { useUser } from "@clerk/react";
import { Link, useNavigate } from "react-router-dom";

import { CreateInterviewForm } from "@/components/CreateInterviewForm";
import { DashboardStats } from "@/components/DashboardStats";
import { Page } from "@/components/PagePrimitives";
import { UpgradePendingNotice } from "@/components/UpgradePendingNotice";
import { Button } from "@/components/ui/button";
import { type InterviewDims, useDashboardStats, useInterviews } from "@/hooks/useInterviewData";
import { clerkEnabled } from "@/lib/config";

// /dashboard — the shell index. Full width on purpose (Page wide): the stats/chart grid
// needs the horizontal room a 4xl reading column cannot give it.
export function AppHome() {
    const navigate = useNavigate();
    const { loading, dims } = useInterviews();
    const { stats, loading: statsLoading, error: statsError } = useDashboardStats();

    return (
        <Page wide title="Dashboard" heading={<Greeting />} description={statusLine(dims)} actions={<QuickActions />}>
            {/* A redirect rail's return_url lands here (?upgrade=pending); the QR leg never leaves the page. */}
            <UpgradePendingNotice />

            <DashboardStats loading={loading || statsLoading} dims={dims} stats={stats} statsError={statsError} />

            {/* The form lives last on this page and open, not behind the header button it used to be:
                the header is the greeting now, and a collapsed form hid the one action this page is for. */}
            <section id="new-interview" className="scroll-mt-20">
                <CreateInterviewForm onCreated={(id) => navigate(`/interviews/${id}`)} variant="featured" />
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
    const name = user?.firstName ?? user?.fullName;
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

function statusLine(dims: InterviewDims): string {
    if (dims.total === 0) return "No runs yet. Answer a few questions and the review scores every one of them.";
    const parts = [dims.weekRuns === 0 ? "no runs in the last 7 days" : `${dims.weekRuns} run${dims.weekRuns === 1 ? "" : "s"} in the last 7 days`];
    if (dims.rated > 0) parts.push(`${Math.round(dims.avgAccuracy)}% average accuracy`);
    // A streak of one is just "today"; it says nothing until tomorrow.
    if (dims.streak > 1) parts.push(`${dims.streak}-day streak`);
    return parts.join(" · ");
}
