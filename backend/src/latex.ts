import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./env.ts";
import { log } from "./observability.ts";

const MAX_STDOUT = 4000;
const LOG_TAIL = 1200;

// -no-shell-escape: no \write18, so the document cannot run a command.
// cnf openin_any/openout_any=p: paranoid, so \input cannot read outside the compile dir.
// -halt-on-error/-file-line-error: the first error is the one worth showing, and it carries its line.
const ARGS = ["-no-shell-escape", "-interaction=nonstopmode", "-halt-on-error", "-file-line-error", "-cnf-line=openin_any=p", "-cnf-line=openout_any=p", "main.tex"];

export class CompileError extends Error {
    readonly detail: string;

    constructor(detail: string) {
        super(detail);
        this.name = "CompileError";
        this.detail = detail;
    }
}

export class CompileBusy extends Error {
    constructor() {
        super("");
        this.name = "CompileBusy";
    }
}

export function available(): boolean {
    return engine() !== "";
}

function engine(): string {
    for (const dir of config.path.split(":")) {
        if (dir === "") continue;
        const candidate = join(dir, "pdflatex");
        try {
            accessSync(candidate, constants.X_OK);
            return candidate;
        } catch {}
    }
    return "";
}

// Per-child, not per-pod: a runaway expansion dies here instead of taking the worker with it.
function shellCommand(): string {
    const memoryKb = config.latexMemoryMb * 1024;
    const cpuS = Math.trunc(config.latexTimeout);
    return `ulimit -v ${memoryKb}; ulimit -t ${cpuS}; exec ${quote(engine())} ${ARGS.map(quote).join(" ")} 2>&1`;
}

function quote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

function firstError(logText: string): string {
    const lines = logText
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    for (const line of lines) {
        if (line.startsWith("!") || line.includes(".tex:")) return line.slice(0, LOG_TAIL);
    }
    // A document that compiles to nothing is not a compiler fault, and "Transcript written on main.log"
    // is the only line pdflatex leaves behind when the body is empty.
    if (logText.includes("No pages of output")) return "This document produces no pages: nothing is inside the body.";
    return (lines.at(-1) ?? "pdflatex failed without a message.").slice(0, LOG_TAIL);
}

type Release = () => void;

class Slots {
    private free: number;
    private readonly waiting: (() => void)[] = [];

    constructor(size: number) {
        this.free = Math.max(1, size);
    }

    async acquire(waitMs: number): Promise<Release | null> {
        if (this.free > 0) {
            this.free -= 1;
            return () => this.release();
        }
        return await new Promise<Release | null>((resolve) => {
            const grant = () => {
                clearTimeout(timer);
                resolve(() => this.release());
            };
            const timer = setTimeout(() => {
                const at = this.waiting.indexOf(grant);
                if (at >= 0) this.waiting.splice(at, 1);
                resolve(null);
            }, waitMs);
            this.waiting.push(grant);
        });
    }

    private release(): void {
        const next = this.waiting.shift();
        if (next) next();
        else this.free += 1;
    }
}

let slots: Slots | null = null;

function queue(): Slots {
    slots ??= new Slots(config.latexConcurrency);
    return slots;
}

async function run(source: string): Promise<Buffer> {
    const workdir = await mkdtemp(join(tmpdir(), "latex-"));
    try {
        await writeFile(join(workdir, "main.tex"), source, "utf8");
        const child = spawn("sh", ["-c", shellCommand()], {
            cwd: workdir,
            env: { PATH: config.path, HOME: workdir, TEXMFVAR: join(workdir, ".texmf") },
            stdio: ["ignore", "pipe", "ignore"],
        });
        const chunks: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        let resolveClose: (code: number | null) => void = () => {};
        const closed = new Promise<number | null>((resolve, reject) => {
            resolveClose = resolve;
            child.on("error", reject);
            child.on("close", resolve);
        });
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
            // `close` waits for every holder of the stdout pipe, and a grandchild can outlive the kill.
            child.once("exit", (code) => resolveClose(code));
        }, config.latexTimeout * 1000);
        const returncode = await closed.finally(() => clearTimeout(timer));
        if (timedOut) {
            log.warning("latex.compile.timeout");
            throw new CompileError(`pdflatex ran longer than ${Math.trunc(config.latexTimeout)}s. Check the document for a runaway command.`);
        }
        const text = Buffer.concat(chunks).toString("utf8").slice(0, MAX_STDOUT);
        const pdf = await readFile(join(workdir, "main.pdf")).catch(() => null);
        if (returncode !== 0 || pdf === null) {
            log.info("latex.compile.failed", { returncode, chars: text.length });
            throw new CompileError(firstError(text));
        }
        log.info("latex.compile.ok", { bytes: pdf.length });
        return pdf;
    } finally {
        await rm(workdir, { recursive: true, force: true });
    }
}

export async function compilePdf(source: string): Promise<Buffer> {
    if (!available()) throw new CompileError("No LaTeX engine is installed on this deployment.");
    // A preview is a keystroke behind, not a job worth queueing for: past the wait the honest answer is
    // "busy", because a queue of compiles is a queue of requests the client has already given up on.
    const release = await queue().acquire(config.latexQueueWait * 1000);
    if (release === null) {
        log.info("latex.compile.busy");
        throw new CompileBusy();
    }
    try {
        return await run(source);
    } finally {
        release();
    }
}

// AI HERE: one engine, one file, one pass. Ceiling: a resume that needs bibtex or a second pass will
// render with unresolved references. Upgrade path: run the pass twice and bibtex between, keyed on the
// log asking for a rerun. The rlimits ride on `sh`, which POSIX-compatible images have.
assert(ARGS.slice(0, -1).every((flag) => flag.startsWith("-")) && ARGS.at(-1) === "main.tex");
