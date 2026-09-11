import { useNavigate } from "react-router-dom";

import { CreateInterviewForm } from "@/components/CreateInterviewForm";
import { DashboardStats } from "@/components/DashboardStats";
import { InterviewList } from "@/components/InterviewList";
import { Page } from "@/components/PagePrimitives";
import { useInterviewData } from "@/hooks/useInterviewData";
import { deleteInterview, regenerateFeedback } from "@/lib/api";
import { clerkEnabled } from "@/lib/config";

// /app (dashboard) — the shell index.
export function AppHome() {
    const navigate = useNavigate();
    const { interviews, feedback, loading, error, refresh, dims } = useInterviewData();

    async function onCreated(id: string) {
        navigate(`/interviews/${id}`);
    }

    async function onDelete(id: string) {
        await deleteInterview(id);
        await refresh();
    }

    async function onRescore(id: string) {
        await regenerateFeedback(id);
        await refresh();
    }

    return (
        <Page title="Dashboard" description="Start a new session or review how you're doing.">
            {!clerkEnabled && <p className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">Dev mode (no Clerk key) — requests run against the backend&apos;s DEV_USER. Set VITE_CLERK_PUBLISHABLE_KEY to enable real Clerk auth.</p>}

            <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <div className="flex flex-col gap-2">
                    <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">New interview</h2>
                    <div className="flex-1">
                        <CreateInterviewForm className="h-full" onCreated={onCreated} variant="compact" />
                    </div>
                </div>
                <div className="flex flex-col gap-2">
                    <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Performance</h2>
                    <div className="flex-1">
                        <DashboardStats className="h-full" loading={loading} dims={dims} feedback={feedback} />
                    </div>
                </div>
            </section>

            <section className="space-y-2">
                <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">History</h2>
                <InterviewList interviews={interviews} loading={loading} error={error} onRefresh={() => void refresh()} onOpen={(id) => navigate(`/interviews/${id}`)} onDelete={onDelete} onRescore={onRescore} />
            </section>
        </Page>
    );
}
