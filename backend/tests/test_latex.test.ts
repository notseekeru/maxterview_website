import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/env.ts";
import { CompileBusy, CompileError, compilePdf } from "../src/latex.ts";
import { log } from "../src/observability.ts";
import { withConfig } from "./helpers/config.ts";

// pdflatex is not installed here, so the engine is a shell script that answers the way pdflatex would:
// a PDF with the limits it was given, a transcript with one .tex line, a hang, or a refusal. It refuses
// an absolute \input only when -cnf-line=openin_any=p is on its command line, as TeX does, so dropping
// that flag from the wrapper would let the secret through instead of failing this file.
const FAKE_ENGINE = String.raw`#!/bin/sh
source=$(cat main.tex)
mem=$(ulimit -v)
cpu=$(ulimit -t)
input=$(printf '%s' "$source" | grep -oE '\\input\{[^}]*\}' | head -n 1 | sed 's/^\\input{//; s/}$//')
case "$input" in
/*)
    case "$*" in
    *-cnf-line=openin_any=p*)
        echo "! LaTeX Error: File $input not found."
        echo "./main.tex:12: LaTeX Error: File $input not found."
        exit 1
        ;;
    esac
    { printf '%%PDF-1.4\n'; cat "$input"; printf '%%%%EOF\n'; } > main.pdf
    exit 0
    ;;
esac
case "$source" in
*"% fake:hang"*)
    kill -STOP $$
    ;;
*"% fake:boom"*)
    echo 'This is pdfTeX, Version 3.141592653'
    echo './main.tex:12: Undefined control sequence.'
    echo 'l.12 \nosuchcommand'
    echo '!  ==> Fatal error occurred, no output PDF file produced!'
    exit 1
    ;;
esac
printf '%%PDF-1.4\n%%%% fake mem=%s cpu=%s\n' "$mem" "$cpu" > main.pdf
printf '%%%%EOF\n' >> main.pdf
exit 0
`;

const document = (body: string) => String.raw`\documentclass{article}\begin{document}${body}\end{document}`;

let engineDir = "";

beforeAll(async () => {
    engineDir = await mkdtemp(join(tmpdir(), "fake-latex-"));
    const bin = join(engineDir, "pdflatex");
    await writeFile(bin, FAKE_ENGINE, "utf8");
    await chmod(bin, 0o755);
});

afterAll(async () => {
    await rm(engineDir, { recursive: true, force: true });
});

// engine() reads config.path on every call and the child inherits it as PATH, so prepending the fake
// directory is the whole install. latexConcurrency is 1 in every test because Slots is built once.
function withFake<T>(patch: Partial<Config>, body: () => Promise<T>): Promise<T> {
    return withConfig({ path: `${engineDir}:${process.env.PATH ?? "/usr/bin:/bin"}`, latexConcurrency: 1, ...patch }, body);
}

function engineProcesses(): string[] {
    return execFileSync("ps", ["-eo", "args"], { encoding: "utf8" })
        .split("\n")
        .filter((line) => line.includes(engineDir) && line.includes("pdflatex"));
}

describe("compilePdf", () => {
    it("compiles a clean document under the memory and CPU ceilings it was given", async () => {
        const info = vi.spyOn(log, "info");
        try {
            const pdf = await withFake({ latexMemoryMb: 128, latexTimeout: 5 }, () => compilePdf(document("Clean")));
            expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
            expect(pdf.toString()).toContain("mem=131072 cpu=5");
            expect(info).toHaveBeenCalledWith("latex.compile.ok", { bytes: pdf.length });
        } finally {
            info.mockRestore();
        }
    });

    it("surfaces the first .tex line instead of the transcript", async () => {
        const error = await withFake({}, () => compilePdf(document("% fake:boom"))).catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(CompileError);
        expect((error as CompileError).detail).toBe("./main.tex:12: Undefined control sequence.");
    });

    it("kills a hang at the timeout and leaves no engine process behind", async () => {
        const warning = vi.spyOn(log, "warning");
        try {
            await expect(withFake({ latexTimeout: 1 }, () => compilePdf(document("% fake:hang")))).rejects.toThrow("pdflatex ran longer than 1s");
            await vi.waitFor(() => expect(engineProcesses()).toEqual([]), { timeout: 3000 });
            expect(warning).toHaveBeenCalledWith("latex.compile.timeout");
        } finally {
            warning.mockRestore();
        }
    });

    it("answers busy past the queue wait instead of waiting for the slot", async () => {
        const info = vi.spyOn(log, "info");
        const holder = withFake({ latexTimeout: 1, latexQueueWait: 5 }, () => compilePdf(document("% fake:hang")));
        try {
            await expect(withConfig({ latexQueueWait: 0.2 }, () => compilePdf(document("Queued")))).rejects.toBeInstanceOf(CompileBusy);
            expect(info).toHaveBeenCalledWith("latex.compile.busy");
        } finally {
            await holder.catch(() => undefined);
            info.mockRestore();
        }
    });

    it("refuses a document that reads a file outside its own directory", async () => {
        const directory = await mkdtemp(join(tmpdir(), "latex-escape-"));
        const secret = join(directory, "secret.tex");
        try {
            await writeFile(secret, "TOPSECRET", "utf8");
            const error = await withFake({}, () => compilePdf(document(`\\input{${secret}}`))).catch((reason: unknown) => reason);
            expect(error).toBeInstanceOf(CompileError);
            expect((error as CompileError).detail).toContain(`File ${secret} not found`);
            expect((error as CompileError).detail).not.toContain("TOPSECRET");
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
