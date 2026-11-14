import { strict as assert } from "node:assert";
import { getDocumentProxy } from "unpdf";
import { config } from "./env.ts";
import { log } from "./logs.ts";
import type { ResumeExtract } from "./models.ts";

export class ExtractError extends Error {
    constructor(detail: string) {
        super(detail);
        this.name = "ExtractError";
    }
}

const PDF_MAGIC = "%PDF-";
const SPACES = / {2,}/g;
const BLANK_LINES = /\n{3,}/g;

export function sanitize(text: string, limit = config.resumeMaxChars): string {
    const normalized = text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", " ").normalize("NFKC");
    const filtered = normalized.replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === "\n" ? char : ""));
    const trimmed = filtered
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n");
    return trimmed.replace(SPACES, " ").replace(BLANK_LINES, "\n\n").trim().slice(0, limit);
}

// AI HERE: one framework-free self-check (AGENTS rule 5). The invisible-character cases are the
// security-relevant ones: if an edit drops the Cf filter, hidden-text injection returns silently.
assert.equal(sanitize("A\u200bb\u00ad\n\n\n\nB\t\tC "), "Ab\n\nB C");

function hasPdfHeader(data: Uint8Array): boolean {
    return Buffer.from(data.subarray(0, 1024)).includes(PDF_MAGIC);
}

function isPasswordError(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "PasswordException";
}

async function parse(data: Uint8Array): Promise<ResumeExtract> {
    // pdf.js transfers the buffer it is handed, and the caller's bytes are not pdf.js's to detach.
    const pdf = await getDocumentProxy(new Uint8Array(data)).catch((error: unknown) => {
        throw isPasswordError(error) ? new ExtractError("That PDF is password-protected. Remove the password, or paste the text instead.") : error;
    });
    try {
        const body: string[] = [];
        let pages = 0;
        let total = 0;
        let truncated = false;
        for (let index = 0; index < pdf.numPages; index += 1) {
            if (index >= config.resumeMaxPages || total >= config.resumeMaxChars) {
                truncated = true;
                break;
            }
            let chunk: string;
            try {
                const page = await pdf.getPage(index + 1);
                const content = await page.getTextContent();
                chunk = content.items
                    .map((item) => ("str" in item ? item.str + (item.hasEOL ? "\n" : "") : ""))
                    .join("");
            } catch {
                // One unreadable page must not cost the whole import (pdfjs raises many types on
                // malformed content, and its message is attacker-controlled: log the fact, never it).
                log.warning("resume.page_unreadable", { page: index + 1 });
                truncated = true;
                continue;
            }
            pages += 1;
            total += chunk.length;
            body.push(chunk);
        }
        const text = sanitize(body.join("\n"), config.resumeMaxChars);
        if (text === "") throw new ExtractError("No selectable text in that PDF: it looks like a scan or an image export. Paste the text instead.");
        return { text, pages, truncated };
    } finally {
        await pdf.loadingTask.destroy();
    }
}

let active = 0;
const waiting: (() => void)[] = [];

// unpdf parses in-process, so each parse holds a whole document in RAM: with `replicas: 1` an unbounded
// surge is an OOMKill, not a slow upload.
async function withSlot<T>(work: () => Promise<T>): Promise<T> {
    if (active >= config.resumeParseConcurrency) await new Promise<void>((release) => waiting.push(release));
    else active += 1;
    try {
        return await work();
    } finally {
        const next = waiting.shift();
        if (next) next();
        else active -= 1;
    }
}

export async function extractPdf(data: Uint8Array): Promise<ResumeExtract> {
    if (data.length > config.resumeMaxBytes) throw new ExtractError(`That file is larger than ${Math.floor(config.resumeMaxBytes / (1024 * 1024))} MB. Trim it down, or paste the text instead.`);
    if (!hasPdfHeader(data)) throw new ExtractError("That file isn't a PDF. Upload a PDF, or paste the text instead.");
    const extracted = await withSlot(() => parse(data));
    // Lengths and counts only, never the text: logs carry no bodies.
    log.info("resume.extracted", { bytes: data.length, pages: extracted.pages, chars: extracted.text.length, truncated: extracted.truncated });
    return extracted;
}
