import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ALL_DIMS } from "@/lib/dimensions";
import { cn } from "@/lib/utils";

// The three model passes behind Finish, in the order the backend runs them (grader, formatter,
// annotator). SCRIPTED, not measured: the endpoint answers once, at the end, so there is no progress
// upgrade path is stage events on the response stream.
const STAGES = [
    { afterMs: 0, label: "Reading your transcript" },
    { afterMs: 7000, label: `Scoring ${ALL_DIMS.length} dimensions` },
    { afterMs: 18000, label: "Annotating your answers" },
];

/** Covers the screen while a run is being finished. Dismissing cancels nothing: the request keeps
 *  running and the review lands in the transcript when it returns. Mounted for the whole wait and
 *  hidden, not unmounted, when dismissed, so reopening it shows the real clock and stage. `title`
 *  differs between the two paths into it: finishing a run, and rebuilding a finished run's review. */
export function FinishOverlay({ open, title, done, onDismiss }: { open: boolean; title: string; done: boolean; onDismiss: () => void }) {
    const [elapsedMs, setElapsedMs] = useState(0);
    const titleId = useId();

    useEffect(() => {
        const started = Date.now();
        const tick = setInterval(() => setElapsedMs(Date.now() - started), 500);
        return () => clearInterval(tick);
    }, []);

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onDismiss();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, onDismiss]);

    const active = done ? STAGES.length : STAGES.reduce((n, stage, i) => (elapsedMs >= stage.afterMs ? i : n), 0);

    return (
        <div className={cn("fixed inset-0 z-50 items-center justify-center bg-background/70 p-4 backdrop-blur-sm", open ? "flex" : "hidden")} role="dialog" aria-modal="true" aria-labelledby={titleId}>
            <button type="button" aria-label="Hide the progress screen" className="absolute inset-0 cursor-default" onClick={onDismiss} />
            <div className="relative w-full max-w-md rounded-xl border bg-card p-5 shadow-lg">
                <p id={titleId} className="text-base font-semibold">
                    {title}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">{done ? "All three passes are through. Your review is ready." : "Three passes over your answers: read, score, annotate"}</p>
                <ul className="mt-4 space-y-2.5">
                    {STAGES.map((stage, i) => (
                        <li key={stage.label} className={cn("flex items-center gap-2.5 text-sm", i > active && "text-muted-foreground")}>
                            {i < active ? (
                                <span aria-hidden className="inline-flex size-4 shrink-0 items-center justify-center text-xs text-primary">
                                    ✓
                                </span>
                            ) : i === active ? (
                                <Spinner label="Running" className="border-primary" />
                            ) : (
                                <span aria-hidden className="inline-flex size-4 shrink-0 items-center justify-center text-xs text-muted-foreground">
                                    ○
                                </span>
                            )}
                            <span className={i === active ? "font-medium" : undefined}>{stage.label}</span>
                        </li>
                    ))}
                </ul>
                <div className="mt-5 flex items-center justify-between">
                    {done ? (
                        <span role="status" className="flex items-center gap-1.5 text-sm font-medium text-primary">
                            <span aria-hidden>✓</span>
                            Done: your review is ready
                        </span>
                    ) : (
                        <Button variant="ghost" size="sm" onClick={onDismiss}>
                            Read the transcript
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}
