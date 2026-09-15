import { useEffect } from "react";

const BASE = "maxterview";
// Must stay in sync with <title> in index.html: this overwrites the static title the moment React
// mounts, so a render-capable crawler would otherwise read a different title than a non-JS one.
const TAGLINE = "AI Mock Interview Practice with Instant Feedback | maxterview";

/** Per-route <title>. The SPA ships one HTML shell, so the title is the only head signal a
 *  client-side navigation can still correct (crawlers that run JS included). */
export function useDocumentTitle(title?: string): void {
    useEffect(() => {
        document.title = title ? `${title} · ${BASE}` : TAGLINE;
    }, [title]);
}
