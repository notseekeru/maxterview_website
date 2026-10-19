import { useNavigate } from "react-router-dom";

import { CreateInterviewForm } from "@/components/CreateInterviewForm";
import { InterviewList } from "@/components/InterviewList";
import { Page } from "@/components/PagePrimitives";
import { useInterviews } from "@/hooks/useInterviewData";
import { archiveInterview, deleteInterview, regenerateFeedback, unarchiveInterview } from "@/lib/api";

export function InterviewsPage() {
    const navigate = useNavigate();
    const { interviews, loading, error, refresh } = useInterviews();

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
        <Page title="Interviews" description="Every run you have started: open one, review it again, or start the next." wide>
            <section id="new-interview" className="scroll-mt-20">
                <CreateInterviewForm onCreated={onCreated} variant="featured" />
            </section>

            <InterviewList interviews={interviews} loading={loading} error={error} onRefresh={() => void refresh()} onOpen={(id) => navigate(`/interviews/${id}`)} onDelete={onDelete} onArchive={onArchive} onRescore={onRescore} />
        </Page>
    );
}
