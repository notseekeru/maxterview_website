import type { ReactNode } from "react";

import type { Interview } from "@/lib/api";
import { CYNICISM, companySizeLabel, levelLabel, planSummary, segmentsFromPlan } from "@/lib/interviewOptions";
import { DecisionChip } from "./DecisionVerdict";

export function RunInfo({ interview }: { interview: Interview }) {
    const who = [interview.level === "any" ? null : levelLabel(interview.level), interview.role].filter(Boolean).join(" · ");
    const context = [interview.topic ? `focus: ${interview.topic}` : null, interview.company_size === "any" ? null : companySizeLabel(interview.company_size), new Date(interview.created_at).toLocaleString()].filter(Boolean).join(" · ");
    const tone = [interview.cynicism === "neutral" ? null : CYNICISM.find((c) => c.value === interview.cynicism)?.label, interview.brutally_honest && "Blunt", interview.hardcore && "Hardcore", !interview.human_mode && "Plain register"].filter(Boolean);
    const accuracy = typeof interview.accuracy === "number" ? `${interview.accuracy}%${interview.grade ? ` · Grade ${interview.grade}` : ""}` : "not rated";

    return (
        <div className="space-y-3">
            <div>
                <p className="font-medium">{who}</p>
                <p className="text-xs text-muted-foreground">{context}</p>
            </div>
            <dl className="grid grid-cols-[8.5rem_1fr] items-center gap-x-3 gap-y-1.5 text-xs">
                <Field label="Status">{interview.status}</Field>
                <Field label="Accuracy">{accuracy}</Field>
                <Field label="Decision">{interview.decision ? <DecisionChip decision={interview.decision} certainty={interview.certainty} /> : <span className="text-muted-foreground">undecided</span>}</Field>
                <Field label="Interview plan">{planSummary(segmentsFromPlan(interview.plan))}</Field>
                <Field label="Tone">{tone.length > 0 ? tone.join(" · ") : "baseline (neutral, human mode)"}</Field>
            </dl>
        </div>
    );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
    return (
        <>
            <dt className="text-muted-foreground">{label}</dt>
            <dd>{children}</dd>
        </>
    );
}
