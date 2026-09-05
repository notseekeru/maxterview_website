import { useNavigate } from "react-router-dom";

import { InterviewList } from "@/components/InterviewList";
import { Page } from "@/components/PagePrimitives";
import { useInterviewData } from "@/hooks/useInterviewData";
import { deleteInterview } from "@/lib/api";

// /app/interviews — a management home for your sessions (list / replay / delete).
// Shares the same single data source as the Dashboard (useInterviewData).
export function InterviewsPage() {
    const navigate = useNavigate();
    const { interviews, loading, error, refresh } = useInterviewData();

    async function onDelete(id: string) {
        await deleteInterview(id);
        await refresh();
    }

    return (
        <Page title="Interviews" description="Review, reopen or remove your interview history.">
            <InterviewList interviews={interviews} loading={loading} error={error} onRefresh={() => void refresh()} onOpen={(id) => navigate(`/interviews/${id}`)} onDelete={onDelete} />
        </Page>
    );
}
