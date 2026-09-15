import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Decision, Feedback, Message } from "@/lib/api";
import { MOVE_CLASSES } from "@/lib/moveClasses";
import { cn } from "@/lib/utils";
import { DecisionVerdict } from "./DecisionVerdict";
import { GradeChip } from "./MoveBadge";

/** Count the annotations by class, in ladder order (best -> worst), for the review header. */
function tallyMoves(messages: Message[]) {
    return MOVE_CLASSES.map((meta) => ({ meta, count: messages.filter((m) => m.move_class === meta.value).length })).filter((t) => t.count > 0);
}

export function FeedbackView({ feedback, messages = [], onAnnotate, annotating }: { feedback: Feedback; messages?: Message[]; onAnnotate?: () => void; annotating?: boolean }) {
    const dims = Object.entries(feedback.scores ?? {});
    // Absent for feedback written before the hire/reject columns existed, and for a run the
    // model could not decide: show nothing rather than a default verdict.
    const decision = feedback.decision as Decision | null | undefined;
    const tally = tallyMoves(messages);
    const graded = tally.reduce((n, t) => n + t.count, 0);
    const failed = typeof feedback.failed_turn === "number" ? feedback.failed_turn : null;

    return (
        <Card className={failed ? "border-destructive" : undefined}>
            <CardHeader>
                <CardTitle>{failed ? "Review — failed" : "Review"}</CardTitle>
                <CardDescription>Every answer you gave is annotated in the transcript below</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                {failed && (
                    <div className="space-y-1 rounded-lg border border-destructive bg-destructive/10 p-3">
                        <p className="font-semibold uppercase tracking-wide text-destructive">Hardcore: run over</p>
                        <p className="text-sm uppercase leading-relaxed">
                            One wrong move ended it — question {failed} was a {feedback.failed_class ?? "fault"}. Grade F, no second chance.
                        </p>
                    </div>
                )}
                {graded > 0 ? (
                    <div className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <GradeChip accuracy={feedback.accuracy} grade={feedback.grade} />
                            <span className="text-xs text-muted-foreground">
                                {graded} answer{graded === 1 ? "" : "s"} graded
                            </span>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                            {tally.map(({ meta, count }) => (
                                <span key={meta.value} title={meta.hint} className={cn("inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium", meta.tone)}>
                                    <span aria-hidden>{meta.glyph}</span>
                                    {meta.label}
                                    <span className="tabular-nums opacity-70">{count}</span>
                                </span>
                            ))}
                        </div>
                        <p className="text-xs text-muted-foreground">Accuracy is the average of those annotations, and each one is marked against the answer it graded.</p>
                    </div>
                ) : (
                    <div className="space-y-2 rounded-lg border border-dashed p-3">
                        <p className="text-xs text-muted-foreground">No answer-by-answer review for this run — the annotator couldn't classify the transcript, so there is no accuracy to report. The hiring call below is unaffected.</p>
                        {/* The annotator hop is a model call and can come back empty while the verdict
                            and tips land; the dashboard has the only other retry. */}
                        {onAnnotate && (
                            <Button variant="outline" size="sm" onClick={onAnnotate} disabled={annotating}>
                                {annotating ? "Reviewing…" : "Annotate this run"}
                            </Button>
                        )}
                    </div>
                )}

                {decision && <DecisionVerdict decision={decision} certainty={feedback.certainty} />}

                <p className="text-sm leading-relaxed">{feedback.verdict}</p>

                {Array.isArray(feedback.tips) && feedback.tips.length > 0 && (
                    <div className="space-y-1.5">
                        <p className="text-sm font-medium">Tips</p>
                        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                            {feedback.tips.map((tip) => (
                                <li key={tip}>{tip}</li>
                            ))}
                        </ul>
                    </div>
                )}

                {/* Demoted: the annotations above are the review, these four numbers predate them. */}
                {dims.length > 0 && (
                    <details>
                        <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">Secondary scores (1-10)</summary>
                        <div className="mt-3 space-y-2">
                            {dims.map(([key, value]) => (
                                <div key={key} className="flex items-center gap-2">
                                    <span className="w-28 text-sm capitalize">{key}</span>
                                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                                        <div className="h-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, (value / 10) * 100))}%` }} />
                                    </div>
                                    <span className="w-6 text-right text-sm">{value}</span>
                                </div>
                            ))}
                        </div>
                    </details>
                )}
            </CardContent>
        </Card>
    );
}
