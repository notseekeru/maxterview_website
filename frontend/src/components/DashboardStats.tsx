import { Link } from "react-router-dom";
import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart } from "recharts";

import { AccuracyTrendChart } from "@/components/AccuracyTrendChart";
import { Panel, SectionHeading, Stat } from "@/components/PagePrimitives";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { StateNote } from "@/components/ui/state";
import { type InterviewDims, TREND_WINDOW } from "@/hooks/useInterviewData";
import type { InterviewDimensions } from "@/lib/api";
import { dimShort, groupDims, orderDims } from "@/lib/dimensions";

interface Props {
    stats: InterviewDimensions | null;
    statsError?: string | null;
    loading: boolean;
    dims: InterviewDims;
}

export function DashboardStats({ loading, dims, stats, statsError }: Props) {
    if (loading) {
        return (
            <div className="space-y-4" aria-busy="true">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    {[0, 1, 2, 3].map((i) => (
                        <Skeleton key={i} className="h-28" />
                    ))}
                </div>
                <div className="grid gap-4 lg:grid-cols-2">
                    <Skeleton className="h-80" />
                    <Skeleton className="h-80" />
                </div>
            </div>
        );
    }

    if (dims.total === 0) {
        return (
            <Card>
                <CardHeader>
                    <CardTitle>Performance stats</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                    <StateNote>No interviews yet. Complete one to see your accuracy history and secondary breakdown.</StateNote>
                    <Button asChild size="sm" variant="outline">
                        <a href="#new-interview">Start one</a>
                    </Button>
                </CardContent>
            </Card>
        );
    }

    return (
        <div className="space-y-8">
            <section className="space-y-4">
                <SectionHeading title="Overview" hint="Every run you have started, archived ones included." />
                <StatRow dims={dims} />
                <p className="text-sm leading-[1.75] text-muted-foreground">{readout(dims)}</p>
            </section>

            <section className="space-y-4">
                <SectionHeading title="Trajectory" hint="What the reviews say about how you answer." />
                <div className="grid gap-4 lg:grid-cols-2">
                    <AccuracyTrend data={dims.accuracyTrend} />
                    <DimensionScores stats={stats} error={statsError} />
                </div>
            </section>

            <section className="space-y-4">
                <SectionHeading title="Next steps" hint="Drawn from the numbers above." />
                <NextSteps dims={dims} stats={stats} />
            </section>
        </div>
    );
}

function StatRow({ dims }: { dims: InterviewDims }) {
    const { delta } = dims;
    return (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="Interviews" value={String(dims.total)} delta={<Delta value={delta.runs} note="the 7 days before" />} spark={dims.sparks.runs} hint={`${dims.weekRuns} in the last 7 days`} />
            {/* A run can stay open forever; the count of them is the difference the finished count
                does not show. */}
            <Stat label="Finished" value={String(dims.completed)} delta={<Delta value={delta.finished} note="the 7 days before" />} spark={dims.sparks.finished} hint={dims.completed === dims.total ? "every run is finished" : `${dims.total - dims.completed} still open`} />
            {/* A run can be permanently unrated; say so, or the average silently covers fewer runs
                than "Finished" claims. */}
            <Stat
                label="Avg accuracy"
                value={dims.rated ? `${Math.round(dims.avgAccuracy)}%` : "n/a"}
                delta={<Delta value={delta.accuracy} unit=" pts" note={`the ${TREND_WINDOW} rated runs before these`} />}
                spark={dims.sparks.accuracy}
                hint={dims.rated ? `from ${dims.rated} of ${dims.completed} finished` : "nothing rated yet"}
            />
            {/* Hire rate is over DECIDED runs only (same denominator honesty as Avg accuracy),
                with mean certainty because 3 of 3 at 45% is not 3 of 3 at 95%. */}
            <Stat
                label="Hire rate"
                value={dims.decided === 0 ? "n/a" : `${Math.round((dims.hiring / dims.decided) * 100)}%`}
                delta={<Delta value={delta.hire} unit=" pts" note={`the ${TREND_WINDOW} decided runs before these`} />}
                spark={dims.sparks.hire}
                hint={dims.decided === 0 ? "no decided runs yet" : `${dims.hiring} of ${dims.decided} decided${dims.avgCertainty === null ? "" : ` · ${dims.avgCertainty}% mean certainty`}`}
            />
        </div>
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
        </span>
    );
}

function readout(dims: InterviewDims): string {
    const facts: string[] = [];
    if (dims.delta.accuracy !== null) {
        const d = Math.round(dims.delta.accuracy);
        facts.push(Math.abs(d) < 3 ? `Accuracy is steady across your last ${TREND_WINDOW * 2} rated runs.` : `Accuracy is ${d > 0 ? "up" : "down"} ${Math.abs(d)} points over your last ${TREND_WINDOW} rated runs.`);
    }
    const unrated = dims.completed - dims.rated;
    if (unrated > 0) facts.push(`${unrated} finished run${unrated === 1 ? "" : "s"} still ${unrated === 1 ? "needs" : "need"} a review.`);
    else if (dims.avgCertainty !== null && dims.avgCertainty < 60 && dims.decided >= TREND_WINDOW) facts.push(`Hire calls are landing on ${dims.avgCertainty}% mean certainty.`);
    if (facts.length === 0) facts.push(`${dims.rated} of ${dims.completed} finished runs carry a review.`);
    return facts.slice(0, 2).join(" ");
}

interface Step {
    title: string;
    body: string;
    to?: string;
    action?: string;
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
    const rows = groupDims(orderDims(Object.keys(stats.averages)))
        .map((group) => {
            const values = group.dims.map((d) => stats.averages[d]).filter((v): v is number => typeof v === "number");
            return { label: group.label, mean: values.length === 0 ? null : avg(values) };
        })
        .filter((row): row is { label: string; mean: number } => row.mean !== null);
    if (rows.length < 2) return null;
    const sorted = [...rows].sort((a, b) => a.mean - b.mean);
    const weak = sorted[0];
    const best = sorted[sorted.length - 1];
    return { best, weak, gap: best.mean - weak.mean };
}

function NextSteps({ dims, stats }: { dims: InterviewDims; stats: InterviewDimensions | null }) {
    const steps = nextSteps(dims, stats);
    return (
        <Card>
            <CardContent className="pt-6">
                {steps.length === 0 ? (
                    <StateNote>Nothing outstanding: every finished run is scored, no axis trails another by a point, and the last rated runs held.</StateNote>
                ) : (
                    <ul className="divide-y">
                        {steps.map((step) => (
                            <li key={step.title} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3 first:pt-0 last:pb-0">
                                <div className="space-y-0.5">
                                    <p className="text-sm font-medium">{step.title}</p>
                                    <p className="max-w-[76ch] text-sm leading-[1.7] text-muted-foreground">{step.body}</p>
                                </div>
                                {step.to && step.action && <StepLink to={step.to} label={step.action} />}
                            </li>
                        ))}
                    </ul>
                )}
            </CardContent>
        </Card>
    );
}

function StepLink({ to, label }: { to: string; label: string }) {
    const className = "shrink-0 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground";
    // A section anchor is a same-page jump; a path is a route, and a full reload would drop the SPA.
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

function AccuracyTrend({ data }: { data: { label: string; accuracy: number }[] }) {
    const hint = data.length === 0 ? "one point per rated run, oldest to newest" : `your last ${data.length} rated run${data.length === 1 ? "" : "s"}, oldest to newest`;
    return (
        <Panel title="Accuracy trend" hint={hint} className="h-80">
            {data.length === 0 ? (
                <StateNote>Finish an interview to unlock the accuracy chart.</StateNote>
            ) : (
                // h-full, not a fixed height: the card is h-80 and the hint above takes a line of it.
                <div className="h-full">
                    <AccuracyTrendChart data={data} />
                </div>
            )}
        </Panel>
    );
}

const RADAR_CONFIG: ChartConfig = {
    recent: { label: "Recent runs", color: "var(--chart-1)" },
    average: { label: "All-time average", color: "var(--chart-2)" },
};

function avg(nums: number[]): number {
    if (nums.length === 0) return 0;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function DimensionScores({ stats, error }: { stats: InterviewDimensions | null; error?: string | null }) {
    const averages = stats?.averages ?? {};
    const recent = stats?.recent ?? {};
    const recent_n = stats?.recent_n ?? 0;
    const scored = orderDims(Object.keys(averages));
    const data = scored.map((d) => ({ dim: dimShort(d), recent: typeof recent[d] === "number" ? recent[d] : null, average: averages[d] }));

    if (data.length === 0) {
        return (
            <Panel title="Secondary scores" hint="mean per dimension, 1-10" className="h-80">
                <StateNote>{error ?? "Finish an interview with a review to unlock the secondary breakdown."}</StateNote>
            </Panel>
        );
    }

    return (
        <Panel title="Secondary scores" hint={`mean per dimension, 1-10 · ${stats?.count ?? 0} scored run${stats?.count === 1 ? "" : "s"}`} className="h-80">
            <div className="flex h-full flex-col gap-1">
                <ChartContainer config={RADAR_CONFIG} className="min-h-0 w-full grow">
                    {/* outerRadius < 100%: the ten tick labels sit outside the polygon and would clip. */}
                    <RadarChart data={data} outerRadius="68%">
                        <PolarGrid />
                        <PolarAngleAxis dataKey="dim" tick={{ fontSize: 10 }} />
                        {/* 0-10, not 1-10: the floor of the scale is the centre, or a 6 reads as a 5.5. */}
                        <PolarRadiusAxis domain={[0, 10]} tick={false} axisLine={false} />
                        <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                        {/* Recent paints over the all-time average. A dim neither series scored is
                            null, which leaves a gap - plotting 0 would read as a bad score. */}
                        <Radar name="recent" dataKey="recent" stroke="var(--color-recent)" strokeWidth={2} fill="var(--color-recent)" fillOpacity={0.15} />
                        <Radar name="average" dataKey="average" stroke="var(--color-average)" strokeWidth={1.5} fill="var(--color-average)" fillOpacity={0.25} />
                    </RadarChart>
                </ChartContainer>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {groupDims(scored).map((group) => (
                        <span key={group.axis}>
                            {group.label} <span className="font-medium tabular-nums text-foreground">{round1(avg(group.dims.map((d) => averages[d]))).toFixed(1)}</span>
                        </span>
                    ))}
                    <span className="ml-auto inline-flex items-center gap-3">
                        <span className="inline-flex items-center gap-1">
                            <span className="h-2 w-2 rounded-full bg-[var(--chart-1)]" /> last {recent_n}
                        </span>
                        <span className="inline-flex items-center gap-1">
                            <span className="h-2 w-2 rounded-full bg-[var(--chart-2)]" /> all {stats?.count ?? 0}
                        </span>
                    </span>
                </div>
            </div>
        </Panel>
    );
}
