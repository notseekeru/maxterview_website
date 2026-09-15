import type { Grade } from "@/lib/api";
import { gradeTone, moveClassMeta } from "@/lib/moveClasses";
import { cn } from "@/lib/utils";

const BADGE = "inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold leading-none";

/** The reviewer's verdict on one candidate turn, beside that turn's bubble: a chess-annotation
 *  disc, glyph only. The class name lives in the tooltip and the aria-label. */
export function MoveBadge({ moveClass }: { moveClass: string }) {
    const meta = moveClassMeta(moveClass);
    const name = meta?.label ?? moveClass;
    return (
        <span title={meta ? `${name} — ${meta.hint}` : `Unlabelled move class: ${moveClass}`} role="img" aria-label={name} className={cn(BADGE, meta?.tone ?? "border-dashed border-border text-muted-foreground")}>
            <span aria-hidden>{meta?.glyph ?? "•"}</span>
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
