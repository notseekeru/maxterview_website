import { PolarAngleAxis, PolarGrid, PolarRadiusAxis, Radar, RadarChart } from "recharts";

import { AccuracyTrendChart } from "@/components/AccuracyTrendChart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import type { InterviewDims } from "@/hooks/useInterviewData";
import type { InterviewDimensions } from "@/lib/api";
import { dimShort, groupDims, orderDims } from "@/lib/dimensions";

interface Props {
    /** One aggregate (backend models.InterviewDimensions), not a Feedback per rated run. Null until
     *  it lands; `statsError` is the separate failure line, so "no data" and "could not load" differ. */
    stats: InterviewDimensions | null;
    statsError?: string | null;
    loading: boolean;
    dims: InterviewDims;
}

// Full-width stats surface: a 4-up stat row, then trend + dimensions side by side. Sizes are
// VIEWPORT breakpoints on purpose — this is a top-level page, not a column inside one, so
// `xl:grid-cols-4` gives ~380px tiles instead of the ~110px it used to hand out when the same
// grid lived inside a 3/5 column of a max-w-4xl page.
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
                <CardContent>
                    <p className="text-sm text-muted-foreground">No interviews yet — complete one to see your accuracy history and secondary breakdown.</p>
                </CardContent>
            </Card>
        );
    }

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Stat label="Interviews" value={String(dims.total)} />
                <Stat label="Finished" value={String(dims.completed)} />
                {/* A run can be permanently unrated; say so, or the average silently covers fewer runs
                    than "Finished" claims. */}
                <Stat label="Avg accuracy" value={dims.rated ? `${Math.round(dims.avgAccuracy)}%` : "—"} hint={dims.rated && dims.rated < dims.completed ? `from ${dims.rated} of ${dims.completed} rated` : undefined} />
                {/* Hire rate is over DECIDED runs only (same denominator honesty as Avg accuracy),
                    with mean certainty because 3 of 3 at 45% is not 3 of 3 at 95%. */}
                <Stat label="Hire rate" value={dims.decided === 0 ? "—" : `${Math.round((dims.hiring / dims.decided) * 100)}%`} hint={dims.decided === 0 ? "no decided runs yet" : `${dims.hiring} of ${dims.decided} decided${dims.avgCertainty === null ? "" : ` · ${dims.avgCertainty}% mean certainty`}`} />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
                <AccuracyTrend data={dims.accuracyTrend} />
                <DimensionScores stats={stats} error={statsError} />
            </div>
        </div>
    );
}

function AccuracyTrend({ data }: { data: { label: string; accuracy: number }[] }) {
    if (data.length === 0) {
        return (
            <Card className="h-80">
                <CardHeader>
                    <CardTitle className="text-sm">Accuracy trend</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-muted-foreground">Finish an interview to unlock the accuracy chart.</p>
                </CardContent>
            </Card>
        );
    }
    return (
        <Card className="flex h-80 flex-col">
            <CardHeader>
                <CardTitle className="text-sm">Accuracy trend</CardTitle>
            </CardHeader>
            {/* Fixed content height: ResponsiveContainer needs a definite box, and h-80 minus the
                header keeps both cards in the row the same size. */}
            <CardContent className="h-60 pb-6">
                <AccuracyTrendChart data={data} />
            </CardContent>
        </Card>
    );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <Card>
            <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent>
                <p className="text-4xl font-semibold tabular-nums">{value}</p>
                {hint && <p className="mt-1.5 text-xs text-muted-foreground">{hint}</p>}
            </CardContent>
        </Card>
    );
}

// The 1-10 dimensions, now secondary (backend app/rating.py owns the primary reading). Averaged over
// the runs that reported each dimension; a dimension nobody probed is simply absent (see the
// "not assessed" reading in lib/dimensions.ts), never a zero.
const RADAR_CONFIG: ChartConfig = {
    latest: { label: "Latest run", color: "var(--chart-1)" },
    average: { label: "Average", color: "var(--chart-2)" },
};

function avg(nums: number[]): number {
    if (nums.length === 0) return 0;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// Radar, not tiles: ten 1-10 dims is where a tile grid stops reading, and a polygon shows the SHAPE
// of the run - a collapsed substance axis is one glance, not ten numbers to compare. The exact
// values it cannot give are the per-axis rollup underneath (and the full list in the review page).
function DimensionScores({ stats, error }: { stats: InterviewDimensions | null; error?: string | null }) {
    // The server owns both the averaging (over the runs that scored a dimension) and the rounding;
    // this component only re-keys them for the radar.
    const averages = stats?.averages ?? {};
    const latest = stats?.latest ?? {};
    const scored = orderDims(Object.keys(averages));
    const data = scored.map((d) => ({ dim: dimShort(d), latest: typeof latest[d] === "number" ? latest[d] : null, average: averages[d] }));

    if (data.length === 0) {
        return (
            <Card className="h-80">
                <CardHeader>
                    <CardTitle className="text-sm">Secondary scores (1-10)</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-muted-foreground">{error ?? "Finish an interview with a review to unlock the secondary breakdown."}</p>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card className="flex h-80 flex-col">
            <CardHeader>
                <CardTitle className="text-sm">Secondary scores (1-10)</CardTitle>
            </CardHeader>
            <CardContent className="flex h-60 flex-col gap-1 pb-6">
                <ChartContainer config={RADAR_CONFIG} className="min-h-0 w-full grow">
                    {/* outerRadius < 100%: the ten tick labels sit outside the polygon and would clip. */}
                    <RadarChart data={data} outerRadius="68%">
                        <PolarGrid />
                        <PolarAngleAxis dataKey="dim" tick={{ fontSize: 10 }} />
                        {/* 0-10, not 1-10: the floor of the scale is the centre, or a 6 reads as a 5.5. */}
                        <PolarRadiusAxis domain={[0, 10]} tick={false} axisLine={false} />
                        <ChartTooltip content={<ChartTooltipContent indicator="line" />} />
                        {/* Latest paints over the average. A dim the newest run was not assessed on is
                            null, which leaves a gap - plotting 0 would read as a bad score. */}
                        <Radar name="latest" dataKey="latest" stroke="var(--color-latest)" fill="var(--color-latest)" fillOpacity={0.1} />
                        <Radar name="average" dataKey="average" stroke="var(--color-average)" fill="var(--color-average)" fillOpacity={0.25} />
                    </RadarChart>
                </ChartContainer>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {groupDims(scored).map((group) => (
                        <span key={group.axis}>
                            {group.label} <span className="font-medium tabular-nums text-foreground">{round1(avg(group.dims.map((d) => averages[d]))).toFixed(1)}</span>
                        </span>
                    ))}
                    <span className="ml-auto inline-flex items-center gap-1">
                        <span className="h-2 w-2 rounded-full bg-[var(--chart-1)]" /> latest
                        <span className="ml-1.5 h-2 w-2 rounded-full bg-[var(--chart-2)]" /> avg of {stats?.count ?? 0}
                    </span>
                </div>
            </CardContent>
        </Card>
    );
}
