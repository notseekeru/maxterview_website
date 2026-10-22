import { useCallback, useEffect, useRef, useState } from "react";

import { type Analytics, type DashboardDims, getAnalytics, getDashboardDims, getInterviewDimensions, type Interview, type InterviewDimensions, listInterviews } from "@/lib/api";

const PAGE = 50;

export function useInterviews(archived: boolean) {
    const [interviews, setInterviews] = useState<Interview[] | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const tab = useRef(archived);
    tab.current = archived;
    const busy = useRef(false);

    const load = useCallback(
        async (offset: number) => {
            try {
                const page = await listInterviews(PAGE, offset, archived);
                if (tab.current !== archived) return;
                setInterviews((prev) => (offset === 0 || prev === null ? page : [...prev, ...page]));
                setHasMore(page.length === PAGE);
                setError(null);
            } catch {
                if (tab.current === archived) setError("Could not load interviews.");
            }
        },
        [archived],
    );

    useEffect(() => {
        setInterviews(null);
        void load(0);
    }, [load]);

    const refresh = useCallback(() => load(0), [load]);
    const loadMore = useCallback(async () => {
        if (busy.current) return;
        busy.current = true;
        try {
            await load(interviews?.length ?? 0);
        } finally {
            busy.current = false;
        }
    }, [load, interviews]);

    return { interviews: interviews ?? [], loading: interviews === null && !error, error, refresh, hasMore, loadMore };
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

export const TREND_WINDOW = 5;

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

const EMPTY_DIMS: InterviewDims = {
    total: 0,
    completed: 0,
    rated: 0,
    avgAccuracy: 0,
    accuracyTrend: [],
    decided: 0,
    hiring: 0,
    avgCertainty: null,
    weekRuns: 0,
    streak: 0,
    lastRunDays: null,
    delta: { runs: null, finished: null, accuracy: null, hire: null },
    sparks: { runs: [], finished: [], accuracy: [], hire: [] },
};

// Labels are built here so the chart stays a pure renderer. A repeated date gains the run time, or
// same-day runs render identical "09-09" ticks.
function trendLabel(iso: string, dateRepeats: boolean): string {
    const md = iso.slice(5, 10).replace("-", "/");
    return dateRepeats ? `${md} ${iso.slice(11, 16)}` : md;
}

function toDims(d: DashboardDims): InterviewDims {
    const dates = d.accuracy_trend.map((p) => p.created_at.slice(0, 10));
    const accuracyTrend = d.accuracy_trend.map((p) => ({
        label: trendLabel(p.created_at, dates.filter((date) => date === p.created_at.slice(0, 10)).length > 1),
        accuracy: p.accuracy,
    }));
    return {
        total: d.total,
        completed: d.completed,
        rated: d.rated,
        avgAccuracy: d.avg_accuracy,
        accuracyTrend,
        decided: d.decided,
        hiring: d.hiring,
        avgCertainty: d.avg_certainty,
        weekRuns: d.week_runs,
        streak: d.streak,
        lastRunDays: d.last_run_days,
        delta: {
            runs: d.week_runs + d.prior_week_runs === 0 ? null : d.week_runs - d.prior_week_runs,
            finished: d.week_finished + d.prior_week_finished === 0 ? null : d.week_finished - d.prior_week_finished,
            accuracy: d.delta_accuracy,
            hire: d.delta_hire,
        },
        sparks: { runs: d.daily_runs, finished: d.daily_finished, accuracy: accuracyTrend.map((p) => p.accuracy), hire: d.hire_spark },
    };
}

export function useDashboardDims() {
    const [dims, setDims] = useState<InterviewDims | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        getDashboardDims()
            .then((d) => {
                if (alive) setDims(toDims(d));
            })
            .catch(() => {
                if (alive) setError("Could not load the dashboard.");
            });
        return () => {
            alive = false;
        };
    }, []);

    return { dims: dims ?? EMPTY_DIMS, error, loading: dims === null && !error };
}

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
