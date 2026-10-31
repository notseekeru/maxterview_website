// Matching the reviewer's quotes back onto the text in the editor. Model quotes drift by a bullet, a
// double space or a stray newline, and a resume imported from a PDF is hard-wrapped mid-bullet, so a
// quote is located against the whole page flattened to one line and then mapped back to line numbers.

export type LineCall = "weak" | "safe" | "strong";

export interface QuotedLine {
    text: string;
    call: LineCall;
}

export interface Span {
    from: number;
    to: number;
}

const flatten = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();

// Below this a quote is too short to tell apart from a heading or a stray word.
const MIN_NAMED = 12;

function locate(flat: string[], quote: string): Span | null {
    const target = flatten(quote);
    if (!target) return null;
    const starts: number[] = [];
    let joined = "";
    for (const line of flat) {
        starts.push(joined.length);
        joined += `${line} `;
    }
    const at = joined.indexOf(target);
    if (at >= 0) {
        const lineAt = (offset: number) => {
            let found = 0;
            for (let i = 0; i < starts.length; i += 1) if (starts[i] <= offset) found = i;
            return found;
        };
        return { from: lineAt(at), to: lineAt(at + target.length - 1) };
    }
    // The model quoted a fragment of a line: mark the line it sits in rather than nothing.
    if (target.length < MIN_NAMED) return null;
    const at2 = flat.findIndex((line) => line.length >= MIN_NAMED && (line.includes(target) || target.includes(line)));
    return at2 >= 0 ? { from: at2, to: at2 } : null;
}

export function callByLine(text: string, quotes: QuotedLine[]): Map<number, LineCall> {
    const flat = text.split("\n").map(flatten);
    const calls = new Map<number, LineCall>();
    for (const quote of quotes) {
        const span = locate(flat, quote.text);
        if (!span) continue;
        for (let i = span.from; i <= span.to; i += 1) calls.set(i, quote.call);
    }
    return calls;
}

// One quote in, one line out: a wrapped bullet collapses into the single rewritten line, and the rest
// of the document keeps its shape (which LaTeX cares about).
export function replaceLine(text: string, source: string, rewrite: string): string | null {
    const lines = text.split("\n");
    const span = locate(lines.map(flatten), source);
    if (!span) return null;
    lines.splice(span.from, span.to - span.from + 1, rewrite);
    return lines.join("\n");
}
