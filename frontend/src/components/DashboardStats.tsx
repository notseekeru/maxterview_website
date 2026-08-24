import { ScoreTrendChart } from "@/components/ScoreTrendChart";
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

export function DashboardStats({ loading, dims, feedback }: Props) {
    if (loading) {
        return (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
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
                    <p className="text-sm text-muted-foreground">No interviews yet — complete one to see your score history and dimension breakdown.</p>
                </CardContent>
            </Card>
        );
    }

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Stat label="Interviews" value={String(dims.total)} />
                <Stat label="Completed" value={String(dims.completed)} />
                <Stat label="Avg score" value={dims.completed ? dims.avgScore.toFixed(1) : "—"} />
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <ScoreTrend data={dims.scoreTrend} />
                <DimensionScores feedback={feedback} />
            </div>
        </div>
    );
}

function ScoreTrend({ data }: { data: { label: string; score: number }[] }) {
    if (data.length === 0) {
        return (
            <Card>
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
        <Card className="flex flex-col">
            <CardHeader>
                <CardTitle className="text-sm">Score trend</CardTitle>
            </CardHeader>
            <CardContent className="flex-1 pb-2">
                <ScoreTrendChart data={data} />
            </CardContent>
        </Card>
    );
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <Card>
            <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent>
                <p className="text-3xl font-semibold tabular-nums">{value}</p>
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
            <Card>
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
        <Card>
            <CardHeader>
                <CardTitle className="text-sm">Dimension averages</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                {dims.map((d) => (
                    <div key={d.dimension} className="flex items-center gap-3">
                        <span className="w-24 shrink-0 text-xs capitalize">{d.dimension}</span>
                        <Progress value={(d.average / 10) * 100} />
                        <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{d.average.toFixed(1)}</span>
                    </div>
                ))}
            </CardContent>
        </Card>
    );
}
