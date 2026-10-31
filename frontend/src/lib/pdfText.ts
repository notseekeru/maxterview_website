// The audit is generated from the source text, but the candidate reads the compiled page. Quotes are
// LaTeX markup around the same words the PDF prints, so a quote is reduced to its words and matched
// against the words of the page, in order, and the match becomes boxes over the rendered page.

import type { LineCall, QuotedLine } from "@/lib/resumeText";

export interface Box {
    text: string;
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface Rect {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface Mark {
    call: LineCall;
    rects: Rect[];
}

const WORD = /[a-z0-9][a-z0-9+#.]*/g;

// A quote is a source line: \href{url}{label} keeps the label, every other command goes, braces and
// TeX ties with it. What is left is the words a reader sees.
export function plain(quote: string): string {
    return quote
        .replace(/\\href\{[^{}]*\}\{([^{}]*)\}/g, "$1")
        .replace(/\\[a-zA-Z@]+\*?/g, " ")
        .replace(/\\\\|\\[^a-zA-Z]/g, " ")
        .replace(/[{}~$&]/g, " ");
}

const wordsOf = (text: string) => text.toLowerCase().match(WORD) ?? [];

export function pageWords(items: { str: string; left: number; top: number; width: number; height: number }[]): Box[] {
    const boxes: Box[] = [];
    for (const item of items) {
        if (!item.str.trim() || item.width <= 0) continue;
        const chars = item.str.length || 1;
        for (const hit of item.str.toLowerCase().matchAll(WORD)) {
            const at = hit.index ?? 0;
            const end = at + hit[0].length;
            boxes.push({ text: hit[0], left: item.left + (item.width * at) / chars, top: item.top, width: (item.width * (end - at)) / chars, height: item.height });
        }
    }
    return boxes;
}

// Words in order, skips allowed: a page break, a hyphen or a dropped \item must not lose the line. The
// longest run wins, and it has to carry most of the quote or nothing is marked.
function hitsFor(page: Box[], quote: string[]): number[] {
    if (quote.length < 3) return [];
    let best: number[] = [];
    for (let start = 0; start < page.length; start += 1) {
        if (page[start].text !== quote[0]) continue;
        const hits: number[] = [];
        for (let i = start, q = 0; i < page.length && q < quote.length; i += 1) {
            if (page[i].text === quote[q]) {
                hits.push(i);
                q += 1;
            }
        }
        if (hits.length > best.length) best = hits;
        if (best.length === quote.length) break;
    }
    return best.length >= Math.max(3, Math.ceil(quote.length * 0.6)) ? best : [];
}

// One box per rendered row the quote touches, so a wrapped bullet gets one bar per row.
function rects(page: Box[], hits: number[]): Rect[] {
    const rows: Rect[] = [];
    for (const at of hits) {
        const box = page[at];
        const row = rows.find((candidate) => Math.abs(candidate.top - box.top) < box.height * 0.6);
        if (!row) {
            rows.push({ left: box.left, top: box.top, width: box.width, height: box.height });
            continue;
        }
        const right = Math.max(row.left + row.width, box.left + box.width);
        row.left = Math.min(row.left, box.left);
        row.width = right - row.left;
        row.top = Math.min(row.top, box.top);
        row.height = Math.max(row.height, box.height);
    }
    return rows;
}

export function marksFor(page: Box[], quotes: QuotedLine[]): Mark[] {
    const marks: Mark[] = [];
    for (const quote of quotes) {
        const hits = hitsFor(page, wordsOf(plain(quote.text)));
        if (hits.length) marks.push({ call: quote.call, rects: rects(page, hits) });
    }
    return marks;
}

// AI HERE: the frontend has no test runner, so the matcher proves itself once in dev and stays silent
// in production. Upgrade path is a real test file when the app gets a runner.
if (import.meta.env.DEV) {
    const page = pageWords([{ str: "Cut p95 checkout latency", left: 0, top: 10, width: 120, height: 8 }]);
    const hit = marksFor(page, [{ text: "\\item \\textbf{Cut p95} checkout latency", call: "strong" }]);
    const miss = marksFor(page, [{ text: "worked on something else entirely", call: "weak" }]);
    if (hit.length !== 1 || hit[0].rects.length !== 1 || miss.length !== 0) console.error("pdfText: self-check failed");
}
