import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Outlet, Route, Routes } from "react-router-dom";

import { AppThemeSync } from "@/components/AppThemeSync";
import { AuthMisconfigBanner } from "@/components/AuthMisconfigBanner";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { clerkEnabled } from "@/lib/config";
import { BillingPage } from "@/pages/BillingPage";
import { DocsPage } from "@/pages/DocsPage";
import { InterviewsPage } from "@/pages/InterviewsPage";
import { Landing } from "@/pages/Landing";
import { NotFound } from "@/pages/NotFound";
import { ResumePage } from "@/pages/ResumePage";
import { SystemSettingsPage } from "@/pages/SystemSettingsPage";

const DashboardHome = lazy(() => import("@/pages/AppHome").then((m) => ({ default: m.AppHome })));
const AnalyticsPage = lazy(() => import("@/pages/AnalyticsPage").then((m) => ({ default: m.AnalyticsPage })));
const InterviewRoute = lazy(() => import("@/pages/InterviewRoute").then((m) => ({ default: m.InterviewRoute })));
const ClerkLayout = lazy(() => import("@/components/ClerkGate").then((m) => ({ default: m.ClerkLayout })));
const AppShell = lazy(() => import("@/components/AppShell").then((m) => ({ default: m.AppShell })));
const AccountSettingsPage = lazy(() => import("@/pages/AccountSettingsPage").then((m) => ({ default: m.AccountSettingsPage })));

function App() {
    return (
        <BrowserRouter>
            <AppThemeSync />
            <AuthMisconfigBanner />
            <ErrorBoundary>
                <Routes>
                    <Route path="/" element={<Landing />} />
                    <Route element={<ClerkLayer />}>
                        <Route path="/sign-in" element={<AuthRoute />} />
                        <Route path="/sign-up" element={<AuthRoute />} />
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
                            <Route path="/settings/docs" element={<DocsPage />} />
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

                    <Route path="*" element={<NotFound />} />
                </Routes>
            </ErrorBoundary>
        </BrowserRouter>
    );
}

function GateLoading() {
    return <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">Loading…</div>;
}

function AuthRoute() {
    if (!clerkEnabled) return <Navigate to="/dashboard" replace />;
    return null;
}

function ClerkLayer() {
    if (!clerkEnabled) return <Outlet />;
    return (
        <Suspense fallback={<GateLoading />}>
            <ClerkLayout />
        </Suspense>
    );
}

export default App;
