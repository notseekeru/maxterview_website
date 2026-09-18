import { lazy, Suspense } from "react";
import { BrowserRouter, Outlet, Route, Routes } from "react-router-dom";

import { AppThemeSync } from "@/components/AppThemeSync";
import { AuthMisconfigBanner } from "@/components/AuthMisconfigBanner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { clerkEnabled } from "@/lib/config";
import { BillingPage } from "@/pages/BillingPage";
import { DocsPage, ManageAccountsPage } from "@/pages/ComingSoonPages";
import { InterviewsPage } from "@/pages/InterviewsPage";
import { Landing } from "@/pages/Landing";
import { NotFound } from "@/pages/NotFound";
import { ResumePage } from "@/pages/ResumePage";
import { SystemSettingsPage } from "@/pages/SystemSettingsPage";

// Code-split only the heavy leaves (recharts lives in the Dashboard bundle and
// the chat lives in its own route) so the shell/nav stay light.
const DashboardHome = lazy(() => import("@/pages/AppHome").then((m) => ({ default: m.AppHome })));
const AnalyticsPage = lazy(() => import("@/pages/AnalyticsPage").then((m) => ({ default: m.AnalyticsPage })));
const InterviewRoute = lazy(() => import("@/pages/InterviewRoute").then((m) => ({ default: m.InterviewRoute })));
// EVERY module that imports @clerk/react must sit below this line. A static import of AppShell /
// AccountSettingsPage here would pull the SDK back into the entry chunk that the public landing
// page pays for — the lazy boundary is the split, not the `clerkEnabled` check.
const ClerkGate = lazy(() => import("@/components/ClerkGate").then((m) => ({ default: m.ClerkGate })));
const AppShell = lazy(() => import("@/components/AppShell").then((m) => ({ default: m.AppShell })));
const AccountSettingsPage = lazy(() => import("@/pages/AccountSettingsPage").then((m) => ({ default: m.AccountSettingsPage })));

function App() {
    return (
        <BrowserRouter>
            <AppThemeSync />
            {/* Shown only when Clerk auth env is self-contradictory (bad key, or backend
                auth-gated but no usable pk_). Above <Routes> so it appears in every mode. */}
            <AuthMisconfigBanner />
            {/* Inside the router so a crash still renders a usable (styled) page. */}
            <ErrorBoundary>
                <Routes>
                    <Route path="/" element={<Landing />} />

                    {/* Gated subtree: these pathless routes render the shell/lightbox around an
                        <Outlet/> — the recursion is intentional, do not flatten it. Every app
                        page owns a top-level path; unknown ones fall to the 404 below. */}
                    <Route element={<Gate />}>
                        <Route element={<AppShell />}>
                            <Route
                                path="/dashboard"
                                element={
                                    <Suspense fallback={<GateLoading />}>
                                        <DashboardHome />
                                    </Suspense>
                                }
                            />

                            <Route path="/interviews" element={<InterviewsPage />} />
                            <Route
                                path="/analytics"
                                element={
                                    <Suspense fallback={<GateLoading />}>
                                        <AnalyticsPage />
                                    </Suspense>
                                }
                            />
                            <Route path="/resume" element={<ResumePage />} />

                            <Route path="/settings/system" element={<SystemSettingsPage />} />
                            <Route path="/settings/account" element={<AccountSettingsPage />} />
                            <Route path="/settings/billing" element={<BillingPage />} />

                            <Route path="/manage/accounts" element={<ManageAccountsPage />} />
                            <Route path="/manage/docs" element={<DocsPage />} />
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
            </ErrorBoundary>
        </BrowserRouter>
    );
}

function GateLoading() {
    return <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">Loading…</div>;
}

// Gate: no-Clerk dev passes children straight through (the Clerk chunk is never fetched). With
// Clerk on, the lazy provider owns the loading / signed-out / failure states.
function Gate() {
    if (!clerkEnabled) return <Outlet />;
    return (
        <Suspense fallback={<GateLoading />}>
            <ClerkGate>
                <Outlet />
            </ClerkGate>
        </Suspense>
    );
}

export default App;
