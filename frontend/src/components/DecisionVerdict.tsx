import { Progress } from "@/components/ui/progress";
import type { Decision } from "@/lib/api";
import { DECISIONS, decisionLabel } from "@/lib/interviewOptions";
import { cn } from "@/lib/utils";

// the DECISION (where on the reject..hire spectrum it landed) and the CERTAINTY (how much
// transcript backs that landing). Fill intensity carries conviction, colour carries side,
function toneClass(decision: Decision): string {
    switch (decision) {
        case "reject":
            return "bg-destructive";
        case "lean_reject":
            return "bg-destructive/50";
        case "lean_hire":
            return "bg-primary/50";
        default:
            return "bg-primary";
    }
}

/** Certainty bands. Keeps 41% from reading like 89% without inventing a second score. */
function certaintyBand(pct: number): string {
    if (pct < 34) return "Low: the transcript leaves a lot unanswered.";
    if (pct < 67) return "Moderate: real evidence, with gaps.";
    return "High: backed by concrete, role-specific answers.";
}

export function DecisionVerdict({ decision, certainty, className }: { decision: Decision; certainty?: number | null; className?: string }) {
    const pct = typeof certainty === "number" ? certainty : null;
    const active = DECISIONS.findIndex((d) => d.value === decision);

    return (
        <div className={cn("space-y-3 rounded-lg border p-4", className)}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                <span className="text-sm font-medium">Hiring decision</span>
                <span className="text-sm text-muted-foreground">{pct === null ? "certainty not reported" : `${pct}% certain`}</span>
            </div>

            <div className="grid grid-cols-4 gap-1" role="img" aria-label={`Decision: ${decisionLabel(decision)}${pct === null ? "" : `, ${pct}% certain`}`}>
                {DECISIONS.map((d, i) => (
                    <div key={d.value} className="space-y-1">
                        <div className={cn("h-2 rounded-full", i === active ? toneClass(d.value) : "bg-muted")} />
                        <p className={cn("truncate text-[10px] leading-tight", i === active ? "font-medium" : "text-muted-foreground")}>{d.label}</p>
                    </div>
                ))}
            </div>

            {pct !== null && <Progress className="h-1.5" value={pct} />}
            <p className="text-xs text-muted-foreground">{pct === null ? "The model picked a decision but not a confidence level for it." : `${certaintyBand(pct)} Certainty measures how much evidence backs the call, not how good it is.`}</p>
        </div>
    );
}

export function DecisionChip({ decision, certainty, className }: { decision: Decision; certainty?: number | null; className?: string }) {
    return (
        <span className={cn("inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium", className)}>
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", toneClass(decision))} aria-hidden />
            {decisionLabel(decision)}
            {typeof certainty === "number" && <span className="text-muted-foreground">· {certainty}%</span>}
        </span>
    );
}
