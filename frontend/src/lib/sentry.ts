// Browser error capture (M13 tier 1). Frontend-only by decision: a backend exception already reaches
// stdout on its own, a browser error reaches nobody — and React's ErrorBoundary only sees throws that
// happen while it renders, never an event handler or a rejected promise.
//
// The SDK is loaded on demand, never at module scope: the public landing route must not download it
// (same rule as the lazy <ClerkGate>), and with no DSN configured — dev, and anyone building without
// one — every function here is a no-op.

const DSN = import.meta.env.VITE_SENTRY_DSN;

type Sdk = typeof import("@sentry/react");

let sdk: Promise<Sdk | null> | null = null;

function load(): Promise<Sdk | null> {
    if (!DSN) return Promise.resolve(null);
    sdk ??= import("@sentry/react").then((Sentry) => {
        Sentry.init({
            dsn: DSN,
            // Breadcrumbs wrap console/fetch/xhr by default. This codebase's rule is that no message
            // body ever leaves the process (`shape=` fingerprints only), so console breadcrumbs go.
            beforeBreadcrumb: (breadcrumb) => (breadcrumb.category === "console" ? null : breadcrumb),
            sendDefaultPii: false,
        });
        return Sentry;
    });
    return sdk;
}

/** Load the SDK after the first paint so it never competes with the landing route. */
export function initSentry(): void {
    if (!DSN) return;
    const idle: (run: () => void) => void = window.requestIdleCallback ? (run) => void window.requestIdleCallback(() => run(), { timeout: 2000 }) : (run) => void window.setTimeout(run, 0);
    idle(() => void load());
}

/** Report an error. `requestId` comes from the response header and joins this event to the backend's
 * access line for the same request, which is the only correlation available without tracing. */
export async function captureError(error: unknown, context: { requestId?: string | null; componentStack?: string | null } = {}): Promise<void> {
    const Sentry = await load();
    Sentry?.captureException(error, {
        tags: context.requestId ? { request_id: context.requestId } : undefined,
        contexts: context.componentStack ? { react: { componentStack: context.componentStack } } : undefined,
    });
}
