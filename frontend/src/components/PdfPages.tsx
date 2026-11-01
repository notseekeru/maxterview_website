import type { PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { type Layout, layoutOf, type Row, rowsOf } from "@/lib/layout";
import { type Box, type Mark, marksFor, pageWords } from "@/lib/pdfText";
import type { QuotedLine } from "@/lib/resumeText";
import { cn } from "@/lib/utils";

const WASH: Record<string, string> = {
    weak: "bg-destructive/25",
    safe: "",
    strong: "bg-emerald-500/12",
};

interface Sheet {
    page: PDFPageProxy;
    width: number;
    height: number;
    words: Box[];
    rows: Row[];
}

// The page is drawn to a canvas, so the audit has to be drawn on top of it: pdf.js gives the position
// of every text run, and the quotes are matched against those runs.
function SheetView({ sheet, width, lines }: { sheet: Sheet; width: number; lines: QuotedLine[] }) {
    const canvas = useRef<HTMLCanvasElement | null>(null);
    const scale = width > 0 ? width / sheet.width : 0;

    useEffect(() => {
        const node = canvas.current;
        if (!node || !scale) return;
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        const viewport = sheet.page.getViewport({ scale: scale * ratio });
        node.width = Math.floor(viewport.width);
        node.height = Math.floor(viewport.height);
        const task = sheet.page.render({ canvas: node, viewport });
        void task.promise.catch(() => undefined);
        return () => task.cancel();
    }, [sheet, scale]);

    const marks: Mark[] = marksFor(sheet.words, lines);

    return (
        <div role="img" aria-label="Compiled resume page" className="relative shrink-0 bg-white shadow-sm" style={{ width: sheet.width * scale, height: sheet.height * scale }}>
            <canvas ref={canvas} className="h-full w-full" />
            {marks.map((mark) =>
                mark.rects.map((rect) => (
                    <span key={`${mark.call}-${rect.left.toFixed(1)}-${rect.top.toFixed(1)}`} aria-hidden className={cn("pointer-events-none absolute rounded-[1px]", WASH[mark.call])} style={{ left: rect.left * scale, top: rect.top * scale, width: rect.width * scale, height: rect.height * scale }} />
                )),
            )}
        </div>
    );
}

export function PdfPages({ data, lines }: { data: Uint8Array; lines: QuotedLine[] }) {
    const box = useRef<HTMLDivElement | null>(null);
    const [width, setWidth] = useState(0);
    const [sheets, setSheets] = useState<Sheet[]>([]);
    const [report, setReport] = useState<Layout | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        const node = box.current;
        if (!node) return;
        // Four-pixel steps: a width drag would otherwise re-render every page on every pixel.
        const watch = new ResizeObserver((entries) => setWidth(Math.floor(entries[0].contentRect.width / 4) * 4));
        watch.observe(node);
        return () => watch.disconnect();
    }, []);

    useEffect(() => {
        let alive = true;
        let stop: (() => void) | null = null;
        void (async () => {
            const pdfjs = await import("pdfjs-dist");
            pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
            // A copy: pdf.js hands the buffer to the worker, and a strict-mode remount would then be left
            // holding a detached one.
            const task = pdfjs.getDocument({ data: data.slice() });
            const doc = await task.promise;
            stop = () => void task.destroy();
            const next: Sheet[] = [];
            for (let n = 1; n <= doc.numPages; n += 1) {
                const page = await doc.getPage(n);
                const view = page.getViewport({ scale: 1 });
                const content = await page.getTextContent();
                const items = content.items.flatMap((item) => {
                    if (!("str" in item) || !item.str.trim()) return [];
                    const at = pdfjs.Util.transform(view.transform, item.transform);
                    const height = Math.hypot(at[2], at[3]) || item.height;
                    return [{ str: item.str, left: at[4], top: at[5] - height, width: item.width, height }];
                });
                next.push({ page, width: view.width, height: view.height, words: pageWords(items), rows: rowsOf(items) });
                if (!alive) return;
            }
            setFailed(false);
            setSheets(next);
            setReport(layoutOf(next));
        })().catch(() => {
            if (alive) setFailed(true);
        });
        return () => {
            alive = false;
            stop?.();
        };
    }, [data]);

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div ref={box} className="min-h-0 flex-1 overflow-auto bg-neutral-200 p-2 dark:bg-neutral-800">
                {failed ? (
                    <p className="m-2 text-xs text-destructive">Could not draw this PDF. Open it in the browser viewer instead.</p>
                ) : (
                    <div className="flex flex-col items-center gap-2">
                        {sheets.map((sheet) => (
                            <SheetView key={sheet.page.pageNumber} sheet={sheet} width={width} lines={lines} />
                        ))}
                    </div>
                )}
            </div>
            {report && <LayoutLine report={report} />}
        </div>
    );
}

// One page and two-line bullets are the shape of an early-career page. A senior page carries more, so
// the counts are shown without a pass or fail: the candidate decides what their band is worth.
function LayoutLine({ report }: { report: Layout }) {
    const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
    const parts = [count(report.pages, "page", "pages"), `${report.fill}% of the column`];
    if (report.long) parts.push(`${count(report.long, "bullet", "bullets")} over 2 lines`);
    if (report.runts) parts.push(`${count(report.runts, "stub", "stubs")} under half a line`);
    if (report.overrun) parts.push(`${count(report.overrun, "line", "lines")} past the margin`);
    return <p className="border-t px-3 py-1.5 text-[11px] leading-4 text-muted-foreground">{parts.join(" · ")}. Early-career target: one page, two-line bullets. Senior pages run longer.</p>;
}
