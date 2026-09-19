// Last-resort browser error capture for the ANONYMOUS pages (M13 tier 1). The authenticated app gets
// the full Sentry SDK; this is the ~1 kB that has to exist before sign-in, where a blank landing page
// is a lost visitor nobody would otherwise hear about.
//
// Reports the message and the path, nothing else: no stack (nothing here is symbolicated), no query
// string (ids and tokens live there), no page content. An identical message is sent once and the page
// stops after MAX_REPORTS, so a render loop cannot become a log flood.

const ENDPOINT = `${import.meta.env.VITE_API_BASE ?? "/api"}/client-errors`;
const MAX_REPORTS = 5;

const seen = new Set<string>();
let sent = 0;

function report(message: string): void {
    const text = message.slice(0, 300);
    if (!text || sent >= MAX_REPORTS || seen.has(text)) return;
    seen.add(text);
    sent += 1;
    const body = JSON.stringify({ message: text, route: window.location.pathname.slice(0, 200) });
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
