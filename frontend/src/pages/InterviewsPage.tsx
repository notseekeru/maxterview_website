import { useNavigate } from "react-router-dom";

import { CreateInterviewForm } from "@/components/CreateInterviewForm";
import { InterviewList } from "@/components/InterviewList";
import { Page } from "@/components/PagePrimitives";
import { useInterviewData } from "@/hooks/useInterviewData";
import { archiveInterview, deleteInterview, regenerateFeedback, unarchiveInterview } from "@/lib/api";

// /app/interviews — a management home for your sessions.
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

    async function onArchive(id: string, archived: boolean) {
        await (archived ? archiveInterview(id) : unarchiveInterview(id));
        await refresh();
    }

    async function onRescore(id: string) {
        await regenerateFeedback(id);
        await refresh();
    }

    return (
        <Page title="Interviews" description="Start a new session or review, reopen or remove your interview history.">
            <section className="space-y-2">
                <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">New interview</h2>
                <CreateInterviewForm onCreated={onCreated} variant="featured" />
            </section>

            <section className="space-y-2">
                <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">History</h2>
                <InterviewList interviews={interviews} loading={loading} error={error} onRefresh={() => void refresh()} onOpen={(id) => navigate(`/interviews/${id}`)} onDelete={onDelete} onArchive={onArchive} onRescore={onRescore} />
            </section>
        </Page>
    );
}
