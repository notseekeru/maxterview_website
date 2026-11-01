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

const BULLET = /^(?:[•·▪◦‣∙*]\s*|[-–—+]\s+)/;
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

// A page break can cut the last bullet in half, and half a bullet looks like a stub. Only the last page's
// final block is a whole block, so the runt test is skipped everywhere else.
function blocks(rows: Row[], column: number, cut: boolean) {
    const counts = { bullets: 0, long: 0, runts: 0 };
    let open: { left: number; rows: Row[] } | null = null;
    const close = (split: boolean) => {
        if (!open) return;
        counts.bullets += 1;
        if (open.rows.length > 2) counts.long += 1;
        const last = open.rows[open.rows.length - 1];
        if (!split && open.rows.length >= 2 && last.right - last.left < column * STUB) counts.runts += 1;
        open = null;
    };
    for (const row of rows) {
        if (row.bullet) {
            close(false);
            open = { left: row.left, rows: [row] };
            continue;
        }
        if (open && row.left > open.left + INDENT) {
            open.rows.push(row);
            continue;
        }
        close(false);
    }
    close(cut);
    return counts;
}

export function layoutOf(sheets: Sheet[]): Layout | null {
    const filled = sheets.filter((sheet) => sheet.rows.length);
    if (!filled.length) return null;
    let bullets = 0;
    let long = 0;
    let runts = 0;
    let overrun = 0;
    for (const [index, sheet] of sheets.entries()) {
        const { rows } = sheet;
        if (!rows.length) continue;
        const left = Math.min(...rows.map((row) => row.left));
        overrun += rows.filter((row) => row.right > sheet.width - left + 1).length;
        const counts = blocks(rows, sheet.width - 2 * left, index < sheets.length - 1);
        bullets += counts.bullets;
        long += counts.long;
        runts += counts.runts;
    }
    const page = filled[filled.length - 1];
    const top = Math.min(...page.rows.map((row) => row.top));
    const bottom = Math.max(...page.rows.map((row) => row.top + row.height));
    const usable = page.height - 2 * top;
    return {
        pages: sheets.length,
        fill: usable > 0 ? Math.min(100, Math.round(((bottom - top) / usable) * 100)) : 100,
        overrun,
        bullets,
        long,
        runts,
    };
}

// AI HERE: no frontend test runner. Summing pages and skipping the runt test on a cut block are the two
// behaviors a one-page fixture cannot prove, so both are asserted once in dev. Upgrade path is a test
// file when the app gets a runner.
if (import.meta.env.DEV) {
    const first = rowsOf([
        { str: "•", left: 40, top: 700, width: 6, height: 10 },
        { str: "Starts a bullet the page break cuts", left: 52, top: 700, width: 300, height: 10 },
        { str: "tail", left: 52, top: 714, width: 100, height: 10 },
    ]);
    const second = rowsOf([
        { str: "•", left: 40, top: 100, width: 6, height: 10 },
        { str: "first", left: 52, top: 100, width: 320, height: 10 },
        { str: "short", left: 52, top: 114, width: 100, height: 10 },
    ]);
    const dash = rowsOf([
        { str: "-", left: 40, top: 10, width: 4, height: 10 },
        { str: "dash bullet", left: 50, top: 10, width: 200, height: 10 },
    ]);
    const report = layoutOf([
        { width: 612, height: 792, rows: first },
        { width: 612, height: 792, rows: second },
    ]);
    if (report?.pages !== 2 || report.bullets !== 2 || report.long !== 0 || report.runts !== 1 || report.overrun !== 0 || !dash[0].bullet) console.error("layout: self-check failed");
}
