import { useCallback, useEffect, useMemo, useState } from "react";

import { type Feedback, getFeedback, type Interview, listInterviews } from "@/lib/api";

// Single source of truth for the dashboard home: one interviews fetch + the
// per-completed-interview feedback needed for the dimension chart. Refresh once
// and push slices down as props — no duplicate listInterviews() calls.
export function useInterviewData() {
    const [interviews, setInterviews] = useState<Interview[] | null>(null);
    const [feedback, setFeedback] = useState<Feedback[]>([]);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            const list = await listInterviews();
            setInterviews(list);
            setError(null);
            const completed = list.filter((i) => i.status === "completed" && typeof i.score === "number");
            const fbs = await Promise.all(completed.map((i) => getFeedback(i.id).catch(() => null)));
            setFeedback(fbs.filter((f): f is Feedback => f !== null));
        } catch {
            setError("Could not load interviews.");
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const loading = interviews === null && !error;

    const dims = useMemo(() => computeDims(interviews), [interviews]);

    return { interviews: interviews ?? [], feedback, loading, error, refresh, dims };
}

export interface InterviewDims {
    total: number;
    completed: number;
    avgScore: number;
    scoreTrend: { label: string; score: number }[];
}

function computeDims(interviews: Interview[] | null): InterviewDims {
    const list = interviews ?? [];
    const completed = list.filter((i) => i.status === "completed" && typeof i.score === "number");
    const avgScore = completed.length === 0 ? 0 : completed.reduce((a, i) => a + (i.score as number), 0) / completed.length;
    const scoreTrend = completed
        .map((i) => ({ label: i.created_at.slice(0, 10), score: i.score as number }))
        .reverse()
        .slice(-20);
    return { total: list.length, completed: completed.length, avgScore, scoreTrend };
}
