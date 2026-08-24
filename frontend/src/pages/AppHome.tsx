import { useNavigate } from "react-router-dom";
import { CreateInterviewForm } from "@/components/CreateInterviewForm";
import { DashboardStats } from "@/components/DashboardStats";
import { InterviewList } from "@/components/InterviewList";
import { UsageBadge } from "@/components/UsageBadge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { clerkEnabled } from "@/lib/config";

// /app — dashboard home (M12): usage badge, create form, stats/charts, history.
export function AppHome() {
    const navigate = useNavigate();
    return (
        <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 p-6">
            <header className="flex w-full items-center justify-between">
                <h1 className="text-2xl font-semibold tracking-tight">maxterview</h1>
                <div className="flex items-center gap-2">
                    <UsageBadge />
                    <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
                        Home
                    </Button>
                </div>
            </header>

            {!clerkEnabled && <p className="rounded border border-dashed p-3 text-sm text-muted-foreground">Dev mode (no Clerk key) — requests run against the backend’s DEV_USER. Set VITE_CLERK_PUBLISHABLE_KEY to enable real Clerk auth.</p>}

            <CreateInterviewForm onCreated={(id) => navigate(`/interviews/${id}`)} />

            <DashboardStats />

            <Separator />

            <InterviewList onOpen={(id) => navigate(`/interviews/${id}`)} />
        </div>
    );
}
