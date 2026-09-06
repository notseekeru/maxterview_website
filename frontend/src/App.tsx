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
import { SystemSettingsPage } from "@/pages/SystemSettingsPage";

// Code-split only the heavy leaves (recharts lives in the Dashboard bundle and
// the chat lives in its own route) so the shell/nav stay light.
const DashboardHome = lazy(() => import("@/pages/AppHome").then((m) => ({ default: m.AppHome })));
const InterviewRoute = lazy(() => import("@/pages/InterviewRoute").then((m) => ({ default: m.InterviewRoute })));

function App() {
    return (
        <BrowserRouter>
            {/* App-wide: keep the stored theme applied on every route, not only
                the System Settings page (fixes dark preference lost on Dashboard
                or any hard page load landing outside the settings route). */}
            <AppThemeSync />
            {/* Shows only when Clerk auth env is self-contradictory (bad key, or backend
                auth-gated but no usable pk_). Above <Routes> so it appears in every mode. */}
            <AuthMisconfigBanner />
            <Routes>
                {/* Public marketing landing (M12). */}
                <Route path="/" element={<Landing />} />

                {/* Everything else is gated; the pathless Gate route renders the
                    app/landing chrome around an <Outlet/> once (sign-in early-returns for
                    small screens but keeps recursion). */}
                <Route element={<Gate />}>
                    {/* App area: persistent sidebar shell around Dashboard + sub-pages. */}
                    <Route path="/app" element={<AppShell />}>
                        <Route
                            index
                            element={
                                <Suspense fallback={<GateLoading />}>
                                    <DashboardHome />
                                </Suspense>
                            }
                        />

                        {/* Top-level sidebar destinations. */}
                        <Route path="interviews" element={<InterviewsPage />} />
                        <Route path="analytics" element={<AnalyticsPage />} />
                        <Route path="resume" element={<ResumePage />} />

                        {/* Settings group. */}
                        <Route path="settings/system" element={<SystemSettingsPage />} />
                        <Route path="settings/account" element={<AccountSettingsPage />} />
                        <Route path="settings/billing" element={<BillingPage />} />

                        {/* Management group. */}
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

                    {/* Live interview / replay stays full-screen (not in the shell). */}
                    <Route
                        path="/interviews/:id"
                        element={
                            <Suspense fallback={<GateLoading />}>
                                <InterviewRoute />
                            </Suspense>
                        }
                    />
                </Route>
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
