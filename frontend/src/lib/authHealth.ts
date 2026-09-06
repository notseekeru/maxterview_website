// --- auth-mode + misconfiguration detection ------------------------------
// "Future-me guard": surface the classic env mistakes (wrong secret in the
// wrong var, placeholder still present, frontend/backend disagreeing about
// whether Clerk is on) instead of a silent login failure or 401 soup.

// Clerk publishable keys always start pk_ (dev pk_test_, live pk_live_).
// A non-empty key that does NOT start pk_ means someone pasted the wrong secret
// (most often the whsec_/sk_ from the Clerk/Stripe backend vars) into the
// VITE_CLERK_PUBLISHABLE_KEY slot. In that state we must NOT boot <ClerkProvider>
// (it would use a garbage key and nobody could ever sign in).
export const clerkKey = (import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined) ?? "";

export const clerkKeyShapeValid = /^pk_/.test(clerkKey);

// A placeholder copied straight out of .env.example (docs say "your-clerk-domain").
export const DOMAIN_PLACEHOLDER = "your-clerk-domain.clerk.accounts";

// True only when Clerk is genuinely usable from the browser: a real pk_ key is set.
export const clerkEnabled = clerkKeyShapeValid && clerkKey.length > 0;

export const clerkPublishableKey = clerkKey;

function originIsHttps(): boolean {
    if (typeof window === "undefined") return true; // SSR/build: assume prod
    return window.location.protocol === "https:";
}

// A production (pk_live_) key only authorizes its bound production origin. On any
// non-https origin (localhost in dev) Clerk rejects it with an Origin/domain error
// and no one can sign in — a classic trap worth a banner instead of a silent loop.
function isLiveKeyOnNonProdOrigin(): boolean {
    return clerkKey.startsWith("pk_live_") && !originIsHttps();
}

export function frontendAuthProblem(): string | null {
    if (!clerkKeyShapeValid && clerkKey.length > 0) {
        return `VITE_CLERK_PUBLISHABLE_KEY must be a Clerk publishable key starting pk_ (got “${clerkKey.slice(0, 12)}…”). A secret from another slot (Clerk/Stripe sk_/whsec_) looks pasted here. Clerk is disabled until this is fixed.`;
    }
    if (isLiveKeyOnNonProdOrigin()) {
        return "VITE_CLERK_PUBLISHABLE_KEY is a production (pk_live_) key. Clerk only accepts it on its HTTPS production origin — on localhost it will reject every login with an Origin/domain error. Use a pk_test_ key from the Clerk dashboard’s Development instance for local dev.";
    }
    return null;
}

// --- runtime backend-401 detection --------------------------------------
// Cross-process mismatch: the backend may be switched to CLERK_ENABLED=true
// (so it returns 401 "Missing credentials" on gated calls) while the browser has
// no usable pk_ key. We can't read backend/.env, so the 401 detail string is the
// signal. api.ts calls markAuthGate401() the first time it sees that exact error.
type Listener = (gateOn: boolean) => void;
let sawMissingCreds401 = false;
const listeners = new Set<Listener>();

export function authGateOn(): boolean {
    // Backend demands a session (401 missing-credentials seen) but the browser
    // cannot provide one (no valid pk_ key) => hard contradiction.
    return sawMissingCreds401 && !clerkEnabled;
}

export function markAuthGate401(): void {
    if (sawMissingCreds401) return;
    sawMissingCreds401 = true;
    const v = authGateOn();
    listeners.forEach((fn) => {
        fn(v);
    });
}

export function onAuthGate(fn: Listener): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
}
