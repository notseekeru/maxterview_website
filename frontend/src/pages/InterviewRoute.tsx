import { useNavigate, useParams } from "react-router-dom";

import { InterviewChat } from "@/components/InterviewChat";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export function InterviewRoute() {
    useDocumentTitle("Interview");
    const navigate = useNavigate();
    const { id } = useParams<{ id: string }>();
    if (!id) throw new Error("missing interview id in route");
    return <InterviewChat interviewId={id} onExit={() => navigate("/dashboard")} />;
}
