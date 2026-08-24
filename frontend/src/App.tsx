import { Show, SignInButton, SignUpButton } from "@clerk/react";
import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { clerkEnabled } from "@/lib/config";
import { Landing } from "@/pages/Landing";

// Code-split the gated app (recharts lives only in the /app bundle).
const AppHome = lazy(() => import("@/pages/AppHome").then((m) => ({ default: m.AppHome })));
const InterviewRoute = lazy(() => import("@/pages/InterviewRoute").then((m) => ({ default: m.InterviewRoute })));

function App() {
    return (
        <BrowserRouter>
            <Routes>
                {/* Public marketing landing (M12). */}
                <Route path="/" element={<Landing />} />
                {/* Gated app section. */}
                <Route
                    path="/app"
                    element={
                        <ClerkGate>
                            <Suspense fallback={<GateLoading />}>
                                <AppHome />
                            </Suspense>
                        </ClerkGate>
                    }
                />
                <Route
                    path="/interviews/:id"
                    element={
                        <ClerkGate>
                            <Suspense fallback={<GateLoading />}>
                                <InterviewRoute />
                            </Suspense>
                        </ClerkGate>
                    }
                />
            </Routes>
        </BrowserRouter>
    );
}

function GateLoading() {
    return <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">Loading…</div>;
}

// In Clerk mode, show sign-in until authenticated; then render children.
function ClerkGate({ children }: { children: React.ReactNode }) {
    if (!clerkEnabled) return <>{children}</>;
    return (
        <>
            <Show when="signed-out">
                <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6">
                    <h1 className="text-2xl font-semibold tracking-tight">maxterview</h1>
                    <div className="flex items-center gap-3">
                        <Button asChild>
                            <SignInButton />
                        </Button>
                        <Button asChild variant="outline">
                            <SignUpButton />
                        </Button>
                    </div>
                </div>
            </Show>
            <Show when="signed-in">{children}</Show>
        </>
    );
}

export default App;
