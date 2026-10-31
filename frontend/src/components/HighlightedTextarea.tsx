import { type ChangeEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { LATEX_CLASS, tokenize } from "@/lib/latex";
import { callByLine, type LineCall, lineOf, type QuotedLine } from "@/lib/resumeText";
import { cn } from "@/lib/utils";

const LINE_HEIGHT = 20;

const MARK: Record<LineCall, string> = {
    weak: "decoration-destructive/70 decoration-2 bg-destructive/10",
    safe: "",
    strong: "decoration-emerald-500/70 decoration-2 bg-emerald-500/10",
};

// The textarea owns the caret, the selection and the scrolling; the layer behind it owns the colour.
// Both carry the same box: a mono face, the same padding, the same line height. The visible glyphs are
// the layer's, so the textarea's own text is transparent, which is why metrics here are load-bearing.
const BOX = "whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-5";

export function HighlightedTextarea({
    id,
    value,
    onChange,
    lines,
    latex,
    placeholder,
    focus,
    ghost,
    suggestions,
}: {
    id: string;
    value: string;
    onChange: (value: string) => void;
    lines: QuotedLine[];
    latex: boolean;
    placeholder: string;
    focus?: { quote: string; n: number } | null;
    ghost?: { quote: string; rewrite: string } | null;
    suggestions?: { source: string; rewrite: string }[];
}) {
    const mirror = useRef<HTMLDivElement | null>(null);
    const area = useRef<HTMLTextAreaElement | null>(null);
    const seen = useRef(0);
    const calls = useMemo(() => callByLine(value, lines), [value, lines]);
    const rows = useMemo(() => value.split("\n"), [value]);
    const ghostLine = useMemo(() => (ghost ? lineOf(value, ghost.quote) : null), [ghost, value]);
    const [overLine, setOverLine] = useState<number | null>(null);
    const [padRight, setPadRight] = useState<number | null>(null);

    // A textarea's scrollbar sits inside its box, so the text it wraps is narrower than the layer behind
    // it by the scrollbar. Without paying that gutter back, every wrapped line drifts and the caret lands
    // off the words it is next to. Measured, because the width is zero on overlay scrollbars and not on
    // the classic ones.
    useLayoutEffect(() => {
        const node = area.current;
        if (!node) return;
        const measure = () => {
            const style = getComputedStyle(node);
            const borders = Number.parseFloat(style.borderLeftWidth) + Number.parseFloat(style.borderRightWidth);
            setPadRight(Number.parseFloat(style.paddingRight) + Math.max(0, node.offsetWidth - node.clientWidth - borders));
        };
        measure();
        const watch = new ResizeObserver(measure);
        watch.observe(node);
        return () => watch.disconnect();
    }, []);

    // AI HERE: the two layers have to wrap the same or the marks point at the wrong words; in dev the
    // disagreement is named instead of being chased as "the editor is broken". Upgrade path is a real
    // test once the frontend has a runner.
    useEffect(() => {
        if (!import.meta.env.DEV) return;
        const frame = requestAnimationFrame(() => {
            const node = area.current;
            const layer = mirror.current;
            if (node && layer && Math.abs(node.scrollHeight - layer.scrollHeight) > 1) console.warn(`editor layers disagree: textarea ${node.scrollHeight}, layer ${layer.scrollHeight}`);
        });
        return () => cancelAnimationFrame(frame);
    });

    // Wrapped lines make "line index times line height" a lie, so every position the editor needs (the
    // card, the jump from the panel, the line under the pointer) reads the layer's real boxes instead.
    const boxes = useRef<{ top: number; bottom: number }[]>([]);
    useLayoutEffect(() => {
        const layer = mirror.current;
        if (!layer) return;
        boxes.current = [...layer.children].filter((child): child is HTMLElement => child.tagName === "SPAN").map((child) => ({ top: child.offsetTop, bottom: child.offsetTop + child.offsetHeight }));
    });
    // The panel and the text point at the same thing: a line that has a rewrite waiting for it. Hovering
    // the line itself does not scroll anywhere, because the line is already under the pointer.
    const byLine = useMemo(() => {
        const map = new Map<number, { source: string; rewrite: string }>();
        for (const item of suggestions ?? []) {
            const line = lineOf(value, item.source);
            if (line !== null && !map.has(line)) map.set(line, item);
        }
        return map;
    }, [suggestions, value]);
    const hinted = overLine === null ? null : (byLine.get(overLine) ?? null);
    const shown = ghost ?? hinted;
    const shownLine = ghost ? ghostLine : hinted ? overLine : null;
    const cardTop = shownLine === null ? 0 : (boxes.current[shownLine]?.bottom ?? (shownLine + 1) * LINE_HEIGHT) + 2;
    const quote = focus?.quote ?? "";
    const bump = focus?.n ?? 0;

    // Hovering a rewrite in the panel points here. The suggestion is only readable if its line has room
    // below it, so a line near the bottom is scrolled up first.
    useEffect(() => {
        if (ghostLine === null) return;
        const node = area.current;
        const box = boxes.current[ghostLine];
        if (!node || !box) return;
        if (box.top < node.scrollTop || box.bottom > node.scrollTop + node.clientHeight - LINE_HEIGHT * 2) node.scrollTop = Math.max(0, box.top - LINE_HEIGHT * 3);
    }, [ghostLine]);

    // A row in the review panel points at a line here: scroll it into view and select it, so the mark
    // the panel is talking about is the one under the cursor.
    useEffect(() => {
        if (!quote || seen.current === bump) return;
        seen.current = bump;
        const node = area.current;
        const line = lineOf(value, quote);
        if (!node || line === null) return;
        const at = rows.slice(0, line).reduce((sum, row) => sum + row.length + 1, 0);
        node.focus();
        node.setSelectionRange(at, at + rows[line].length);
        node.scrollTop = Math.max(0, (boxes.current[line]?.top ?? line * LINE_HEIGHT) - LINE_HEIGHT * 2);
    }, [quote, bump, value, rows]);

    function lineAt(clientY: number): number {
        const node = area.current;
        if (!node || !boxes.current.length) return -1;
        const y = clientY - node.getBoundingClientRect().top + node.scrollTop;
        const at = boxes.current.findIndex((box) => y >= box.top && y < box.bottom);
        if (at >= 0) return at;
        return Math.max(0, Math.min(boxes.current.length - 1, Math.floor(y / LINE_HEIGHT) - 1));
    }

    function change(event: ChangeEvent<HTMLTextAreaElement>) {
        onChange(event.target.value);
    }

    return (
        <div className="relative min-h-0 flex-1">
            <div ref={mirror} aria-hidden style={padRight === null ? undefined : { paddingRight: padRight }} className={cn("pointer-events-none absolute inset-0 overflow-hidden rounded-xl border border-transparent", BOX)}>
                {rows.map((row, index) => {
                    const call = calls.get(index);
                    const ghosted = shownLine === index;
                    return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: a resume line has no id and repeats verbatim by design
                        <span key={index} className={cn("text-foreground", call && !ghosted && MARK[call], call && "underline", ghosted && "bg-primary/15")}>
                            {latex
                                ? tokenize(row).map((token, at) => (
                                      // biome-ignore lint/suspicious/noArrayIndexKey: token order is the line itself
                                      <span key={at} className={token.kind === "plain" || call ? undefined : LATEX_CLASS[token.kind]}>
                                          {token.text}
                                      </span>
                                  ))
                                : row}
                            {"\n"}
                        </span>
                    );
                })}
                {shown && shownLine !== null && (
                    <div className="absolute inset-x-1 space-y-1 whitespace-normal rounded-lg border border-primary/40 bg-background p-2 font-sans text-xs leading-snug text-foreground shadow-lg" style={{ top: cardTop }}>
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Suggested rewrite</p>
                        <p>{shown.rewrite}</p>
                    </div>
                )}
            </div>
            <Textarea
                id={id}
                ref={area}
                value={value}
                onChange={change}
                onScroll={(event) => {
                    if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop;
                }}
                onMouseMove={(event) => {
                    if (!byLine.size) return;
                    const line = lineAt(event.clientY);
                    setOverLine((current) => (current === line ? current : line));
                }}
                onMouseLeave={() => setOverLine(null)}
                spellCheck={false}
                placeholder={placeholder}
                className={cn("relative size-full min-h-[28rem] resize-none bg-transparent text-transparent caret-foreground selection:bg-primary/30 xl:min-h-0", BOX)}
            />
        </div>
    );
}
