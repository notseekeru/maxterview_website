import { ClerkFailed, ClerkLoading, ClerkProvider, Show, SignIn, SignUp } from "@clerk/react";
import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { clerkPublishableKey } from "@/lib/config";

// The Clerk boundary, in its OWN module so App.tsx can import it lazily: the SDK (~93 kB gzip)
// then lives in a chunk that is only fetched once a gated route actually renders — the public
// landing page never pays for auth it does not use. Do not import this from `main.tsx`.
//
// Why not just `<Show>`: it returns null while auth is loading, so the whole gated subtree
// (shell included) used to be a white page until clerk.browser.js landed. `ClerkLoading` /
// `ClerkFailed` make that window visible and recoverable instead of blank.
export function ClerkGate({ children }: { children: ReactNode }) {
    const { pathname, search } = useLocation();
    return (
        <ClerkProvider publishableKey={clerkPublishableKey}>
            <ClerkLoading>
                <GateSkeleton />
            </ClerkLoading>
            <ClerkFailed>
                <GateFailed />
            </ClerkFailed>
            <Show when="signed-out">
                {/* Remember the page they asked for: /sign-in is stateless, so a deep link or the
                    landing "Upgrade" CTA would otherwise dead-end on /dashboard after signing in. */}
                <Navigate to={signInPath(pathname + search)} replace />
            </Show>
            <Show when="signed-in">{children}</Show>
        </ClerkProvider>
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
            <h1 className="text-xl font-semibold tracking-tight">Can’t reach the sign-in service</h1>
            <p className="max-w-sm text-sm text-muted-foreground">Clerk did not load, so we can’t tell whether you are signed in. Check your connection and try again.</p>
            <Button onClick={() => window.location.reload()}>Retry</Button>
        </div>
    );
}

function signInPath(from: string) {
    return `/sign-in?redirect_url=${encodeURIComponent(from)}`;
}

// Where to go once authenticated: the page the gate bounced them from, else the app home. The
// path must stay same-origin — an attacker-supplied absolute redirect_url would turn /sign-in
// into an open redirect for a freshly signed-in user.
function afterAuth(): string {
    const wanted = new URLSearchParams(window.location.search).get("redirect_url") ?? "";
    return /^\/(?!\/)/.test(wanted) ? wanted : "/dashboard";
}

function crossLink(path: string, target: string) {
    return target === "/dashboard" ? path : `${path}?redirect_url=${encodeURIComponent(target)}`;
}

// Auth-page placeholder: Clerk's card is ~max-w-sm, so the awaiting-clerk.js window matches it
// instead of flashing the dashboard skeleton that GateSkeleton draws for the gated subtree.
function AuthSkeleton() {
    return (
        <div className="flex min-h-screen items-center justify-center bg-background p-6" role="status" aria-label="Loading sign-in">
            <Skeleton className="h-96 w-full max-w-sm" />
        </div>
    );
}

// /sign-in and /sign-up: Clerk's own full-page form. The landing CTAs point here and the gate
// bounces here, so a signed-out visitor never sees a second marketing screen with buttons on
// it. Someone who is already signed in is sent to the app rather than asked to sign in again.
// hash routing: Clerk drives its own steps (#/factor-one, #/sso-callback) inside /sign-in, with
// no router integration to wire.
export function ClerkAuthPage({ mode }: { mode: "sign-in" | "sign-up" }) {
    const target = afterAuth();
    return (
        <ClerkProvider publishableKey={clerkPublishableKey}>
            <ClerkLoading>
                <AuthSkeleton />
            </ClerkLoading>
            <ClerkFailed>
                <GateFailed />
            </ClerkFailed>
            <Show when="signed-in">
                <Navigate to={target} replace />
            </Show>
            <Show when="signed-out">
                <div className="flex min-h-screen items-center justify-center bg-background p-6">{mode === "sign-in" ? <SignIn routing="hash" signUpUrl={crossLink("/sign-up", target)} forceRedirectUrl={target} /> : <SignUp routing="hash" signInUrl={crossLink("/sign-in", target)} forceRedirectUrl={target} />}</div>
            </Show>
        </ClerkProvider>
    );
}
