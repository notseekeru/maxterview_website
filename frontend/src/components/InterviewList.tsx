import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Interview } from "@/lib/api";
import { levelLabel } from "@/lib/interviewOptions";

interface Props {
    interviews: Interview[];
    loading: boolean;
    error: string | null;
    onRefresh: () => void;
    onOpen: (id: string) => void;
    onDelete: (id: string) => Promise<void> | void;
}

function formatDate(iso: string) {
    return new Date(iso).toLocaleString();
}

export function InterviewList({ interviews, loading, error, onRefresh, onOpen, onDelete }: Props) {
    // Two-step confirm: first click arms the row for deletion, second confirms.
    const [confirmingId, setConfirmingId] = useState<string | null>(null);
    const [deleting, setDeleting] = useState(false);

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
                            {/* A completed run with no score is a real state (scoring failed and no
                                feedback row was written). Say so instead of dropping the line, which
                                read as a broken row. Regenerate lives in the interview view. */}
                            {typeof i.score === "number" ? <p className="text-xs text-muted-foreground">Score: {i.score}</p> : i.status === "completed" ? <p className="text-xs text-muted-foreground">Not scored</p> : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
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
