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
    /** Every interview with status 'completed', whether or not scoring succeeded. */
    completed: number;
    /** Subset of `completed` that has a persisted score (drives avgScore/scoreTrend). */
    scored: number;
    avgScore: number;
    scoreTrend: { label: string; score: number }[];
}

// Axis labels are built here (not in the chart) so the chart stays a pure renderer.
// When a date repeats the label gains the run time — same-day runs would otherwise
// render identical "09-09" ticks.
function trendLabel(iso: string, dateRepeats: boolean): string {
    const md = iso.slice(5, 10).replace("-", "/");
    return dateRepeats ? `${md} ${iso.slice(11, 16)}` : md;
}

function computeDims(interviews: Interview[] | null): InterviewDims {
    const list = interviews ?? [];
    // `completed` counts what the History rows label "completed" (status only). Scoring
    // can legitimately fail (scores schema/outage) leaving completed-without-score, so
    // do NOT derive this tile from scored runs — it then reads fewer than the rows show.
    const completed = list.filter((i) => i.status === "completed");
    const recent = completed.filter((i) => typeof i.score === "number");
    const avgScore = recent.length === 0 ? 0 : recent.reduce((a, i) => a + (i.score as number), 0) / recent.length;
    const window = recent.slice(-20);
    const dates = window.map((i) => i.created_at.slice(0, 10));
    const scoreTrend = window.map((i) => ({ label: trendLabel(i.created_at, dates.filter((d) => d === i.created_at.slice(0, 10)).length > 1), score: i.score as number }));
    return { total: list.length, completed: completed.length, scored: recent.length, avgScore, scoreTrend };
}
