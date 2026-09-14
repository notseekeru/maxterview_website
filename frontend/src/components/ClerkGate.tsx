import { ClerkFailed, ClerkLoading, ClerkProvider, Show, SignInButton, SignUpButton } from "@clerk/react";
import type { ReactNode } from "react";

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
    return (
        <ClerkProvider publishableKey={clerkPublishableKey}>
            <ClerkLoading>
                <GateSkeleton />
            </ClerkLoading>
            <ClerkFailed>
                <GateFailed />
            </ClerkFailed>
            <Show when="signed-out">
                <SignedOut />
            </Show>
            <Show when="signed-in">{children}</Show>
        </ClerkProvider>
    );
}

/** Shell-shaped placeholder: same rail/width as AppShell so nothing jumps when auth lands. */
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

function SignedOut() {
    return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6">
            <div className="space-y-2 text-center">
                <h1 className="text-2xl font-semibold tracking-tight">maxterview</h1>
                <p className="max-w-sm text-sm text-muted-foreground">Practice interviews with an AI coach that scores every answer and tracks what you improve.</p>
            </div>
            <div className="flex items-center gap-3">
                <Button asChild>
                    <SignUpButton />
                </Button>
                <Button asChild variant="outline">
                    <SignInButton />
                </Button>
            </div>
        </div>
    );
}
