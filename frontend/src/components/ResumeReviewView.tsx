import { useState } from "react";
import { LABEL } from "@/components/PagePrimitives";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { ResumeReview } from "@/lib/api";
import { levelLabel } from "@/lib/interviewOptions";
import { cn } from "@/lib/utils";

type Rung = ResumeReview["levels"][number];

const CALL: Record<string, { label: string; tone: string; glyph: string }> = {
    passes: { label: "Passes", tone: "border-primary/40 bg-primary/10 text-primary", glyph: "✓" },
    close: { label: "Close", tone: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400", glyph: "~" },
    fails: { label: "Fails", tone: "border-destructive/40 bg-destructive/10 text-destructive", glyph: "✕" },
};

const SECTION: Record<string, { label: string; tone: string }> = {
    strong: { label: "Strong", tone: CALL.passes.tone },
    fine: { label: "Fine", tone: "border-input text-muted-foreground" },
    weak: { label: "Weak", tone: CALL.close.tone },
    bloat: { label: "Bloat", tone: CALL.fails.tone },
};

function Chip({ call, meta }: { call: string; meta: Record<string, { label: string; tone: string }> }) {
    const tone = meta[call];
    return <span className={cn("rounded-md border px-1.5 py-0.5 text-[11px] font-medium", tone?.tone ?? "border-input text-muted-foreground")}>{tone?.label ?? call}</span>;
}

function RungCard({ level }: { level: Rung }) {
    return (
        <div className="space-y-1.5 rounded-xl border p-3">
            <div className="flex items-center justify-between gap-2">
                <span className={LABEL}>{levelLabel(level.level)}</span>
                <Chip call={level.call} meta={CALL} />
            </div>
            <p className="text-sm leading-snug">{level.thinks}</p>
            {level.move && (
                <p className="flex gap-1.5 text-xs leading-snug text-muted-foreground">
                    <span aria-hidden className="text-foreground/60">
                        →
                    </span>
                    {level.move}
                </p>
            )}
        </div>
    );
}

function CopyLine({ text }: { text: string }) {
    const [copied, setCopied] = useState(false);
    return (
        <button
            type="button"
            onClick={() =>
                void navigator.clipboard.writeText(text).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                })
            }
            className="shrink-0 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
            {copied ? "Copied" : "Copy"}
        </button>
    );
}

export function ResumeReviewView({ review, busy, error, disabled, onReview }: { review: ResumeReview | null; busy: boolean; error: string | null; disabled: boolean; onReview: () => void }) {
    // One band by default, the one the page reads at; the rest of the ladder stays one click away so
    // the comparison is still there without a wall of cards. A new review arrives under a new key
    // from the page, which drops the pick.
    const [focus, setFocus] = useState<string | null>(null);
    const [all, setAll] = useState(false);

    const active = review ? (focus ?? review.reads_at ?? review.levels[0]?.level ?? null) : null;
    const focused = review?.levels.find((level) => level.level === active) ?? null;

    return (
        // The rung grid stacks on its own width, not the viewport's: the card is half the page here and
        // the whole page below lg, so a `sm:` breakpoint would go two-up exactly where it cannot fit.
        <Card className="@container flex min-h-0 flex-col">
            <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
                <CardTitle>Review</CardTitle>
                <div className="flex flex-col items-end gap-1">
                    <Button variant="outline" size="sm" disabled={disabled || busy} onClick={onReview}>
                        {busy ? "Reviewing…" : review ? "Re-review" : "Review resume"}
                    </Button>
                    {error && (
                        <p role="alert" className="max-w-[18rem] text-right text-[11px] text-muted-foreground">
                            {error}
                        </p>
                    )}
                </div>
            </CardHeader>

            {review && (
                <CardContent className="min-h-0 flex-1 space-y-4 overflow-y-auto">
                    <div className="flex flex-wrap items-center gap-2">
                        <span className={LABEL}>Reads at</span>
                        <span className="rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">{review.reads_at ? levelLabel(review.reads_at) : "No band yet"}</span>
                    </div>

                    <p className="text-sm leading-relaxed">{review.verdict}</p>

                    <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap gap-1">
                            {review.levels.map((level) => {
                                const meta = CALL[level.call];
                                const on = !all && level.level === active;
                                return (
                                    <button
                                        key={level.level}
                                        type="button"
                                        aria-pressed={on}
                                        aria-label={`${levelLabel(level.level)}: ${meta?.label ?? level.call}`}
                                        onClick={() => {
                                            setAll(false);
                                            setFocus(level.level);
                                        }}
                                        className={cn(
                                            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
                                            level.call === "passes" ? "text-primary" : level.call === "close" ? "text-amber-700 dark:text-amber-400" : "text-destructive",
                                            on ? "border-current bg-current/10 font-semibold" : "border-input hover:border-current",
                                        )}
                                    >
                                        {levelLabel(level.level)}
                                        <span aria-hidden>{meta?.glyph ?? "•"}</span>
                                    </button>
                                );
                            })}
                        </div>
                        <button type="button" onClick={() => setAll((value) => !value)} className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
                            {all ? "One level" : "All levels"}
                        </button>
                    </div>

                    {all ? (
                        <div className="grid gap-2 @lg:grid-cols-2">
                            {review.levels.map((level) => (
                                <RungCard key={level.level} level={level} />
                            ))}
                        </div>
                    ) : (
                        focused && <RungCard level={focused} />
                    )}

                    {review.rewrites.length > 0 && (
                        <div className="space-y-1.5">
                            <p className={LABEL}>Rewrites</p>
                            <ul className="divide-y rounded-xl border">
                                {review.rewrites.map((line) => (
                                    <li key={line.source} className="space-y-1 px-3 py-2">
                                        <p className="text-xs leading-snug text-muted-foreground line-through">{line.source}</p>
                                        <div className="flex items-start justify-between gap-3">
                                            <p className="text-sm leading-snug">{line.rewrite}</p>
                                            <CopyLine text={line.rewrite} />
                                        </div>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}

                    <div className="space-y-1.5">
                        <p className={LABEL}>Sections</p>
                        <ul className="divide-y rounded-xl border">
                            {review.sections.map((section) => (
                                <li key={section.name} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-sm">
                                    <span className="w-32 font-medium">{section.name}</span>
                                    <Chip call={section.call} meta={SECTION} />
                                    <span className="min-w-0 flex-1 text-muted-foreground">{section.note}</span>
                                </li>
                            ))}
                        </ul>
                    </div>

                    <div className="space-y-1.5">
                        <p className={LABEL}>Next edits</p>
                        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
                            {review.tips.map((tip) => (
                                <li key={tip}>{tip}</li>
                            ))}
                        </ol>
                    </div>
                </CardContent>
            )}
        </Card>
    );
}
