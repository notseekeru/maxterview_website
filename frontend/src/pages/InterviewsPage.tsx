import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { CreateInterviewForm } from "@/components/CreateInterviewForm";
import { InterviewList } from "@/components/InterviewList";
import { Page } from "@/components/PagePrimitives";
import { useInterviews } from "@/hooks/useInterviewData";
import { archiveInterview, deleteInterview, regenerateFeedback, unarchiveInterview } from "@/lib/api";

export function InterviewsPage() {
    const navigate = useNavigate();
    const [view, setView] = useState<"active" | "archived">("active");
    const { interviews, loading, error, refresh, hasMore, loadMore } = useInterviews(view === "archived");

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
        <Page title="Interviews" wide>
            <section id="new-interview" className="scroll-mt-20">
                <CreateInterviewForm onCreated={onCreated} />
            </section>

            <InterviewList interviews={interviews} loading={loading} error={error} view={view} onViewChange={setView} hasMore={hasMore} onLoadMore={() => void loadMore()} onRefresh={() => void refresh()} onOpen={(id) => navigate(`/interviews/${id}`)} onDelete={onDelete} onArchive={onArchive} onRescore={onRescore} />
        </Page>
    );
}
