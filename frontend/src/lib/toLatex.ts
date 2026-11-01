// A plain-text resume is one click from the LaTeX editor: this wraps the text in a document the compile
// endpoint renders, so the preview turns on without the candidate writing a preamble. It is a starting
// point, not a template: structure comes only from the shape of the text itself (caps headings, bullets).

const ESCAPE: Record<string, string> = {
    "\\": "\\textbackslash{}",
    "&": "\\&",
    "%": "\\%",
    $: "\\$",
    "#": "\\#",
    _: "\\_",
    "{": "\\{",
    "}": "\\}",
    "~": "\\textasciitilde{}",
    "^": "\\textasciicircum{}",
};

// pdflatex with T1 stops at punctuation it has no glyph for, and a PDF-extracted resume is full of it.
const FOLD: [RegExp, string][] = [
    [/[\u2013\u2014]/g, "--"],
    [/[\u2018\u2019]/g, "'"],
    [/[\u201c\u201d]/g, '"'],
    [/\u2026/g, "..."],
    [/[\u2022\u25aa\u25e6\u2023\u00b7]/g, " "],
    [/\u00a0/g, " "],
    [/[^\x20-\x7e\u00a0-\u00ff]/g, ""],
];

const texSafe = (line: string) => FOLD.reduce((out, [pattern, to]) => out.replace(pattern, to), line).replace(/[\\&%$#_{}~^]/g, (char) => ESCAPE[char]);

const BULLET = /^\s*(?:[\u2022\u25aa\u25e6\u2023*+-]|\u2013|\u2014)\s+/;
const HEADING = /^(?=.{2,48}$)[A-Z][A-Z0-9 &/,'().-]*$/;
const BREAK = String.raw`\\`;

const HEAD = String.raw`\documentclass[10pt,letterpaper]{article}
\usepackage[margin=0.75in]{geometry}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{enumitem}
\usepackage{titlesec}
\usepackage[hidelinks]{hyperref}`;

const BODY = String.raw`\pagestyle{empty}
\setlength{\parindent}{0pt}
\setlist[itemize]{leftmargin=1.2em,itemsep=1pt,topsep=3pt,parsep=0pt}
\titleformat{\section}{\large\bfseries}{}{0pt}{}[\vspace{-6pt}\rule{\linewidth}{0.4pt}]
\begin{document}`;

export function toLatex(text: string): string {
    const body: string[] = [];
    const flow: string[] = [];
    let bullets: string[] = [];
    let name = true;
    const named = text
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line && !BULLET.test(line));
    const meta = named ? `\n\\hypersetup{pdftitle={${texSafe(named)} resume}, pdfauthor={${texSafe(named)}}}` : "";

    function flushBullets() {
        if (!bullets.length) return;
        body.push(["\\begin{itemize}", ...bullets.map((item) => `  \\item ${item}`), "\\end{itemize}"].join("\n"));
        bullets = [];
    }

    // Each visual line keeps its own break: a resume is line-shaped, and a paragraph per line would both
    // spread the page and move the words away from where they were.
    function flushFlow() {
        if (!flow.length) return;
        body.push(flow.map((line) => line + BREAK).join("\n"));
        flow.length = 0;
    }

    function flush() {
        flushBullets();
        flushFlow();
    }

    for (const raw of text.split("\n")) {
        const line = raw.trim();
        if (!line) {
            flush();
            continue;
        }
        // The first content line is the name even when it is set in caps; a caps line anywhere else is a
        // section, which is exactly what a name would turn into.
        if (name && !BULLET.test(raw)) {
            flush();
            flow.push(`{\\LARGE\\bfseries ${texSafe(line)}}`);
            name = false;
            continue;
        }
        if (!BULLET.test(raw) && HEADING.test(line)) {
            flush();
            body.push(`\\section*{${texSafe(line)}}`);
            continue;
        }
        if (BULLET.test(raw)) {
            flushFlow();
            bullets.push(texSafe(line.replace(BULLET, "")));
            name = false;
            continue;
        }
        // A PDF wraps a bullet mid-sentence: a lowercase opener straight after items continues the last one.
        if (bullets.length && /^[a-z(]/.test(line)) {
            bullets[bullets.length - 1] += ` ${texSafe(line)}`;
            continue;
        }
        flushBullets();
        flow.push(texSafe(line));
    }
    flush();

    return `${HEAD}${meta}\n${BODY}\n\n${body.join("\n\n")}\n\n\\end{document}\n`;
}

// AI HERE: no test runner in the frontend, so the wrapper proves itself once in dev and stays silent in
// production. Upgrade path is a real test file when the app gets a runner.
if (import.meta.env.DEV) {
    const out = toLatex("ALEX MENDER\nSKILLS\n\u2022 Go & Rust_ #1\ncontinued here \u2013 done");
    const ok = ["\\documentclass", "pdfauthor={ALEX MENDER}", "{\\LARGE\\bfseries ALEX MENDER}", "\\section*{SKILLS}", "Go \\& Rust\\_ \\#1 continued here -- done", "\\end{document}"].every((part) => out.includes(part));
    if (!ok || out.includes("\u2013") || out.includes("\\section*{ALEX MENDER}")) console.error("toLatex: self-check failed");
}
