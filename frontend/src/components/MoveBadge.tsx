import type { Grade } from "@/lib/api";
import { gradeTone, moveClassMeta } from "@/lib/moveClasses";
import { cn } from "@/lib/utils";

const BADGE = "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium";

/** The reviewer's verdict on one candidate turn, beside that turn's bubble. An unlabelable class
 *  still renders (raw slug, dashed edge) rather than vanishing. */
export function MoveBadge({ moveClass }: { moveClass: string }) {
    const meta = moveClassMeta(moveClass);
    return (
        <span title={meta?.hint ?? `Unlabelled move class: ${moveClass}`} className={cn(BADGE, meta?.tone ?? "border-dashed border-border text-muted-foreground")}>
            <span aria-hidden>{meta?.glyph ?? "•"}</span>
            <span>{meta?.label ?? moveClass}</span>
        </span>
    );
}

/** Accuracy + grade, the review's headline. */
export function GradeChip({ accuracy, grade }: { accuracy?: number | null; grade?: Grade | null }) {
    if (typeof accuracy !== "number") return null;
    return (
        <span className={cn("inline-flex items-baseline gap-2 rounded-md border px-2.5 py-1", gradeTone(grade))}>
            <span className="text-lg font-semibold leading-none tabular-nums">{accuracy}%</span>
            <span className="text-xs text-muted-foreground">accuracy</span>
            {grade && <span className="text-sm font-semibold leading-none">· {grade}</span>}
        </span>
    );
}
