import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Decision, Interview } from "@/lib/api";
import { levelLabel } from "@/lib/interviewOptions";
import { DecisionChip } from "./DecisionVerdict";

interface Props {
    interviews: Interview[];
    loading: boolean;
    error: string | null;
    onRefresh: () => void;
    onOpen: (id: string) => void;
    onDelete: (id: string) => Promise<void> | void;
    /** Re-run scoring for a completed-but-unscored run. Caller refreshes on success. */
    onRescore: (id: string) => Promise<void> | void;
}

function formatDate(iso: string) {
    return new Date(iso).toLocaleString();
}

export function InterviewList({ interviews, loading, error, onRefresh, onOpen, onDelete, onRescore }: Props) {
    // Two-step confirm: first click arms the row, second confirms.
    const [confirmingId, setConfirmingId] = useState<string | null>(null);
    const [deleting, setDeleting] = useState(false);
    // Per-row so other rows' buttons stay usable.
    const [scoringId, setScoringId] = useState<string | null>(null);
    const [scoreError, setScoreError] = useState<string | null>(null);

    async function handleRescore(id: string) {
        setScoringId(id);
        setScoreError(null);
        try {
            await onRescore(id);
        } catch {
            // Model can still be unavailable (503).
            setScoreError("Couldn't review that run. Try again in a moment.");
        } finally {
            setScoringId(null);
        }
    }

    async function handleDelete(id: string) {
        if (confirmingId !== id) {
            setConfirmingId(id);
            return;
        }
        setDeleting(true);
        try {
            await onDelete(id);
            setConfirmingId(null);
        } finally {
            setDeleting(false);
        }
    }

    return (
        <Card className="w-full">
            <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle>History</CardTitle>
                <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading || deleting}>
                    Refresh
                </Button>
            </CardHeader>
            <CardContent className="space-y-2">
                {error && <p className="text-sm text-destructive">{error}</p>}
                {scoreError && <p className="text-sm text-destructive">{scoreError}</p>}
                {loading && <Skeleton className="h-16" />}
                {!loading && interviews.length === 0 && !error && <p className="text-sm text-muted-foreground">No interviews yet. Create one to begin.</p>}
                {interviews.map((i) => (
                    <div key={i.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
                        <div className="min-w-0">
                            <p className="truncate font-medium">
                                {i.role}
                                {i.level && i.level !== "any" && (
                                    <Badge variant="secondary" className="ml-2 align-middle text-[10px] font-medium">
                                        {levelLabel(i.level)}
                                    </Badge>
                                )}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {i.topic ? `${i.topic} · ` : ""}
                                {i.status}
                                {i.created_at ? ` · ${formatDate(i.created_at)}` : ""}
                            </p>
                            {/* Completed-without-accuracy is a real state — offer the retry, not a dead
                                end. */}
                            <div className="flex flex-wrap items-center gap-2">
                                {typeof i.accuracy === "number" ? (
                                    <span className="text-xs text-muted-foreground">
                                        Accuracy: {i.accuracy}%{i.grade ? ` · Grade ${i.grade}` : ""}
                                    </span>
                                ) : i.status === "completed" ? (
                                    <span className="text-xs text-muted-foreground">Not rated</span>
                                ) : null}
                                {/* Decision + certainty ride along with the accuracy: a run can be a
                                    mid accuracy and still a clear hire, or the reverse. */}
                                {i.decision && <DecisionChip decision={i.decision as Decision} certainty={i.certainty} />}
                            </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                            {typeof i.accuracy !== "number" && i.status === "completed" && (
                                <Button size="sm" variant="outline" onClick={() => void handleRescore(i.id)} disabled={scoringId === i.id || confirmingId === i.id}>
                                    {scoringId === i.id ? "Reviewing…" : "Retry review"}
                                </Button>
                            )}
                            <Button size="sm" variant="outline" onClick={() => onOpen(i.id)}>
                                Open
                            </Button>
                            {confirmingId === i.id ? (
                                <Button size="sm" variant="destructive" onClick={() => void handleDelete(i.id)} disabled={deleting}>
                                    {deleting ? "Deleting…" : "Confirm?"}
                                </Button>
                            ) : (
                                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void handleDelete(i.id)} disabled={deleting}>
                                    Delete
                                </Button>
                            )}
                        </div>
                    </div>
                ))}
            </CardContent>
        </Card>
    );
}
