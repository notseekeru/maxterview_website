import { useNavigate, useParams } from "react-router-dom";

import { InterviewChat } from "@/components/InterviewChat";

// /interviews/:id — the live interview / replay screen.
export function InterviewRoute() {
    const navigate = useNavigate();
    const { id } = useParams<{ id: string }>();
    if (!id) throw new Error("missing interview id in route");
    return (
        <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col items-center gap-6 p-6">
            <header className="flex w-full items-center justify-between">
                <h1 className="text-2xl font-semibold tracking-tight">maxterview</h1>
                <span className="text-sm text-muted-foreground">Interview</span>
            </header>
            <InterviewChat interviewId={id} onExit={() => navigate("/app")} />
        </div>
    );
}
