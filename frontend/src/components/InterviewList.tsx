import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Interview } from "@/lib/api";

interface Props {
    interviews: Interview[];
    loading: boolean;
    error: string | null;
    onRefresh: () => void;
    onOpen: (id: string) => void;
}

function formatDate(iso: string) {
    return new Date(iso).toLocaleString();
}

export function InterviewList({ interviews, loading, error, onRefresh, onOpen }: Props) {
    return (
        <Card className="w-full">
            <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle>History</CardTitle>
                <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading}>
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
                            <p className="truncate font-medium">{i.role}</p>
                            <p className="text-xs text-muted-foreground">
                                {i.topic ? `${i.topic} · ` : ""}
                                {i.status}
                                {i.created_at ? ` · ${formatDate(i.created_at)}` : ""}
                            </p>
                            {typeof i.score === "number" && <p className="text-xs text-muted-foreground">Score: {i.score}</p>}
                        </div>
                        <Button size="sm" variant="outline" onClick={() => onOpen(i.id)}>
                            Open
                        </Button>
                    </div>
                ))}
            </CardContent>
        </Card>
    );
}
