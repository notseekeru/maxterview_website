// Last-resort browser error capture, on every page: it has to exist before sign-in, where a blank
// landing page is a lost visitor nobody hears about.

const ENDPOINT = `${import.meta.env.VITE_API_BASE ?? "/api"}/client-errors`;
const MAX_REPORTS = 5;
// Matches the backend field cap: a longer stack would be a 422 and the report would be lost.
const MAX_STACK = 1000;

const seen = new Set<string>();
let sent = 0;

function report(message: string, componentStack = ""): void {
    const text = message.slice(0, 300);
    if (!text || sent >= MAX_REPORTS || seen.has(text)) return;
    seen.add(text);
    sent += 1;
    const body = JSON.stringify({ message: text, route: window.location.pathname.slice(0, 200), component_stack: componentStack.slice(0, MAX_STACK) });
    // sendBeacon survives the page going away — the error may be terminal. fetch is the fallback.
    if (!navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: "application/json" }))) {
        void fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => undefined);
    }
}

export function initErrorBeacon(): void {
    window.addEventListener("error", (event) => {
        // A failed <script>/<img> arrives here as an Event with no `message`; name what failed.
        if (event.message) report(event.message);
        else if (event.target instanceof HTMLScriptElement) report(`script failed to load: ${event.target.src}`);
    });
    window.addEventListener("unhandledrejection", (event) => {
        const reason: unknown = event.reason;
        report(reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "unhandled rejection");
    });
}

export function reportRenderCrash(error: Error, componentStack?: string | null): void {
    report(error.message, componentStack ?? "");
}
