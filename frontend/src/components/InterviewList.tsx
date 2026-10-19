import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { StateNote } from "@/components/ui/state";
import type { Decision, Interview } from "@/lib/api";
import { levelLabel } from "@/lib/interviewOptions";
import { cn } from "@/lib/utils";
import { DecisionChip } from "./DecisionVerdict";
import { RowMenu } from "./RowMenu";
import { RunInfo } from "./RunInfo";

interface Props {
    interviews: Interview[];
    loading: boolean;
    error: string | null;
    onRefresh: () => void;
    onOpen: (id: string) => void;
    onDelete: (id: string) => Promise<void> | void;
    onArchive: (id: string, archived: boolean) => Promise<void> | void;
    onRescore: (id: string) => Promise<void> | void;
}

function formatDate(iso: string) {
    return new Date(iso).toLocaleString();
}

export function InterviewList({ interviews, loading, error, onRefresh, onOpen, onDelete, onArchive, onRescore }: Props) {
    // Archive hides a row here and NOWHERE else (the stats still count it - that is the difference
    // from delete), and the two sets never mix: the list shows one or the other, never both.
    const [view, setView] = useState<"active" | "archived">("active");
    const [infoRow, setInfoRow] = useState<Interview | null>(null);
    const [pendingDelete, setPendingDelete] = useState<Interview | null>(null);
    const [deleting, setDeleting] = useState(false);
    // Per-row so other rows' buttons stay usable.
    const [scoringId, setScoringId] = useState<string | null>(null);
    const [archivingId, setArchivingId] = useState<string | null>(null);
    const [scoreError, setScoreError] = useState<string | null>(null);

    const archived = interviews.filter((i) => i.archived_at);
    // The last restore empties the fold and takes its toggle with it, so fall back instead of
    // stranding the user on an unreachable empty list.
    const visible = view === "archived" && archived.length > 0 ? archived : interviews.filter((i) => !i.archived_at);

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

    async function handleArchive(interview: Interview) {
        setArchivingId(interview.id);
        try {
            await onArchive(interview.id, !interview.archived_at);
        } finally {
            setArchivingId(null);
        }
    }

    async function confirmDelete() {
        if (!pendingDelete) return;
        setDeleting(true);
        try {
            await onDelete(pendingDelete.id);
            setPendingDelete(null);
        } finally {
            setDeleting(false);
        }
    }

    return (
        <Card className="w-full">
            <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle>History</CardTitle>
                <div className="flex items-center gap-1">
                    {/* A filter, not a reveal: the archived runs get their own folder, never a place
                        beside the active ones. */}
                    {archived.length > 0 && (
                        <>
                            <Button variant="ghost" size="sm" aria-pressed={view === "active"} className={cn(view === "active" && "bg-accent text-accent-foreground")} onClick={() => setView("active")}>
                                Active
                            </Button>
                            <Button variant="ghost" size="sm" aria-pressed={view === "archived"} className={cn(view === "archived" && "bg-accent text-accent-foreground")} onClick={() => setView("archived")}>
                                Archived ({archived.length})
                            </Button>
                        </>
                    )}
                    <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading || deleting}>
                        Refresh
                    </Button>
                </div>
            </CardHeader>
            <CardContent className="space-y-2">
                {error && <StateNote tone="danger">{error}</StateNote>}
                {scoreError && <StateNote tone="danger">{scoreError}</StateNote>}
                {loading && <Skeleton className="h-16" />}
                {!loading && visible.length === 0 && !error && <StateNote>{archived.length > 0 ? "No active runs. Everything is in Archived." : "No interviews yet. Create one to begin."}</StateNote>}
                {visible.map((i) => (
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
                                <Button size="sm" variant="outline" onClick={() => void handleRescore(i.id)} disabled={scoringId === i.id || archivingId === i.id}>
                                    {scoringId === i.id ? "Reviewing…" : "Retry review"}
                                </Button>
                            )}
                            <Button size="sm" variant="outline" onClick={() => onOpen(i.id)}>
                                Open
                            </Button>
                            <RowMenu
                                label={`Actions for ${i.role}`}
                                items={[
                                    { label: i.archived_at ? "Restore" : "Archive", onSelect: () => void handleArchive(i) },
                                    { label: "Info", onSelect: () => setInfoRow(i) },
                                    { label: "Delete", onSelect: () => setPendingDelete(i), destructive: true },
                                ]}
                            />
                        </div>
                    </div>
                ))}
            </CardContent>

            <Modal open={infoRow !== null} onClose={() => setInfoRow(null)} title="Run info">
                {infoRow && <RunInfo interview={infoRow} />}
            </Modal>

            {/* Delete is irreversible, so it confirms in a modal rather than arming the menu: the menu
                row is one click from Archive, and a misfire there costs the run and its review. */}
            <Modal open={pendingDelete !== null} onClose={() => setPendingDelete(null)} title="Delete this run?">
                <p>
                    <span className="font-medium">{pendingDelete?.role}</span> and its transcript, review and scores are removed for good. This cannot be undone. Archive it instead if you only want it out of the way.
                </p>
                <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setPendingDelete(null)} disabled={deleting}>
                        Cancel
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => void confirmDelete()} disabled={deleting}>
                        {deleting ? "Deleting…" : "Delete"}
                    </Button>
                </div>
            </Modal>
        </Card>
    );
}
