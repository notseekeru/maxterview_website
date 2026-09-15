import { AccuracyTrendChart } from "@/components/AccuracyTrendChart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import type { InterviewDims } from "@/hooks/useInterviewData";
import type { Feedback } from "@/lib/api";

interface Props {
    feedback: Feedback[];
    loading: boolean;
    dims: InterviewDims;
}

// Full-width stats surface: a 4-up stat row, then trend + dimensions side by side. Sizes are
// VIEWPORT breakpoints on purpose — this is a top-level page, not a column inside one, so
// `xl:grid-cols-4` gives ~380px tiles instead of the ~110px it used to hand out when the same
// grid lived inside a 3/5 column of a max-w-4xl page.
export function DashboardStats({ loading, dims, feedback }: Props) {
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
                <Stat label="Completed" value={String(dims.completed)} />
                {/* A run can be permanently unrated; say so, or the average silently covers fewer runs
                    than "Completed" claims. */}
                <Stat label="Avg accuracy" value={dims.rated ? `${Math.round(dims.avgAccuracy)}%` : "—"} hint={dims.rated && dims.rated < dims.completed ? `from ${dims.rated} of ${dims.completed} rated` : undefined} />
                {/* Hire rate is over DECIDED runs only (same denominator honesty as Avg accuracy),
                    with mean certainty because 3 of 3 at 45% is not 3 of 3 at 95%. */}
                <Stat label="Hire rate" value={dims.decided === 0 ? "—" : `${Math.round((dims.hiring / dims.decided) * 100)}%`} hint={dims.decided === 0 ? "no decided runs yet" : `${dims.hiring} of ${dims.decided} decided${dims.avgCertainty === null ? "" : ` · ${dims.avgCertainty}% mean certainty`}`} />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
                <AccuracyTrend data={dims.accuracyTrend} />
                <DimensionScores feedback={feedback} />
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
                    <p className="text-sm text-muted-foreground">Complete an interview to unlock the accuracy chart.</p>
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
// the runs that reported each dimension.
const DIMENSIONS = ["clarity", "relevance", "structure", "confidence"] as const;

function avg(nums: number[]): number {
    if (nums.length === 0) return 0;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function DimensionScores({ feedback }: { feedback: Feedback[] }) {
    const dims = DIMENSIONS.map((d) => {
        const vals = feedback.map((f) => f.scores?.[d]).filter((v): v is number => typeof v === "number");
        return { dimension: d, average: Math.round(avg(vals) * 10) / 10 };
    });

    if (dims.every((d) => d.average === 0)) {
        return (
            <Card className="h-80">
                <CardHeader>
                    <CardTitle className="text-sm">Secondary scores (1-10)</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-muted-foreground">Complete an interview with a review to unlock the secondary breakdown.</p>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card className="flex h-80 flex-col">
            <CardHeader>
                <CardTitle className="text-sm">Secondary scores (1-10)</CardTitle>
            </CardHeader>
            <CardContent className="grid h-60 grid-cols-2 grid-rows-2 gap-3 pb-6">
                {dims.map((d) => (
                    <div key={d.dimension} className="flex min-w-0 flex-col justify-between rounded-md border px-3 py-2.5">
                        <span className="truncate text-xs capitalize text-muted-foreground">{d.dimension}</span>
                        {/* The number carries the value; the bar is the cue (see the removed note:
                            at ~90px per tile the bar can only span ~63px, so 4.0 vs 5.0 is ~6px). */}
                        <span className="text-3xl font-semibold leading-none tabular-nums">
                            {d.average.toFixed(1)}
                            <span className="text-sm font-normal text-muted-foreground">/10</span>
                        </span>
                        <Progress className="h-1.5" value={(d.average / 10) * 100} />
                    </div>
                ))}
            </CardContent>
        </Card>
    );
}
