import { useNavigate, useParams } from "react-router-dom";

import { InterviewChat } from "@/components/InterviewChat";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

// /interviews/:id — the live interview / replay screen.
export function InterviewRoute() {
    useDocumentTitle("Interview");
    const navigate = useNavigate();
    const { id } = useParams<{ id: string }>();
    if (!id) throw new Error("missing interview id in route");
    return (
        <div className="flex h-dvh w-full flex-col gap-3 p-4">
            <header className="flex w-full items-center justify-between">
                <h1 className="text-2xl font-semibold tracking-tight">maxterview</h1>
                <span className="text-sm text-muted-foreground">Interview</span>
            </header>
            <InterviewChat interviewId={id} onExit={() => navigate("/dashboard")} />
        </div>
    );
}
