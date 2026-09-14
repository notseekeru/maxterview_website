import { useEffect } from "react";

const BASE = "maxterview";
const TAGLINE = "maxterview — AI mock-interview coach";

/** Per-route <title>. The SPA ships one HTML shell, so the title is the only head signal a
 *  client-side navigation can still correct (crawlers that run JS included). */
export function useDocumentTitle(title?: string): void {
    useEffect(() => {
        document.title = title ? `${title} · ${BASE}` : TAGLINE;
    }, [title]);
}
