import { useCallback, useEffect, useMemo, useState } from "react";

import { type Feedback, getFeedback, type Interview, listInterviews } from "@/lib/api";
import { isHiring } from "@/lib/interviewOptions";

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
            const completed = list.filter((i) => i.status === "completed" && typeof i.accuracy === "number");
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
    /** Subset of `completed` that carries a move review (drives avgAccuracy/accuracyTrend). */
    rated: number;
    avgAccuracy: number;
    accuracyTrend: { label: string; accuracy: number }[];
    /** Subset of `completed` the model put on the hire/reject spectrum. */
    decided: number;
    /** Of `decided`, those on the hiring half (hire/lean_hire). */
    hiring: number;
    /** Mean certainty over decided runs, or null when none reported it. */
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
