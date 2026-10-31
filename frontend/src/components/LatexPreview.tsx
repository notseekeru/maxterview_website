import type { AxiosError } from "axios";
import { useEffect, useRef, useState } from "react";
import { LABEL } from "@/components/PagePrimitives";
import { compileLatex } from "@/lib/api";

const DEBOUNCE_MS = 900;

// The compiler reports the first error with its line number, so it is worth showing as-is rather than
// swallowing it behind "compile failed".
async function detailOf(error: unknown): Promise<string> {
    const data = (error as AxiosError<Blob | { detail?: string }>)?.response?.data;
    if (data instanceof Blob) {
        try {
            const parsed = JSON.parse(await data.text()) as { detail?: unknown };
            if (typeof parsed.detail === "string") return parsed.detail;
        } catch {
            return "";
        }
    }
    return "";
}

export function LatexPreview({ text }: { text: string }) {
    const [url, setUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const current = useRef<string | null>(null);

    useEffect(() => {
        let alive = true;
        const timer = window.setTimeout(async () => {
            setBusy(true);
            try {
                const pdf = await compileLatex(text);
                if (!alive) return;
                if (current.current) URL.revokeObjectURL(current.current);
                current.current = URL.createObjectURL(pdf);
                setUrl(current.current);
                setError(null);
            } catch (problem) {
                if (!alive) return;
                setError((await detailOf(problem)) || "Could not compile this document.");
            } finally {
                if (alive) setBusy(false);
            }
        }, DEBOUNCE_MS);
        return () => {
            alive = false;
            window.clearTimeout(timer);
        };
    }, [text]);

    // A blob URL lives until it is revoked, and every rebuild makes a new one.
    useEffect(
        () => () => {
            if (current.current) URL.revokeObjectURL(current.current);
        },
        [],
    );

    return (
        <div className="flex min-h-0 flex-1 flex-col rounded-xl border">
            <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
                <span className={LABEL}>Preview</span>
                <span className={error ? "text-[11px] text-destructive" : "text-[11px] text-muted-foreground"}>{busy ? "Compiling…" : error ? "Does not compile" : url ? "PDF" : "Waiting"}</span>
            </div>
            {error ? (
                <p className="m-3 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-4 text-destructive">{error}</p>
            ) : url ? (
                <iframe title="Resume preview" src={url} className="min-h-0 w-full flex-1 rounded-b-xl bg-white" />
            ) : (
                <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground" />
            )}
        </div>
    );
}
