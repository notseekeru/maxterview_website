// Display half of the LaTeX editor. app/latex.py owns the compiler; nothing here decides whether a
// document builds, only how its source is painted.

export const DOCUMENT = "\\documentclass";

export function isLatex(text: string): boolean {
    return text.includes(DOCUMENT);
}

export type LatexKind = "plain" | "command" | "comment" | "math";

export interface LatexToken {
    text: string;
    kind: LatexKind;
}

// One line at a time: the editor paints per line, and a comment runs to the end of its own line.
const TOKEN = /(%.*$)|(\$[^$]*\$)|(\\(?:[a-zA-Z@]+|.))/g;

export const LATEX_CLASS: Record<LatexKind, string> = {
    plain: "",
    command: "text-sky-400",
    comment: "italic text-muted-foreground/70",
    math: "text-amber-300",
};

export function tokenize(line: string): LatexToken[] {
    const tokens: LatexToken[] = [];
    let last = 0;
    for (const match of line.matchAll(TOKEN)) {
        const at = match.index ?? 0;
        if (at > last) tokens.push({ text: line.slice(last, at), kind: "plain" });
        tokens.push({ text: match[0], kind: match[1] ? "comment" : match[2] ? "math" : "command" });
        last = at + match[0].length;
    }
    if (last < line.length) tokens.push({ text: line.slice(last), kind: "plain" });
    return tokens;
}
