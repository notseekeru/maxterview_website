import { Progress } from "@/components/ui/progress";
import { turnsToday, type Usage } from "@/lib/api";

export function TurnsMeter({ usage }: { usage: Usage }) {
    const today = turnsToday(usage);
    if (!today) return null;
    return (
        <div className="space-y-2">
            <Progress value={today.limit === 0 ? 0 : (today.used / today.limit) * 100} />
            <p className="text-xs text-muted-foreground">
                <span className="font-medium tabular-nums text-foreground">{today.remaining}</span> of {today.limit} turns left today, shared across every interview. Resets at 00:00 UTC.
            </p>
        </div>
    );
}
