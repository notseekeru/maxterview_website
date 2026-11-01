import { Fragment, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { AccuracyTrendChart } from "@/components/AccuracyTrendChart";
import { DecisionChip } from "@/components/DecisionVerdict";
import { LABEL, Sparkline } from "@/components/PagePrimitives";
import { Skeleton } from "@/components/ui/skeleton";
import { StateNote } from "@/components/ui/state";
import { type InterviewDims, TREND_WINDOW, useInterviews } from "@/hooks/useInterviewData";
import type { InterviewDimensions } from "@/lib/api";
import { dimShort, groupDims, orderDims } from "@/lib/dimensions";
import { cn } from "@/lib/utils";

interface Props {
    stats: InterviewDimensions | null;
    statsError?: string | null;
    loading: boolean;
    dims: InterviewDims;
}

export function DashboardStats({ loading, dims, stats, statsError }: Props) {
    if (loading) return <LoadingFrame />;
    if (statsError) return <StateNote tone="danger">{statsError}</StateNote>;

    const started = dims.total === 0;
    const finished = dims.completed > 0;
    const steps = nextSteps(dims, stats);

    return (
        <div className="space-y-4">
            <Metrics dims={dims} />
            {finished && <p className="px-1 text-xs leading-[1.6] text-muted-foreground">{readout(dims)}</p>}

            {finished ? (
                <div className="grid items-start gap-4 xl:grid-cols-12">
                    {/* Two columns only from xl: at lg the rail is 297px and the vitals and score columns
                        collide. `contents` keeps the mobile order sensible without duplicating a module. */}
                    <div className="contents xl:col-span-7 xl:flex xl:flex-col xl:gap-4">
                        <Module title="Trend" right={dims.accuracyTrend.length > 0 ? `last ${dims.accuracyTrend.length} rated` : undefined} className="order-1">
                            <div className="h-[17rem]">{dims.accuracyTrend.length === 0 ? <StateNote>Finish an interview to see the accuracy chart.</StateNote> : <AccuracyTrendChart data={dims.accuracyTrend} />}</div>
                        </Module>
                        <RecentRuns className="order-3" />
                    </div>
                    <div className="contents xl:col-span-5 xl:flex xl:flex-col xl:gap-4">
                        <Next steps={steps.length > 0 ? steps : [ALL_CLEAR]} dims={dims} finished className="order-2" />
                        <Scores stats={stats} className="order-4" />
                    </div>
                </div>
            ) : (
                <Next steps={started ? [FIRST_RUN] : [NOTHING_FINISHED]} dims={dims} finished={false} />
            )}
        </div>
    );
}

function LoadingFrame() {
    return (
        <div className="space-y-4" role="status" aria-busy="true">
            <span className="sr-only">Loading dashboard</span>
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                    <Skeleton key={i} className="h-28 rounded-none" />
                ))}
            </div>
            <div className="grid gap-4 xl:grid-cols-12">
                <div className="flex flex-col gap-4 xl:col-span-7">
                    <Skeleton className="h-[21.75rem] rounded-md" />
                    <Skeleton className="h-64 rounded-md" />
                </div>
                <div className="flex flex-col gap-4 xl:col-span-5">
                    <Skeleton className="h-44 rounded-md" />
                    <Skeleton className="h-[25rem] rounded-md" />
                </div>
            </div>
        </div>
    );
}

const CAPTION_LINK = "underline underline-offset-2 hover:text-foreground";

function Module({ title, right, className, children }: { title: string; right?: ReactNode; className?: string; children: ReactNode }) {
    return (
        <section className={cn("flex min-w-0 flex-col rounded-md border", className)}>
            <header className="flex items-baseline justify-between gap-3 border-b px-3 py-2">
                <h2 className={LABEL}>{title}</h2>
                {right && <span className={cn(LABEL, "text-muted-foreground")}>{right}</span>}
            </header>
            <div className="flex min-w-0 flex-1 flex-col p-3">{children}</div>
        </section>
    );
}

interface Cell {
    label: string;
    value: string;
    delta: ReactNode;
    spark?: number[];
    hint?: string;
}

function Metrics({ dims }: { dims: InterviewDims }) {
    const cells: Cell[] = [
        { label: "Interviews", value: String(dims.total), delta: <Delta value={dims.delta.runs} note="the 7 days before" />, spark: dims.sparks.runs },
        { label: "Finished", value: String(dims.completed), delta: <Delta value={dims.delta.finished} note="the 7 days before" />, spark: dims.sparks.finished },
        {
            label: "Avg accuracy",
            value: dims.rated ? `${Math.round(dims.avgAccuracy)}%` : "n/a",
            delta: <Delta value={dims.delta.accuracy} unit=" pts" note={`the ${TREND_WINDOW} rated runs before these`} />,
            spark: dims.sparks.accuracy,
            hint: dims.rated < dims.completed ? `${dims.rated} of ${dims.completed} rated` : undefined,
        },
        {
            label: "Hire rate",
            value: dims.decided === 0 ? "n/a" : `${Math.round((dims.hiring / dims.decided) * 100)}%`,
            delta: <Delta value={dims.delta.hire} unit=" pts" note={`the ${TREND_WINDOW} decided runs before these`} />,
            spark: dims.sparks.hire,
            hint: dims.decided > 0 ? `${dims.hiring} of ${dims.decided} decided` : undefined,
        },
    ];

    return (
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border bg-border sm:grid-cols-4">
            {cells.map((cell) => (
                <div key={cell.label} className="flex flex-col bg-background px-3 py-2.5">
                    <dt className={cn(LABEL, "text-muted-foreground")}>{cell.label}</dt>
                    <dd className="mt-1.5 flex flex-wrap items-baseline gap-x-2">
                        <span className="text-2xl leading-none font-medium tabular-nums tracking-[-0.02em]">{cell.value}</span>
                        {cell.delta}
                    </dd>
                    {cell.hint && <p className="mt-1 font-mono text-[0.6rem] tabular-nums text-muted-foreground">{cell.hint}</p>}
                    {cell.spark && (
                        <div className="mt-auto">
                            <Sparkline data={cell.spark} />
                        </div>
                    )}
                </div>
            ))}
        </dl>
    );
}

function Delta({ value, unit = "", note }: { value: number | null; unit?: string; note: string }) {
    if (value === null) return null;
    const rounded = Math.round(value);
    if (rounded === 0) return null;
    return (
        <span title={`Against ${note}.`} className="font-mono text-xs tabular-nums text-muted-foreground">
            {rounded > 0 ? "+" : "\u2212"}
            {Math.abs(rounded)}
            {unit}
            <span className="sr-only"> against {note}</span>
        </span>
    );
}

function readout(dims: InterviewDims): string {
    const d = dims.delta.accuracy;
    if (d !== null) {
        const rounded = Math.round(d);
        return Math.abs(rounded) < 3 ? `Accuracy is steady across your last ${TREND_WINDOW * 2} rated runs.` : `Accuracy is ${rounded > 0 ? "up" : "down"} ${Math.abs(rounded)} points over your last ${TREND_WINDOW * 2} rated runs.`;
    }
    const unrated = dims.completed - dims.rated;
    if (unrated > 0) return `${unrated} finished run${unrated === 1 ? "" : "s"} still ${unrated === 1 ? "needs" : "need"} a review.`;
    return `${dims.rated} of ${dims.completed} finished runs carry a review.`;
}

interface Step {
    title: string;
    body: string;
    to?: string;
    action?: string;
}

const FIRST_RUN: Step = {
    title: "No interviews yet.",
    body: "Complete one to see your accuracy history and secondary breakdown.",
    to: "#new-interview",
    action: "Start one",
};

const NOTHING_FINISHED: Step = {
    title: "No finished runs yet.",
    body: "Complete one to see your accuracy history and secondary breakdown.",
};

const ALL_CLEAR: Step = {
    title: "Nothing outstanding",
    body: "Every finished run is scored, no axis trails another by a point, and the last rated runs held.",
};

function Next({ steps, dims, finished, className }: { steps: Step[]; dims: InterviewDims; finished: boolean; className?: string }) {
    const vitals = [
        { label: "Unrated", value: String(dims.completed - dims.rated) },
        { label: "Streak", value: `${dims.streak}d` },
        { label: "7 days", value: String(dims.weekRuns) },
        { label: "Certainty", value: dims.avgCertainty === null ? "-" : `${dims.avgCertainty}%` },
    ];

    return (
        <Module title="Next" className={className}>
            <ul className="divide-y">
                {steps.map((step) => (
                    <li key={step.title} className="flex items-baseline justify-between gap-4 py-2.5 first:pt-0">
                        <div className="min-w-0">
                            <p className="text-[13px] font-medium">{step.title}</p>
                            <p className="mt-0.5 line-clamp-2 text-xs leading-[1.55] text-muted-foreground">{step.body}</p>
                        </div>
                        {step.to && step.action && <StepLink to={step.to} label={step.action} />}
                    </li>
                ))}
            </ul>
            {finished && (
                <dl className="mt-auto grid grid-cols-2 gap-x-3 gap-y-2 border-t pt-2.5 sm:grid-cols-4">
                    {vitals.map((vital) => (
                        <div key={vital.label}>
                            <dt className={cn(LABEL, "text-muted-foreground")}>{vital.label}</dt>
                            <dd className="mt-0.5 font-mono text-sm tabular-nums">{vital.value}</dd>
                        </div>
                    ))}
                </dl>
            )}
        </Module>
    );
}

function StepLink({ to, label }: { to: string; label: string }) {
    const className = cn(LABEL, "whitespace-nowrap text-muted-foreground", CAPTION_LINK);
    return to.startsWith("#") ? (
        <a href={to} className={className}>
            {label}
        </a>
    ) : (
        <Link to={to} className={className}>
            {label}
        </Link>
    );
}

const monthDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" });

function RecentRuns({ className }: { className?: string }) {
    // AI HERE: useInterviews pages 50 rows to print 5. A page-size argument on the hook is the
    // upgrade path; the slice is the ceiling, not the intent.
    const { interviews, loading, error } = useInterviews(false);
    const rows = interviews.slice(0, 5);

    return (
        <Module
            title="Recent runs"
            right={
                <Link to="/interviews" className={CAPTION_LINK}>
                    All runs
                </Link>
            }
            className={className}
        >
            {error ? (
                <StateNote tone="danger">{error}</StateNote>
            ) : loading ? (
                <Skeleton className="h-32" />
            ) : rows.length === 0 ? (
                <StateNote>No runs yet.</StateNote>
            ) : (
                <table className="w-full table-fixed text-[13px]">
                    <colgroup>
                        <col className="w-12" />
                        <col />
                        <col className="w-11" />
                        <col className="w-6" />
                        <col className="w-24" />
                    </colgroup>
                    <thead>
                        <tr className={cn(LABEL, "text-muted-foreground")}>
                            <th scope="col" className="pr-3 pb-1.5 text-left font-normal">
                                date
                            </th>
                            <th scope="col" className="pb-1.5 text-left font-normal">
                                role
                            </th>
                            <th scope="col" className="pb-1.5 text-right font-normal">
                                acc
                            </th>
                            <th scope="col" className="pb-1.5 text-right font-normal">
                                gr
                            </th>
                            <th scope="col" className="pb-1.5 text-right font-normal">
                                decision
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((run) => (
                            <tr key={run.id} className="border-t">
                                <td className="pr-3 py-1.5 font-mono text-[0.65rem] tabular-nums text-muted-foreground">{monthDay(run.created_at)}</td>
                                <th scope="row" className="py-1.5 pr-3 text-left font-normal">
                                    <Link to={`/interviews/${run.id}`} title={run.role} className="block truncate hover:underline">
                                        {run.role}
                                    </Link>
                                </th>
                                <td className="py-1.5 text-right font-mono tabular-nums">{typeof run.accuracy === "number" ? `${run.accuracy}%` : "n/a"}</td>
                                <td className="py-1.5 text-right font-mono text-muted-foreground">{run.grade ?? ""}</td>
                                <td className="py-1.5 text-right">{run.decision ? <DecisionChip decision={run.decision} /> : <span className="text-muted-foreground">-</span>}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </Module>
    );
}

function Scores({ stats, className }: { stats: InterviewDimensions | null; className?: string }) {
    const recent = stats?.recent ?? {};
    const averages = stats?.averages ?? {};
    const recentN = stats?.recent_n ?? 0;
    const groups = axisMeans(averages);

    return (
        <Module title="Scores" className={className}>
            {groups.length === 0 ? (
                <StateNote>Finish an interview with a review to see the secondary breakdown.</StateNote>
            ) : (
                <table className="w-full table-fixed text-[13px]">
                    <colgroup>
                        <col className="w-36" />
                        <col />
                        <col className="w-14" />
                        <col className="w-24" />
                    </colgroup>
                    <thead>
                        <tr className={cn(LABEL, "text-muted-foreground")}>
                            <th scope="col" className="pb-1.5 text-left font-normal">
                                dim
                            </th>
                            <th scope="col" className="pb-1.5 text-left font-normal">
                                <span className="sr-only">distribution</span>
                            </th>
                            <th scope="col" className="pr-3 pb-1.5 text-right font-normal whitespace-nowrap">
                                avg
                            </th>
                            <th scope="col" className="pb-1.5 text-right font-normal whitespace-nowrap">
                                last {recentN} runs
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {groups.map((group) => (
                            <Fragment key={group.axis}>
                                <tr className="border-t">
                                    <th scope="colgroup" colSpan={4} className={cn(LABEL, "pt-2 pb-1 text-left font-normal text-muted-foreground")}>
                                        {group.label}
                                        <span className="ml-2 font-mono text-[0.65rem] tracking-normal text-foreground">{group.mean === null ? "" : group.mean.toFixed(1)}</span>
                                    </th>
                                </tr>
                                {group.dims.map((d) => {
                                    const mean = averages[d];
                                    return (
                                        <tr key={d}>
                                            <th scope="row" className="py-0.5 pr-3 text-left font-normal text-muted-foreground">
                                                {dimShort(d)}
                                            </th>
                                            <td aria-hidden className="py-0.5 pr-3">
                                                <ScoreBar value={mean} />
                                            </td>
                                            <td className="pr-3 py-0.5 text-right font-mono text-[0.65rem] tabular-nums">{fixed(mean)}</td>
                                            <td className="py-0.5 text-right font-mono text-[0.65rem] tabular-nums text-muted-foreground">{fixed(recent[d])}</td>
                                        </tr>
                                    );
                                })}
                            </Fragment>
                        ))}
                    </tbody>
                </table>
            )}
        </Module>
    );
}

const fixed = (v: number | undefined) => (typeof v === "number" ? v.toFixed(1) : "-");

function ScoreBar({ value }: { value?: number }) {
    if (typeof value !== "number") return null;
    return (
        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-foreground/75" style={{ width: `${Math.max(0, Math.min(100, (value / 10) * 100))}%` }} />
        </div>
    );
}

function avg(nums: number[]): number {
    if (nums.length === 0) return 0;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function axisMeans(averages: Record<string, number>): { axis: string; label: string; dims: string[]; mean: number | null }[] {
    return groupDims(orderDims(Object.keys(averages))).map((group) => {
        const values = group.dims.map((d) => averages[d]).filter((v): v is number => typeof v === "number");
        return { axis: group.axis, label: group.label, dims: group.dims, mean: values.length === 0 ? null : avg(values) };
    });
}

const SLIP_PTS = 5;

function nextSteps(dims: InterviewDims, stats: InterviewDimensions | null): Step[] {
    const steps: Step[] = [];
    const unrated = dims.completed - dims.rated;
    if (unrated > 0) {
        steps.push({ title: `${unrated} finished run${unrated === 1 ? "" : "s"} without a review`, body: "Scoring can fail on its own. Retry review on the row runs it again.", to: "/interviews", action: "Retry the review" });
    }
    if (dims.delta.accuracy !== null && dims.delta.accuracy <= -SLIP_PTS) {
        steps.push({ title: "Act on the newest reviews", body: `Accuracy came in ${Math.abs(Math.round(dims.delta.accuracy))} points under the runs before it. The last ${TREND_WINDOW} transcripts name the turns that cost it.`, to: "/interviews", action: "Read the reviews" });
    }
    const spread = axisSpread(stats);
    if (spread && spread.gap >= 1) {
        steps.push({ title: `${spread.weak.label} is trailing`, body: `${spread.weak.mean.toFixed(1)}/10 against ${spread.best.mean.toFixed(1)}/10 for ${spread.best.label.toLowerCase()}.`, to: "#new-interview", action: "Start a run" });
    }
    if (dims.lastRunDays !== null && dims.lastRunDays >= 7) {
        steps.push({ title: "A week without a run", body: `Your last one was ${dims.lastRunDays} days ago.`, to: "#new-interview", action: "Start a run" });
    }
    return steps.slice(0, 3);
}

function axisSpread(stats: InterviewDimensions | null): { best: { label: string; mean: number }; weak: { label: string; mean: number }; gap: number } | null {
    if (!stats) return null;
    const rows = axisMeans(stats.averages).filter((row): row is { axis: string; label: string; dims: string[]; mean: number } => row.mean !== null);
    if (rows.length < 2) return null;
    const sorted = [...rows].sort((a, b) => a.mean - b.mean);
    const weak = sorted[0];
    const best = sorted[sorted.length - 1];
    return { best, weak, gap: best.mean - weak.mean };
}
