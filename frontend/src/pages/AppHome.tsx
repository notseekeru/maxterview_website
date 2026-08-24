import { useNavigate } from "react-router-dom";

import { CreateInterviewForm } from "@/components/CreateInterviewForm";
import { DashboardStats } from "@/components/DashboardStats";
import { InterviewList } from "@/components/InterviewList";
import { UsageBadge } from "@/components/UsageBadge";
import { Button } from "@/components/ui/button";
import { useInterviewData } from "@/hooks/useInterviewData";
import { clerkEnabled } from "@/lib/config";

// /app — dashboard home (M12). One data source (useInterviewData) shared by
// stats and history; creating an interview refreshes both.
export function AppHome() {
    const navigate = useNavigate();
    const { interviews, feedback, loading, error, refresh, dims } = useInterviewData();

    async function onCreated(id: string) {
        navigate(`/interviews/${id}`);
    }

    return (
        <div className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-8 p-6 sm:p-8">
            <header className="flex w-full items-center justify-between">
                <div className="flex items-center gap-3">
                    <h1 className="text-2xl font-semibold tracking-tight">maxterview</h1>
                    <UsageBadge />
                </div>
                <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
                    Home
                </Button>
            </header>

            {!clerkEnabled && <p className="rounded border border-dashed p-3 text-sm text-muted-foreground">Dev mode (no Clerk key) — requests run against the backend’s DEV_USER. Set VITE_CLERK_PUBLISHABLE_KEY to enable real Clerk auth.</p>}

            <section className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
                <div className="space-y-2">
                    <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">New interview</h2>
                    <CreateInterviewForm onCreated={onCreated} />
                </div>
                <div className="space-y-2">
                    <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">Performance</h2>
                    <DashboardStats loading={loading} dims={dims} feedback={feedback} />
                </div>
            </section>

            <section className="space-y-2">
                <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">History</h2>
                <InterviewList interviews={interviews} loading={loading} error={error} onRefresh={() => void refresh()} onOpen={(id) => navigate(`/interviews/${id}`)} />
            </section>
        </div>
    );
}
