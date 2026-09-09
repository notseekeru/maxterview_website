import { useNavigate } from "react-router-dom";

import { CreateInterviewForm } from "@/components/CreateInterviewForm";
import { InterviewList } from "@/components/InterviewList";
import { Page } from "@/components/PagePrimitives";
import { useInterviewData } from "@/hooks/useInterviewData";
import { deleteInterview } from "@/lib/api";

// /app/interviews — a management home for your sessions. Mirrors the Dashboard's
// "New interview" panel so you can start a session here too, above the history.
// Shares the same single data source as the Dashboard (useInterviewData).
export function InterviewsPage() {
    const navigate = useNavigate();
    const { interviews, loading, error, refresh } = useInterviewData();

    async function onCreated(id: string) {
        navigate(`/interviews/${id}`);
    }

    async function onDelete(id: string) {
        await deleteInterview(id);
        await refresh();
    }

    return (
        <Page title="Interviews" description="Start a new session or review, reopen or remove your interview history.">
            <section className="space-y-2">
                <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">New interview</h2>
                <CreateInterviewForm onCreated={onCreated} />
            </section>

            <section className="space-y-2">
                <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">History</h2>
                <InterviewList interviews={interviews} loading={loading} error={error} onRefresh={() => void refresh()} onOpen={(id) => navigate(`/interviews/${id}`)} onDelete={onDelete} />
            </section>
        </Page>
    );
}
