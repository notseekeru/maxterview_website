import { ClerkFailed, ClerkLoading, ClerkProvider, Show, SignIn, SignUp } from "@clerk/react";
import { Navigate, Outlet, useLocation } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { clerkPublishableKey } from "@/lib/config";

export function ClerkLayout() {
    const { pathname, search } = useLocation();
    const authMode = authModeFor(pathname);
    return (
        <ClerkProvider publishableKey={clerkPublishableKey}>
            <ClerkLoading>{authMode ? <AuthSkeleton /> : <GateSkeleton />}</ClerkLoading>
            <ClerkFailed>
                <GateFailed />
            </ClerkFailed>
            {authMode ? <AuthBranch mode={authMode} /> : <GateBranch from={pathname + search} />}
        </ClerkProvider>
    );
}

function authModeFor(pathname: string): "sign-in" | "sign-up" | null {
    if (pathname === "/sign-in") return "sign-in";
    if (pathname === "/sign-up") return "sign-up";
    return null;
}

function AuthBranch({ mode }: { mode: "sign-in" | "sign-up" }) {
    const target = afterAuth();
    return (
        <>
            <Show when="signed-in">
                <Navigate to={target} replace />
            </Show>
            <Show when="signed-out">
                <div className="flex min-h-screen items-center justify-center bg-background p-6">{mode === "sign-in" ? <SignIn routing="hash" signUpUrl={crossLink("/sign-up", target)} forceRedirectUrl={target} /> : <SignUp routing="hash" signInUrl={crossLink("/sign-in", target)} forceRedirectUrl={target} />}</div>
            </Show>
        </>
    );
}

function GateBranch({ from }: { from: string }) {
    return (
        <>
            <Show when="signed-out">
                <Navigate to={signInPath(from)} replace />
            </Show>
            <Show when="signed-in">
                <Outlet />
            </Show>
        </>
    );
}

function GateSkeleton() {
    return (
        <div className="min-h-screen" role="status" aria-label="Checking your session">
            <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col gap-2 border-r border-border p-4 lg:flex">
                <Skeleton className="mb-4 h-6 w-32" />
                {[0, 1, 2, 3, 4].map((i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                ))}
            </aside>
            <div className="flex min-h-screen flex-col gap-4 p-6 lg:pl-64">
                <Skeleton className="h-8 w-48" />
                <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                    {[0, 1, 2, 3].map((i) => (
                        <Skeleton key={i} className="h-24" />
                    ))}
                </div>
                <Skeleton className="h-72" />
            </div>
        </div>
    );
}

function GateFailed() {
    return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-center">
            <h1 className="font-serif text-2xl tracking-[-0.02em]">Can’t reach the sign-in service</h1>
            <p className="max-w-sm text-sm text-muted-foreground">Clerk did not load, so we can’t tell whether you are signed in. Check your connection and try again.</p>
            <Button onClick={() => window.location.reload()}>Retry</Button>
        </div>
    );
}

function signInPath(from: string) {
    return `/sign-in?redirect_url=${encodeURIComponent(from)}`;
}

function afterAuth(): string {
    const wanted = new URLSearchParams(window.location.search).get("redirect_url") ?? "";
    return /^\/(?!\/)/.test(wanted) ? wanted : "/dashboard";
}

function crossLink(path: string, target: string) {
    return target === "/dashboard" ? path : `${path}?redirect_url=${encodeURIComponent(target)}`;
}

function AuthSkeleton() {
    return (
        <div className="flex min-h-screen items-center justify-center bg-background p-6" role="status" aria-label="Loading sign-in">
            <Skeleton className="h-96 w-full max-w-sm" />
        </div>
    );
}
