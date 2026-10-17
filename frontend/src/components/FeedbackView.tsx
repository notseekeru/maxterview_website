import { LABEL } from "@/components/PagePrimitives";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Decision, Feedback, Message, Offer } from "@/lib/api";
import { ALL_DIMS, dimLabel, groupDims } from "@/lib/dimensions";
import { MOVE_CLASSES } from "@/lib/moveClasses";
import { money } from "@/lib/offers";
import { cn } from "@/lib/utils";
import { DecisionVerdict } from "./DecisionVerdict";
import { GradeChip } from "./MoveBadge";
import { OfferLetter } from "./OfferLetter";

function tallyMoves(messages: Message[]) {
    return MOVE_CLASSES.map((meta) => ({ meta, count: messages.filter((m) => m.move_class === meta.value).length })).filter((t) => t.count > 0);
}

export function FeedbackView({ feedback, messages = [], offer, onRedo, redoing, redoError }: { feedback: Feedback; messages?: Message[]; offer?: Offer | null; onRedo?: () => void; redoing?: boolean; redoError?: string | null }) {
    // ALL dims, not just the scored ones: with ten of them a run that probed four is a normal outcome
    // (the run's dials are stated on the interview screen; the mix is why the holes are holes).
    const scores = feedback.scores ?? {};
    const dimGroups = groupDims([...ALL_DIMS, ...Object.keys(scores)]);
    // Absent for feedback written before the hire/reject columns existed, and for a run the
    // model could not decide: show nothing rather than a default verdict.
    const decision = feedback.decision as Decision | null | undefined;
    const tally = tallyMoves(messages);
    const graded = tally.reduce((n, t) => n + t.count, 0);
    const failed = typeof feedback.failed_turn === "number" ? feedback.failed_turn : null;

    return (
        <Card className={failed ? "border-destructive" : undefined}>
            <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
                <CardTitle>{failed ? "Review failed" : "Review"}</CardTitle>
                {onRedo && (
                    <div className="flex flex-col items-end gap-1">
                        <Button variant="outline" size="sm" onClick={onRedo} disabled={redoing}>
                            {redoing ? "Reviewing…" : "Redo review"}
                        </Button>
                        {/* The server's own refusal (allowance spent, model down) states itself here,
                            where the button that asked is. */}
                        {redoError && (
                            <p role="alert" className="max-w-[18rem] text-right text-[11px] text-muted-foreground">
                                {redoError}
                            </p>
                        )}
                    </div>
                )}
            </CardHeader>
            <CardContent className="space-y-4">
                {failed && (
                    <div className="space-y-1 rounded-xl border border-destructive bg-destructive/10 p-3">
                        <p className="font-semibold uppercase tracking-wide text-destructive">Hardcore: run over</p>
                        <p className="text-sm uppercase leading-relaxed">
                            One vague or wrong answer ended it: question {failed} was a {feedback.failed_class ?? "fault"}. Grade F, no second chance.
                        </p>
                    </div>
                )}
                {graded > 0 ? (
                    <div className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="flex items-center gap-3">
                                <GradeChip accuracy={feedback.accuracy} grade={feedback.grade} />
                                <span className="text-xs text-muted-foreground">
                                    {graded} answer{graded === 1 ? "" : "s"} graded
                                </span>
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
                    </div>
                ) : (
                    <div className="rounded-xl border border-dashed p-3">
                        <p className="text-xs text-muted-foreground">No answer-by-answer review for this run. The annotator couldn't classify the transcript, so there is no accuracy to report. The hiring call below is unaffected.</p>
                    </div>
                )}

                {decision && <DecisionVerdict decision={decision} certainty={feedback.certainty} />}

                <p className="text-sm leading-relaxed">{feedback.verdict}</p>

                {/* Folded onto the review because it IS the run's outcome: the letter is priced from
                    these scores, and the review is where the candidate is already looking. Collapsed by
                    default so it opens as a summary with the number, not a wall of letter. */}
                {offer && (
                    <details className="rounded-xl border">
                        <summary className="cursor-pointer px-3 py-2 text-sm font-medium hover:text-foreground">
                            Offer letter · {money(offer.base_salary)} base · {offer.tier_label}
                        </summary>
                        <div className="px-3 pb-3">
                            <OfferLetter offer={offer} />
                        </div>
                    </details>
                )}

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

                {/* Demoted: the annotations above are the review, these numbers predate them. */}
                <details>
                    <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">Secondary scores (1-10)</summary>
                    <div className="mt-3 space-y-3">
                        {dimGroups.map((group) => (
                            <div key={group.axis} className="space-y-2">
                                <p className={LABEL}>{group.label}</p>
                                {group.dims.map((key) => {
                                    const value = typeof scores[key] === "number" ? scores[key] : null;
                                    return (
                                        <div key={key} className="flex items-center gap-2">
                                            <span className="w-36 text-sm">{dimLabel(key)}</span>
                                            {value === null ? (
                                                <span className="flex-1 text-xs text-muted-foreground" title="The reviewer found no evidence for this in the transcript, so it is left unscored rather than guessed. It costs you nothing.">
                                                    not assessed
                                                </span>
                                            ) : (
                                                <>
                                                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                                                        <div className="h-full bg-primary" style={{ width: `${Math.max(0, Math.min(100, (value / 10) * 100))}%` }} />
                                                    </div>
                                                    <span className="w-6 text-right text-sm tabular-nums">{value}</span>
                                                </>
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        ))}
                    </div>
                </details>
            </CardContent>
        </Card>
    );
}
