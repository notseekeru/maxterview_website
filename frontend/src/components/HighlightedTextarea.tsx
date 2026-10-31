import { type ChangeEvent, useEffect, useMemo, useRef } from "react";
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
}: {
    id: string;
    value: string;
    onChange: (value: string) => void;
    lines: QuotedLine[];
    latex: boolean;
    placeholder: string;
    focus?: { quote: string; n: number } | null;
    ghost?: { quote: string; rewrite: string } | null;
}) {
    const mirror = useRef<HTMLDivElement | null>(null);
    const area = useRef<HTMLTextAreaElement | null>(null);
    const seen = useRef(0);
    const calls = useMemo(() => callByLine(value, lines), [value, lines]);
    const rows = useMemo(() => value.split("\n"), [value]);
    const ghostLine = useMemo(() => (ghost ? lineOf(value, ghost.quote) : null), [ghost, value]);
    const quote = focus?.quote ?? "";
    const bump = focus?.n ?? 0;

    // Hovering a rewrite in the panel points here. The suggestion is only readable if its line has room
    // below it, so a line near the bottom is scrolled up first.
    useEffect(() => {
        if (ghostLine === null) return;
        const node = area.current;
        if (!node) return;
        const top = ghostLine * LINE_HEIGHT;
        if (top < node.scrollTop || top + LINE_HEIGHT > node.scrollTop + node.clientHeight - LINE_HEIGHT * 2) node.scrollTop = Math.max(0, top - LINE_HEIGHT * 3);
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
        node.scrollTop = Math.max(0, line * LINE_HEIGHT - LINE_HEIGHT * 2);
    }, [quote, bump, value, rows]);

    function change(event: ChangeEvent<HTMLTextAreaElement>) {
        onChange(event.target.value);
    }

    return (
        <div className="relative min-h-0 flex-1">
            <div ref={mirror} aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden rounded-xl border border-transparent", BOX)}>
                {rows.map((row, index) => {
                    const call = calls.get(index);
                    const ghosted = ghostLine === index;
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
                {ghost && ghostLine !== null && (
                    <div className="absolute inset-x-1 space-y-1 whitespace-normal rounded-lg border border-primary/40 bg-background p-2 font-sans text-xs leading-snug text-foreground shadow-lg" style={{ top: (ghostLine + 1) * LINE_HEIGHT + 2 }}>
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Suggested rewrite</p>
                        <p>{ghost.rewrite}</p>
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
                spellCheck={false}
                placeholder={placeholder}
                className={cn("relative size-full min-h-[28rem] resize-none bg-transparent text-transparent caret-foreground selection:bg-primary/30 xl:min-h-0", BOX)}
            />
        </div>
    );
}
