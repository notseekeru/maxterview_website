import { ScoreTrendChart } from "@/components/ScoreTrendChart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import type { InterviewDims } from "@/hooks/useInterviewData";
import type { Feedback } from "@/lib/api";
import { cn } from "@/lib/utils";

interface Props {
    feedback: Feedback[];
    loading: boolean;
    dims: InterviewDims;
    className?: string;
}

export function DashboardStats({ loading, dims, feedback, className }: Props) {
    if (loading) {
        return (
            <div className={cn("grid grid-cols-1 gap-4 sm:grid-cols-3", className)}>
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
            </div>
        );
    }

    if (dims.total === 0) {
        return (
            <Card className={className}>
                <CardHeader>
                    <CardTitle>Performance stats</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-muted-foreground">No interviews yet — complete one to see your score history and dimension breakdown.</p>
                </CardContent>
            </Card>
        );
    }

    return (
        <div className={cn("flex h-full flex-col space-y-4", className)}>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Stat label="Interviews" value={String(dims.total)} />
                <Stat label="Completed" value={String(dims.completed)} />
                {/* A completed run can be permanently unscored (scoring failed). Say so, or
                    the average silently covers fewer runs than "Completed" claims. */}
                <Stat label="Avg score" value={dims.scored ? dims.avgScore.toFixed(1) : "—"} hint={dims.scored && dims.scored < dims.completed ? `from ${dims.scored} of ${dims.completed} scored` : undefined} />
            </div>
            <div className="grid flex-1 grid-cols-1 gap-4 content-stretch lg:grid-cols-2">
                <ScoreTrend data={dims.scoreTrend} />
                <DimensionScores feedback={feedback} />
            </div>
        </div>
    );
}

function ScoreTrend({ data }: { data: { label: string; score: number }[] }) {
    if (data.length === 0) {
        return (
            <Card className="h-full">
                <CardHeader>
                    <CardTitle className="text-sm">Score trend</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-muted-foreground">Complete an interview to unlock the score chart.</p>
                </CardContent>
            </Card>
        );
    }
    return (
        <Card className="flex h-full min-h-0 flex-col">
            <CardHeader>
                <CardTitle className="text-sm">Score trend</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 pb-2">
                <ScoreTrendChart data={data} />
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
                <p className="text-3xl font-semibold tabular-nums">{value}</p>
                {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
            </CardContent>
        </Card>
    );
}

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
            <Card className="h-full">
                <CardHeader>
                    <CardTitle className="text-sm">Dimension averages</CardTitle>
                </CardHeader>
                <CardContent>
                    <p className="text-sm text-muted-foreground">Complete an interview with feedback to unlock the dimension breakdown.</p>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card className="flex h-full min-h-0 flex-col">
            <CardHeader>
                <CardTitle className="text-sm">Dimension averages</CardTitle>
            </CardHeader>
            <CardContent className="grid flex-1 grid-cols-2 grid-rows-2 gap-3">
                {dims.map((d) => (
                    <div key={d.dimension} className="flex min-w-0 flex-col justify-between rounded-md border px-3 py-2.5">
                        <span className="truncate text-xs capitalize text-muted-foreground">{d.dimension}</span>
                        {/* At ~90px per tile the bar can only span ~63px, so 4.0 vs 5.0 is a
                            ~6px difference. The number carries the value; the bar is the cue. */}
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
