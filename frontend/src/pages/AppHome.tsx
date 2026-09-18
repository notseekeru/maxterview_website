import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { CreateInterviewForm } from "@/components/CreateInterviewForm";
import { DashboardStats } from "@/components/DashboardStats";
import { InterviewList } from "@/components/InterviewList";
import { Page } from "@/components/PagePrimitives";
import { UpgradePendingNotice } from "@/components/UpgradePendingNotice";
import { Button } from "@/components/ui/button";
import { useDashboardStats, useInterviews } from "@/hooks/useInterviewData";
import { archiveInterview, deleteInterview, regenerateFeedback, unarchiveInterview } from "@/lib/api";
import { clerkEnabled } from "@/lib/config";

// /app (dashboard) — the shell index. Full width on purpose (Page wide): the stats/chart grid
// needs the horizontal room a 4xl reading column cannot give it.
export function AppHome() {
    const navigate = useNavigate();
    const { interviews, loading, error, refresh, dims } = useInterviews();
    const { stats, loading: statsLoading, error: statsError } = useDashboardStats();
    const [formOpen, setFormOpen] = useState(false);
    const [formTouched, setFormTouched] = useState(false);
    const showForm = formTouched ? formOpen : !loading && dims.total === 0;

    async function onCreated(id: string) {
        navigate(`/interviews/${id}`);
    }

    async function onDelete(id: string) {
        await deleteInterview(id);
        await refresh();
    }

    async function onArchive(id: string, archived: boolean) {
        await (archived ? archiveInterview(id) : unarchiveInterview(id));
        await refresh();
    }

    async function onRescore(id: string) {
        await regenerateFeedback(id);
        await refresh();
    }

    return (
        <Page
            wide
            title="Dashboard"
            description="Start a new session or review how you're doing."
            actions={
                <Button
                    variant={showForm ? "outline" : "default"}
                    onClick={() => {
                        setFormTouched(true);
                        setFormOpen(!showForm);
                    }}
                >
                    {showForm ? "Close" : "New interview"}
                </Button>
            }
        >
            {!clerkEnabled && <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">Dev mode (no Clerk key) — requests run against the backend&apos;s DEV_USER. Set VITE_CLERK_PUBLISHABLE_KEY to enable real Clerk auth.</p>}

            {/* The Maya return_url lands here (?upgrade=pending); it renders nothing otherwise. */}
            <UpgradePendingNotice />

            {showForm && <CreateInterviewForm onCreated={onCreated} variant="featured" />}

            <DashboardStats loading={loading || statsLoading} dims={dims} stats={stats} statsError={statsError} />

            <section className="space-y-2">
                <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">History</h2>
                <InterviewList interviews={interviews} loading={loading} error={error} onRefresh={() => void refresh()} onOpen={(id) => navigate(`/interviews/${id}`)} onDelete={onDelete} onArchive={onArchive} onRescore={onRescore} />
            </section>
        </Page>
    );
}
