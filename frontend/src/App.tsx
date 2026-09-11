import { Show, SignInButton, SignUpButton } from "@clerk/react";
import { lazy, type ReactNode, Suspense } from "react";
import { BrowserRouter, Outlet, Route, Routes } from "react-router-dom";

import { AppShell } from "@/components/AppShell";
import { AppThemeSync } from "@/components/AppThemeSync";
import { AuthMisconfigBanner } from "@/components/AuthMisconfigBanner";
import { Button } from "@/components/ui/button";
import { clerkEnabled } from "@/lib/config";
import { AccountSettingsPage } from "@/pages/AccountSettingsPage";
import { BillingPage } from "@/pages/BillingPage";
import { AnalyticsPage, DocsPage, ManageAccountsPage, ResumePage } from "@/pages/ComingSoonPages";
import { InterviewsPage } from "@/pages/InterviewsPage";
import { Landing } from "@/pages/Landing";
import { NotFound } from "@/pages/NotFound";
import { SystemSettingsPage } from "@/pages/SystemSettingsPage";

// Code-split only the heavy leaves (recharts lives in the Dashboard bundle and
// the chat lives in its own route) so the shell/nav stay light.
const DashboardHome = lazy(() => import("@/pages/AppHome").then((m) => ({ default: m.AppHome })));
const InterviewRoute = lazy(() => import("@/pages/InterviewRoute").then((m) => ({ default: m.InterviewRoute })));

function App() {
    return (
        <BrowserRouter>
            <AppThemeSync />
            {/* Shown only when Clerk auth env is self-contradictory (bad key, or backend
                auth-gated but no usable pk_). Above <Routes> so it appears in every mode. */}
            <AuthMisconfigBanner />
            <Routes>
                <Route path="/" element={<Landing />} />

                {/* Gated subtree: this pathless route renders the shell/lightbox around an
                    <Outlet/> — the recursion is intentional, do not flatten it. */}
                <Route element={<Gate />}>
                    <Route path="/app" element={<AppShell />}>
                        <Route
                            index
                            element={
                                <Suspense fallback={<GateLoading />}>
                                    <DashboardHome />
                                </Suspense>
                            }
                        />

                        <Route path="interviews" element={<InterviewsPage />} />
                        <Route path="analytics" element={<AnalyticsPage />} />
                        <Route path="resume" element={<ResumePage />} />

                        <Route path="settings/system" element={<SystemSettingsPage />} />
                        <Route path="settings/account" element={<AccountSettingsPage />} />
                        <Route path="settings/billing" element={<BillingPage />} />

                        <Route path="manage/accounts" element={<ManageAccountsPage />} />
                        <Route path="manage/docs" element={<DocsPage />} />

                        {/* Unknown /app/* path -> dashboard (graceful). */}
                        <Route
                            path="*"
                            element={
                                <Suspense fallback={<GateLoading />}>
                                    <DashboardHome />
                                </Suspense>
                            }
                        />
                    </Route>

                    <Route
                        path="/interviews/:id"
                        element={
                            <Suspense fallback={<GateLoading />}>
                                <InterviewRoute />
                            </Suspense>
                        }
                    />
                </Route>

                {/* Catch-all: 404 regardless of auth state. */}
                <Route path="*" element={<NotFound />} />
            </Routes>
        </BrowserRouter>
    );
}

function GateLoading() {
    return <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">Loading…</div>;
}

// Gate: no-Clerk dev passes children straight through. Clerk mode gates the
// whole subtree behind sign-in; the signed-out lightbox replaces content.
function Gate() {
    if (!clerkEnabled) return <Outlet />;
    return (
        <ShowContent>
            <Outlet />
        </ShowContent>
    );
}

function ShowContent({ children }: { children: ReactNode }) {
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
