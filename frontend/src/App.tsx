import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/react";
import { useCallback, useState } from "react";
import { CreateInterviewForm } from "@/components/CreateInterviewForm";
import { InterviewChat } from "@/components/InterviewChat";
import { InterviewList } from "@/components/InterviewList";
import { Button } from "@/components/ui/button";
import { clerkEnabled } from "@/lib/config";

function DevBanner() {
    return <div className="mb-4 rounded border border-dashed p-3 text-sm text-muted-foreground">Dev mode (no Clerk key) — requests run against the backend&#39;s DEV_USER. Set VITE_CLERK_PUBLISHABLE_KEY to enable real Clerk auth.</div>;
}

function Shell({ children }: { children: React.ReactNode }) {
    return (
        <div className="flex min-h-screen flex-col items-center gap-6 bg-background p-6 text-foreground">
            <header className="flex w-full max-w-2xl items-center justify-between">
                <h1 className="text-2xl font-semibold">maxterview</h1>
                {clerkEnabled ? (
                    <Show when="signed-in">
                        <UserButton />
                    </Show>
                ) : null}
            </header>
            <main className="w-full max-w-2xl">{children}</main>
        </div>
    );
}

type View = { kind: "home" } | { kind: "interview"; id: string };

function Dashboard() {
    const [view, setView] = useState<View>({ kind: "home" });
    const goHome = useCallback(() => setView({ kind: "home" }), []);
    const open = useCallback((id: string) => setView({ kind: "interview", id }), []);

    return (
        <Shell>
            {view.kind === "home" ? (
                <div className="space-y-6">
                    {!clerkEnabled && <DevBanner />}
                    <CreateInterviewForm onCreated={open} />
                    <InterviewList onOpen={open} />
                </div>
            ) : (
                <InterviewChat interviewId={view.id} onExit={goHome} />
            )}
        </Shell>
    );
}

function App() {
    if (!clerkEnabled) {
        return <Dashboard />;
    }
    return (
        <>
            <Show when="signed-out">
                <div className="flex min-h-screen items-center justify-center gap-3 bg-background p-6">
                    <Button asChild>
                        <SignInButton />
                    </Button>
                    <Button asChild variant="outline">
                        <SignUpButton />
                    </Button>
                </div>
            </Show>
            <Show when="signed-in">
                <Dashboard />
            </Show>
        </>
    );
}

export default App;
