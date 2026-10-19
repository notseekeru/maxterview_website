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

const DAY_MS = 86_400_000;
const utcDay = (iso: string) => Math.floor(Date.parse(iso) / DAY_MS);
const mean = (nums: number[]) => nums.reduce((a, b) => a + b, 0) / nums.length;

export const TREND_WINDOW = 5;
const TREND_DOTS = 20;
const SPARK_DAYS = 14;

function dailyCounts(runs: Interview[], days: number): number[] {
    const today = Math.floor(Date.now() / DAY_MS);
    const out: number[] = new Array(days).fill(0);
    for (const run of runs) {
        const age = today - utcDay(run.created_at);
        if (age >= 0 && age < days) out[days - 1 - age] += 1;
    }
    return out;
}

function windowCounts(runs: Interview[], days: number): [number, number] {
    const today = Math.floor(Date.now() / DAY_MS);
    let recent = 0;
    let prior = 0;
    for (const run of runs) {
        const age = today - utcDay(run.created_at);
        if (age < 0) continue;
        if (age < days) recent += 1;
        else if (age < days * 2) prior += 1;
    }
    return [recent, prior];
}

function windowDelta(values: number[], size: number): number | null {
    if (values.length < size * 2) return null;
    return mean(values.slice(0, size)) - mean(values.slice(size, size * 2));
}

function streakDays(runs: Interview[]): number {
    const days = [...new Set(runs.map((r) => utcDay(r.created_at)))].sort((a, b) => b - a);
    const today = Math.floor(Date.now() / DAY_MS);
    if (days.length === 0 || today - days[0] > 1) return 0;
    let n = 1;
    while (n < days.length && days[n] === days[n - 1] - 1) n += 1;
    return n;
}

export interface InterviewDims {
    total: number;
    completed: number;
    rated: number;
    avgAccuracy: number;
    accuracyTrend: { label: string; accuracy: number }[];
    decided: number;
    hiring: number;
    avgCertainty: number | null;
    weekRuns: number;
    streak: number;
    lastRunDays: number | null;
    delta: { runs: number | null; finished: number | null; accuracy: number | null; hire: number | null };
    sparks: { runs: number[]; finished: number[]; accuracy: number[]; hire: number[] };
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
    // The API returns newest-first; a trend chart runs oldest to newest. The window is the newest
    // TREND_DOTS runs, not the tail of a newest-first array.
    const chronological = [...recent].reverse();
    const window = chronological.slice(-TREND_DOTS);
    const dates = window.map((i) => i.created_at.slice(0, 10));
    const accuracyTrend = window.map((i) => ({ label: trendLabel(i.created_at, dates.filter((d) => d === i.created_at.slice(0, 10)).length > 1), accuracy: i.accuracy as number }));
    // Decisions are counted over their OWN denominator: an unscored or undecided run must
    // not silently count as a non-hire, and pre-decision feedback rows have no decision.
    const decided = completed.filter((i) => i.decision);
    const hiring = decided.filter((i) => isHiring(i.decision));
    const certainties = decided.map((i) => i.certainty).filter((c): c is number => typeof c === "number");
    const avgCertainty = certainties.length === 0 ? null : Math.round(certainties.reduce((a, b) => a + b, 0) / certainties.length);
    const [weekRuns, priorWeekRuns] = windowCounts(list, 7);
    const [weekFinished, priorWeekFinished] = windowCounts(completed, 7);
    const today = Math.floor(Date.now() / DAY_MS);

    // Rolling rate as the decisions accrue, so the tile's sparkline is its own metric over time
    // rather than a second series wearing the same label.
    const hireSpark: number[] = [];
    let hires = 0;
    for (const [i, run] of [...decided].reverse().entries()) {
        if (isHiring(run.decision)) hires += 1;
        hireSpark.push((hires / (i + 1)) * 100);
    }

    return {
        total: list.length,
        completed: completed.length,
        rated: recent.length,
        avgAccuracy,
        accuracyTrend,
        decided: decided.length,
        hiring: hiring.length,
        avgCertainty,
        weekRuns,
        streak: streakDays(list),
        lastRunDays: list.length === 0 ? null : Math.min(...list.map((i) => today - utcDay(i.created_at))),
        delta: {
            runs: weekRuns + priorWeekRuns === 0 ? null : weekRuns - priorWeekRuns,
            finished: weekFinished + priorWeekFinished === 0 ? null : weekFinished - priorWeekFinished,
            accuracy: windowDelta(
                recent.map((i) => i.accuracy as number),
                TREND_WINDOW,
            ),
            hire: windowDelta(
                decided.map((i) => (isHiring(i.decision) ? 100 : 0)),
                TREND_WINDOW,
            ),
        },
        sparks: {
            runs: dailyCounts(list, SPARK_DAYS),
            finished: dailyCounts(completed, SPARK_DAYS),
            accuracy: accuracyTrend.map((p) => p.accuracy),
            hire: hireSpark.slice(-TREND_DOTS),
        },
    };
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
