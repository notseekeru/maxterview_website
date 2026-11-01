export interface Item {
    str: string;
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface Row {
    text: string;
    left: number;
    top: number;
    right: number;
    height: number;
    bullet: boolean;
}

export interface Sheet {
    width: number;
    height: number;
    rows: Row[];
}

export interface Layout {
    pages: number;
    fill: number;
    bullets: number;
    long: number;
    runts: number;
    overrun: number;
}

const BULLET = /^[•·▪◦‣∙*]\s*/;
const STUB = 0.5;
const INDENT = 4;

export function rowsOf(items: Item[]): Row[] {
    const rows: Omit<Row, "bullet">[] = [];
    for (const item of [...items].sort((a, b) => a.top - b.top || a.left - b.left)) {
        const text = item.str.trim();
        if (!text) continue;
        const row = rows.find((line) => Math.abs(line.top - item.top) < Math.max(item.height, line.height) * 0.6);
        if (!row) {
            rows.push({ text, left: item.left, top: item.top, right: item.left + item.width, height: item.height });
            continue;
        }
        row.text += (item.left - row.right > item.height * 0.15 ? " " : "") + text;
        row.left = Math.min(row.left, item.left);
        row.right = Math.max(row.right, item.left + item.width);
        row.height = Math.max(row.height, item.height);
    }
    return rows.map((row) => ({ ...row, bullet: BULLET.test(row.text) }));
}

function blocks(rows: Row[], column: number) {
    const counts = { bullets: 0, long: 0, runts: 0 };
    let open: { left: number; rows: Row[] } | null = null;
    const close = () => {
        if (!open) return;
        counts.bullets += 1;
        if (open.rows.length > 2) counts.long += 1;
        const last = open.rows[open.rows.length - 1];
        if (open.rows.length >= 2 && last.right - last.left < column * STUB) counts.runts += 1;
        open = null;
    };
    for (const row of rows) {
        if (row.bullet) {
            close();
            open = { left: row.left, rows: [row] };
            continue;
        }
        if (open && row.left > open.left + INDENT) {
            open.rows.push(row);
            continue;
        }
        close();
    }
    close();
    return counts;
}

export function layoutOf(sheets: Sheet[]): Layout | null {
    const page = sheets[0];
    if (!page?.rows.length) return null;
    const left = Math.min(...page.rows.map((row) => row.left));
    const top = Math.min(...page.rows.map((row) => row.top));
    const bottom = Math.max(...page.rows.map((row) => row.top + row.height));
    const column = page.width - 2 * left;
    const usable = page.height - 2 * top;
    return {
        pages: sheets.length,
        fill: usable > 0 ? Math.min(100, Math.round(((bottom - top) / usable) * 100)) : 100,
        overrun: page.rows.filter((row) => row.right > page.width - left + 1).length,
        ...blocks(page.rows, column),
    };
}

// AI HERE: no frontend test runner. Three rows over two lines and a stub are the two failures the gate
// exists for, so both are asserted once in dev. Upgrade path is a test file when the app gets a runner.
if (import.meta.env.DEV) {
    const rows = rowsOf([
        { str: "•", left: 40, top: 100, width: 6, height: 10 },
        { str: "Shipped a thing that moved a number", left: 52, top: 100, width: 300, height: 10 },
        { str: "and kept going", left: 52, top: 114, width: 320, height: 10 },
        { str: "then went one line too far", left: 52, top: 128, width: 300, height: 10 },
        { str: "•", left: 40, top: 142, width: 6, height: 10 },
        { str: "A stub", left: 52, top: 142, width: 320, height: 10 },
        { str: "tail", left: 52, top: 156, width: 100, height: 10 },
    ]);
    const report = layoutOf([{ width: 612, height: 792, rows }]);
    if (report?.bullets !== 2 || report.long !== 1 || report.runts !== 1 || report.overrun !== 0) console.error("layout: self-check failed");
}
