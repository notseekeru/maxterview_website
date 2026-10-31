import { type ChangeEvent, useMemo, useRef } from "react";
import { Textarea } from "@/components/ui/textarea";
import { LATEX_CLASS, tokenize } from "@/lib/latex";
import { callByLine, type LineCall, type QuotedLine } from "@/lib/resumeText";
import { cn } from "@/lib/utils";

const MARK: Record<LineCall, string> = {
    weak: "decoration-destructive/70 decoration-2",
    safe: "",
    strong: "decoration-emerald-500/70 decoration-2",
};

// The textarea owns the caret, the selection and the scrolling; the layer behind it owns the colour.
// Both carry the same box: a mono face, the same padding, the same line height. The visible glyphs are
// the layer's, so the textarea's own text is transparent, which is why metrics here are load-bearing.
const BOX = "whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs leading-5";

export function HighlightedTextarea({ id, value, onChange, lines, latex, placeholder }: { id: string; value: string; onChange: (value: string) => void; lines: QuotedLine[]; latex: boolean; placeholder: string }) {
    const mirror = useRef<HTMLDivElement | null>(null);
    const calls = useMemo(() => callByLine(value, lines), [value, lines]);
    const rows = useMemo(() => value.split("\n"), [value]);

    function change(event: ChangeEvent<HTMLTextAreaElement>) {
        onChange(event.target.value);
    }

    return (
        <div className="relative min-h-0 flex-1">
            <div ref={mirror} aria-hidden className={cn("pointer-events-none absolute inset-0 overflow-hidden rounded-xl border border-transparent", BOX)}>
                {rows.map((row, index) => {
                    const call = calls.get(index);
                    return (
                        // biome-ignore lint/suspicious/noArrayIndexKey: a resume line has no id and repeats verbatim by design
                        <span key={index} className={cn("text-foreground", call && MARK[call], call && "underline")}>
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
            </div>
            <Textarea
                id={id}
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
