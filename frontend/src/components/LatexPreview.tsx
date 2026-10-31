import type { AxiosError } from "axios";
import { useEffect, useRef, useState } from "react";
import { LABEL } from "@/components/PagePrimitives";
import { PdfPages } from "@/components/PdfPages";
import { compileLatex } from "@/lib/api";
import type { QuotedLine } from "@/lib/resumeText";

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

export function LatexPreview({ text, lines }: { text: string; lines: QuotedLine[] }) {
    const [pdf, setPdf] = useState<Uint8Array | null>(null);
    const [url, setUrl] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const current = useRef<string | null>(null);

    useEffect(() => {
        let alive = true;
        const timer = window.setTimeout(async () => {
            setBusy(true);
            try {
                const blob = await compileLatex(text);
                if (!alive) return;
                if (current.current) URL.revokeObjectURL(current.current);
                current.current = URL.createObjectURL(blob);
                setUrl(current.current);
                setPdf(new Uint8Array(await blob.arrayBuffer()));
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
                <div className="flex items-center gap-2">
                    <span className={error ? "text-[11px] text-destructive" : "text-[11px] text-muted-foreground"}>{busy ? "Compiling…" : error ? "Does not compile" : pdf ? "PDF" : "Waiting"}</span>
                    {/* The canvas carries the audit wash but no zoom or search: the native viewer still does. */}
                    {url && (
                        <a href={url} target="_blank" rel="noreferrer" className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground">
                            Open
                        </a>
                    )}
                </div>
            </div>
            {error ? <p className="m-3 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-4 text-destructive">{error}</p> : pdf ? <PdfPages data={pdf} lines={lines} /> : <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground" />}
        </div>
    );
}
