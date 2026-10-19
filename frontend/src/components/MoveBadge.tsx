import { useLayoutEffect, useRef, useState } from "react";
import type { Grade } from "@/lib/api";
import { gradeTone, moveClassMeta } from "@/lib/moveClasses";
import { cn } from "@/lib/utils";

const BADGE = "inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold leading-none";

// Dy that lands each disc glyph's ink box on the disc center, measured off the rendered badge: the
// line box centers the em, not the ink, so most glyphs sit 0.5px high. Re-measure if the symbol
// font or a class changes.
const GLYPH_DY: Record<string, string> = { "★": "1px", "✓": "0px", "•": "-0.5px" };

export function MoveBadge({ moveClass, comment }: { moveClass: string; comment?: string | null }) {
    const meta = moveClassMeta(moveClass);
    const name = meta?.label ?? moveClass;
    const [open, setOpen] = useState(false);
    // The disc sits left of an answer that can be screen-wide, so the card can land past the right
    // edge and drag a scrollbar in. It slides back by the overflow, measured from the disc.
    const [shift, setShift] = useState(0);
    const ref = useRef<HTMLDivElement | null>(null);
    const cardRef = useRef<HTMLDivElement | null>(null);
    useLayoutEffect(() => {
        if (!open) return;
        const card = cardRef.current;
        const disc = ref.current?.getBoundingClientRect();
        const log = ref.current?.closest<HTMLElement>('[role="log"]')?.getBoundingClientRect();
        if (!card || !disc || !log) return;
        const over = disc.left + card.offsetWidth + 8 - log.right;
        setShift(over > 0 ? -over : 0);
    }, [open]);
    // A noted disc drops the title: the card states the class, and a browser tooltip under it stacks.
    const title = comment ? undefined : meta ? `${name}: ${meta.hint}` : `Unlabelled move class: ${moveClass}`;
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: hover is the only way into the note, so the handlers sit on the plain wrapper. The disc keeps the class in its aria-label and title, which is all a non-pointer reader gets.
        <div ref={ref} onMouseEnter={() => comment && setOpen(true)} onMouseLeave={() => setOpen(false)} className="relative flex shrink-0">
            <span title={title} role="img" aria-label={name} className={cn(BADGE, meta?.tone ?? "border-dashed border-border text-muted-foreground")}>
                <span aria-hidden style={{ translate: `0 ${GLYPH_DY[meta?.glyph ?? "•"] ?? "0.5px"}` }}>
                    {meta?.glyph ?? "•"}
                </span>
            </span>
            {/* Above the disc and over the answer it grades. AI HERE: a row at the very top of the
                scroller would clip it, which needs a measure-and-flip; not worth the layout read yet. */}
            {open && (
                <div ref={cardRef} role="note" style={{ left: shift }} className="absolute bottom-full z-30 w-64 max-w-[70vw] rounded-2xl border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-md lg:w-80">
                    <p className="font-semibold">{name}</p>
                    <p className="mt-0.5">{comment}</p>
                </div>
            )}
        </div>
    );
}

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
