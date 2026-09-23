import { useCallback, useEffect, useMemo, useState } from "react";

import { type Analytics, getAnalytics, getInterviewDimensions, type Interview, type InterviewDimensions, listInterviews } from "@/lib/api";
import { isHiring } from "@/lib/interviewOptions";

// Dashboard data, in two hooks on purpose: the list (and everything derived from it) is cheap and
// shared, while the radar's dimension aggregate is a separate request the History page never needs.
// One hook for both made every History visit pay for chart data it does not render.
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

// Axis labels are built here (not in the chart) so the chart stays a pure renderer.
// When a date repeats the label gains the run time — same-day runs would otherwise
// render identical "09-09" ticks.
function trendLabel(iso: string, dateRepeats: boolean): string {
    const md = iso.slice(5, 10).replace("-", "/");
    return dateRepeats ? `${md} ${iso.slice(11, 16)}` : md;
}

function computeDims(interviews: Interview[] | null): InterviewDims {
    const list = interviews ?? [];
    // `completed` counts what the History rows label "completed" (status only). The review can
    // legitimately fail (no model, or an unclassifiable transcript) leaving completed-without-
    // accuracy, so do NOT derive this tile from rated runs — it then reads fewer than the rows show.
    const completed = list.filter((i) => i.status === "completed");
    const recent = completed.filter((i) => typeof i.accuracy === "number");
    const avgAccuracy = recent.length === 0 ? 0 : recent.reduce((a, i) => a + (i.accuracy as number), 0) / recent.length;
    // GET /interviews is ordered created_at DESC, so `recent` is newest-first. A trend chart has
    // to run oldest -> newest, and "last 20" means the 20 MOST RECENT, not the tail of a
    // newest-first array (that plotted the oldest runs, right to left).
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

// The analytics page's aggregate: one request, loaded only when that route mounts (the dashboard
// must not pay for it, and vice versa). Mirrors useDashboardStats deliberately - same shape, same
// "no data" vs "could not load" split.
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
