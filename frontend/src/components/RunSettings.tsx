import type { Interview } from "@/lib/api";
import { CYNICISM, companySizeLabel, levelLabel } from "@/lib/interviewOptions";

/** What this run is configured as, collapsed by default: the dials ARE the rubric's coverage
 *  upstream (backend llm.coverage_directive derives the interviewer's targets from the mix and the
 *  level), so this answers "why did it never ask me about X" - on demand, without spending the
 *  interview screen's height on it. Defaults stay out of the list (neutral, human mode): it reads as
 *  an anomaly report, not a config dump. */
export function RunSettings({ interview }: { interview: Interview }) {
    const who = [interview.level === "any" ? null : levelLabel(interview.level), interview.role].filter(Boolean).join(" · ");
    const tone = [interview.cynicism === "neutral" ? null : CYNICISM.find((c) => c.value === interview.cynicism)?.label, interview.brutally_honest && "Blunt", interview.hardcore && "Hardcore", !interview.human_mode && "Plain register"].filter(Boolean).join(" · ");
    return (
        <details className="mt-1">
            <summary className="w-fit cursor-pointer text-xs text-muted-foreground hover:text-foreground">Run settings</summary>
            <dl className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                <div>
                    <dt className="inline">This run · </dt>
                    <dd className="inline">
                        {who}
                        {interview.topic ? ` · focus: ${interview.topic}` : ""}
                        {interview.company_size === "any" ? "" : ` · ${companySizeLabel(interview.company_size)}`}
                    </dd>
                </div>
                <div>
                    <dt className="inline">Questions budgeted · </dt>
                    <dd className="inline">{`${interview.mix_chitchat} warm-up / ${interview.mix_behavioural} behavioural / ${interview.mix_technical} technical`}</dd>
                </div>
                {tone && (
                    <div>
                        <dt className="inline">Tone · </dt>
                        <dd className="inline">{tone}</dd>
                    </div>
                )}
            </dl>
        </details>
    );
}
