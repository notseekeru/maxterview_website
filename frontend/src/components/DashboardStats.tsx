import { useEffect, useMemo, useState } from "react";
import { ScoreTrendChart } from "@/components/ScoreTrendChart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { type Feedback, getFeedback, type Interview, listInterviews } from "@/lib/api";

const DIMENSIONS = ["clarity", "relevance", "structure", "confidence"] as const;

function avg(nums: number[]): number {
    if (nums.length === 0) return 0;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function DashboardStats() {
    const [interviews, setInterviews] = useState<Interview[] | null>(null);
    const [feedback, setFeedback] = useState<Feedback[]>([]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const list = await listInterviews();
                if (cancelled) return;
                setInterviews(list);
                // Per-dimension bars need per-interview feedback; fetch in parallel for completed ones.
                const completed = list.filter((i) => i.status === "completed" && typeof i.score === "number");
                const fbs = await Promise.all(completed.map((i) => getFeedback(i.id).catch(() => null)));
                if (!cancelled) setFeedback(fbs.filter((f): f is Feedback => f !== null));
            } catch {
                if (!cancelled) setInterviews([]);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    const { total, completed, avgScore } = useMemo(() => {
        const list = interviews ?? [];
        const done = list.filter((i) => i.status === "completed" && typeof i.score === "number");
        return { total: list.length, completed: done.length, avgScore: avg(done.map((i) => i.score as number)) };
    }, [interviews]);

    const trend = useMemo(() => {
        const done = (interviews ?? [])
            .filter((i) => i.status === "completed" && typeof i.score === "number")
            .map((i) => ({ label: i.created_at.slice(0, 10), score: i.score as number }))
            .reverse(); // list is newest-first; chart reads oldest->newest
        return done.slice(-20);
    }, [interviews]);

    const dimensionAverages = useMemo(() => {
        const dims: Record<string, number[]> = {};
        for (const dim of DIMENSIONS) dims[dim] = [];
        for (const fb of feedback) {
            for (const dim of DIMENSIONS) {
                const v = fb.scores?.[dim];
                if (typeof v === "number") dims[dim].push(v);
            }
        }
        return DIMENSIONS.map((d) => ({ dimension: d, average: Math.round(avg(dims[d]) * 10) / 10 }));
    }, [feedback]);

    if (interviews === null) {
        return (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
                <Skeleton className="h-24" />
            </div>
        );
    }

    if (total === 0) {
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
                <Stat label="Interviews" value={String(total)} />
                <Stat label="Completed" value={String(completed)} />
                <Stat label="Avg score" value={completed ? avgScore.toFixed(1) : "—"} />
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <ScoreTrend data={trend} />
                <DimensionScores data={dimensionAverages} />
            </div>
        </div>
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

function ScoreTrend({ data }: { data: { label: string; score: number }[] }) {
    if (data.length === 0) return <ChartCard title="Score trend" empty="Complete an interview to unlock the score chart." />;
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

function ChartCard({ title, empty }: { title: string; empty: string }) {
    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-sm">{title}</CardTitle>
            </CardHeader>
            <CardContent>
                <p className="text-sm text-muted-foreground">{empty}</p>
            </CardContent>
        </Card>
    );
}

function DimensionScores({ data }: { data: { dimension: string; average: number }[] }) {
    const hasData = data.some((d) => d.average > 0);
    if (!hasData) return <ChartCard title="Dimension averages" empty="Complete an interview with feedback to unlock the dimension breakdown." />;
    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-sm">Dimension averages</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
                {data.map((d) => (
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
