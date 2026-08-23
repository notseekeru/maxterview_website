import { Show, SignInButton, SignUpButton, UserButton } from "@clerk/react";
import { BrowserRouter, Route, Routes, useNavigate, useParams } from "react-router-dom";
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
                    <nav className="flex items-center gap-2">
                        <HomeLink />
                        <Show when="signed-in">
                            <UserButton />
                        </Show>
                    </nav>
                ) : (
                    <HomeLink />
                )}
            </header>
            <main className="w-full max-w-2xl">{children}</main>
        </div>
    );
}

function HomeLink() {
    const navigate = useNavigate();
    return (
        <Button variant="ghost" size="sm" onClick={() => navigate("/")}>
            Home
        </Button>
    );
}

function Dashboard() {
    const navigate = useNavigate();
    return (
        <Shell>
            <div className="space-y-6">
                {!clerkEnabled && <DevBanner />}
                <CreateInterviewForm onCreated={(id) => navigate(`/interviews/${id}`)} />
                <InterviewList onOpen={(id) => navigate(`/interviews/${id}`)} />
            </div>
        </Shell>
    );
}

function InterviewRoute() {
    const navigate = useNavigate();
    return (
        <Shell>
            <InterviewChat interviewId={useParamsId()} onExit={() => navigate("/")} />
        </Shell>
    );
}

function useParamsId(): string {
    const { id } = useParams<{ id: string }>();
    if (!id) throw new Error("missing interview id in route");
    return id;
}

function App() {
    if (!clerkEnabled) {
        return (
            <BrowserRouter>
                <Routes>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/interviews/:id" element={<InterviewRoute />} />
                </Routes>
            </BrowserRouter>
        );
    }
    return (
        <ClerkGate>
            <BrowserRouter>
                <Routes>
                    <Route path="/" element={<Dashboard />} />
                    <Route path="/interviews/:id" element={<InterviewRoute />} />
                </Routes>
            </BrowserRouter>
        </ClerkGate>
    );
}

// In Clerk mode, show sign-in until authenticated; then render children.
function ClerkGate({ children }: { children: React.ReactNode }) {
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
            <Show when="signed-in">{children}</Show>
        </>
    );
}

export default App;
