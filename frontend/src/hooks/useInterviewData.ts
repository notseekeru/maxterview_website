import { useCallback, useEffect, useMemo, useState } from "react";

import { type Analytics, getAnalytics, getInterviewDimensions, type Interview, type InterviewDimensions, listInterviews } from "@/lib/api";
import { isHiring } from "@/lib/interviewOptions";

// Two hooks on purpose: the list is cheap and shared, while the radar's aggregate is a request the
// History page never needs. One hook made every History visit pay for chart data it does not render.
export function useInterviews() {
    const [interviews, setInterviews] = useState<Interview[] | null>(null);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            setInterviews(await listInterviews());
            setError(null);
        } catch {
            setError("Could not load interviews.");
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const loading = interviews === null && !error;

    // Accuracy, decision and certainty are already joined into the list, so the trend and the stat
    // tiles cost no extra request; only the 1-10 dimensions need the aggregate above.
    const dims = useMemo(() => computeDims(interviews), [interviews]);

    return { interviews: interviews ?? [], loading, error, refresh, dims };
}

export function useDashboardStats() {
    const [stats, setStats] = useState<InterviewDimensions | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        getInterviewDimensions()
            .then((s) => {
                if (alive) setStats(s);
            })
            .catch(() => {
                if (alive) setError("Could not load the secondary breakdown.");
            });
        return () => {
            alive = false;
        };
    }, []);

    return { stats, error, loading: stats === null && !error };
}

export interface InterviewDims {
    total: number;
    completed: number;
    /** Subset of `completed` that carries a move review (drives avgAccuracy/accuracyTrend). */
    rated: number;
    avgAccuracy: number;
    accuracyTrend: { label: string; accuracy: number }[];
    decided: number;
    hiring: number;
    avgCertainty: number | null;
}

// Labels are built here so the chart stays a pure renderer. A repeated date gains the run time, or
// same-day runs render identical "09-09" ticks.
function trendLabel(iso: string, dateRepeats: boolean): string {
    const md = iso.slice(5, 10).replace("-", "/");
    return dateRepeats ? `${md} ${iso.slice(11, 16)}` : md;
}

function computeDims(interviews: Interview[] | null): InterviewDims {
    const list = interviews ?? [];
    // Counts status, not rated runs: a review can legitimately fail and leave completed-without-accuracy,
    // so deriving this from rated runs reads fewer than the rows show.
    const completed = list.filter((i) => i.status === "completed");
    const recent = completed.filter((i) => typeof i.accuracy === "number");
    const avgAccuracy = recent.length === 0 ? 0 : recent.reduce((a, i) => a + (i.accuracy as number), 0) / recent.length;
    // The API returns newest-first; a trend chart runs oldest to newest. "Last 20" is the 20 MOST
    // RECENT, not the tail of a newest-first array.
    const chronological = [...recent].reverse();
    const window = chronological.slice(-20);
    const dates = window.map((i) => i.created_at.slice(0, 10));
    const accuracyTrend = window.map((i) => ({ label: trendLabel(i.created_at, dates.filter((d) => d === i.created_at.slice(0, 10)).length > 1), accuracy: i.accuracy as number }));
    // Decisions are counted over their OWN denominator: an unscored or undecided run must
    // not silently count as a non-hire, and pre-decision feedback rows have no decision.
    const decided = completed.filter((i) => i.decision);
    const hiring = decided.filter((i) => isHiring(i.decision));
    const certainties = decided.map((i) => i.certainty).filter((c): c is number => typeof c === "number");
    const avgCertainty = certainties.length === 0 ? null : Math.round(certainties.reduce((a, b) => a + b, 0) / certainties.length);
    return { total: list.length, completed: completed.length, rated: recent.length, avgAccuracy, accuracyTrend, decided: decided.length, hiring: hiring.length, avgCertainty };
}

// Loaded only when the analytics route mounts: the dashboard must not pay for it, and vice versa.
// Mirrors useDashboardStats: same shape, same "no data" vs "could not load" split.
export function useAnalytics() {
    const [data, setData] = useState<Analytics | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        getAnalytics()
            .then((a) => {
                if (alive) setData(a);
            })
            .catch(() => {
                if (alive) setError("Could not load your analytics.");
            });
        return () => {
            alive = false;
        };
    }, []);

    return { data, error, loading: data === null && !error };
}
