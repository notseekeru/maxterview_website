import { strict as assert } from "node:assert";
import { type Context, Hono } from "hono";
import { getCurrentUser } from "../auth.ts";
import { resolveTier, resumeLimit, type Tier } from "../billing.ts";
import { resolveConfig } from "../byok.ts";
import { chatConfig, spendChatTurnOrFail } from "../chatconfig.ts";
import { fetch, fetchrow, sql } from "../db.ts";
import { config } from "../env.ts";
import { HttpError, jsonBody as jsonBodyText, validationError } from "../errors.ts";
import * as latex from "../latex.ts";
import { isStub, type ReviewDraft, reviewResume, rewriteLine } from "../llm.ts";
import { LatexSource, Resume, ResumeCreate, ResumeExtract, ResumeReview, ResumeSummary, ReviewRewriteRequest } from "../models.ts";
import { ExtractError, extractPdf, sanitize } from "../resumes.ts";
import { claim, LINE_MAX, MAX_REWRITES, readsAt, sourceHash } from "../review.ts";

export const resumes = new Hono();

const StoredReview = ResumeReview.omit({ reads_at: true });

function resumeNotFound(): HttpError {
    return new HttpError(404, "Resume not found");
}

async function jsonBody(c: Context): Promise<unknown> {
    return jsonBodyText(await c.req.text());
}

function resumeName(raw: string | null, fallback = "Untitled resume"): string {
    let stem = (raw ?? "").replaceAll("\\", "/");
    stem = stem.slice(stem.lastIndexOf("/") + 1);
    if (stem.toLowerCase().endsWith(".pdf")) stem = stem.slice(0, -4);
    return sanitize(stem, 80).trim() || fallback;
}

assert.deepEqual([resumeName("C:\\docs\\Ada Lovelace.PDF"), resumeName("  ")], ["Ada Lovelace", "Untitled resume"]);

function resumeBody(text: string): string {
    const body = sanitize(text, config.resumeMaxChars);
    if (body === "") throw new HttpError(422, "There is no text to save. Paste some, or upload a PDF with selectable text.");
    return body;
}

function resumeCapError(tier: Tier, cap: number): HttpError {
    if (tier === "free") return new HttpError(402, `The free plan includes ${cap} resume. Delete it to import another, or upgrade to Pro for ${resumeLimit("premium")}.`);
    return new HttpError(409, `You already have ${cap} resumes, the maximum. Delete one to import another.`);
}

function reviewResponse(draft: unknown, createdAt: string, stale: boolean): ResumeReview {
    const parsed = StoredReview.parse({ ...(draft as Record<string, unknown>), created_at: createdAt, stale });
    return { ...parsed, reads_at: readsAt(parsed.levels.map((level) => [level.level, level.call] as const)) };
}

async function insertResume(ownerId: string, tier: Tier, name: string, text: string, pageCount = 0): Promise<Resume> {
    const cap = resumeLimit(tier);
    const row = await fetchrow(sql`
        INSERT INTO resumes (owner_id, name, text, page_count)
        SELECT ${ownerId}, ${resumeName(name)}, ${resumeBody(text)}, ${pageCount}
        WHERE (SELECT count(*) FROM resumes WHERE owner_id = ${ownerId}) < ${cap}
        RETURNING id::text, owner_id, name, page_count, created_at, updated_at, length(text) AS chars, text
        `);
    if (row === undefined) throw resumeCapError(tier, cap);
    return Resume.parse(row);
}

resumes.get("/resumes", async (c) => {
    const user = await getCurrentUser(c);
    const rows = await fetch(sql`
        SELECT id::text, owner_id, name, page_count, created_at, updated_at, length(text) AS chars
        FROM resumes WHERE owner_id = ${user.sub} ORDER BY created_at DESC
        `);
    return c.json(ResumeSummary.array().parse(rows));
});

resumes.get("/resumes/:resume_id", async (c) => {
    const user = await getCurrentUser(c);
    const row = await fetchrow(sql`
        SELECT id::text, owner_id, name, page_count, created_at, updated_at, length(text) AS chars, text
        FROM resumes WHERE id = ${c.req.param("resume_id")} AND owner_id = ${user.sub}
        `);
    if (row === undefined) throw resumeNotFound();
    return c.json(Resume.parse(row));
});

resumes.post("/resumes/extract", async (c) => {
    await getCurrentUser(c);
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw new HttpError(422, [{ loc: ["body", "file"], msg: "Field required" }]);
    // python-multipart's `read(MAX_BYTES + 1)`: one byte past the cap is enough to know it is over.
    const data = new Uint8Array(await file.slice(0, config.resumeMaxBytes + 1).arrayBuffer());
    if (data.length > config.resumeMaxBytes) throw new HttpError(413, `That file is larger than ${Math.floor(config.resumeMaxBytes / (1024 * 1024))} MB. Trim it down, or paste the text instead.`);
    let extracted: ResumeExtract;
    try {
        extracted = await extractPdf(data);
    } catch (error) {
        // The message is written for the user by resumes.ts; pdf.js's own messages never reach a response body.
        if (error instanceof ExtractError) throw new HttpError(422, error.message);
        throw error;
    }
    return c.json(ResumeExtract.parse(extracted));
});

resumes.post("/resumes", async (c) => {
    const user = await getCurrentUser(c);
    const body = ResumeCreate.safeParse(await jsonBody(c));
    if (!body.success) throw validationError(body.error);
    return c.json(await insertResume(user.sub, await resolveTier(user), body.data.name, body.data.text), 201);
});

resumes.put("/resumes/:resume_id", async (c) => {
    const user = await getCurrentUser(c);
    const body = ResumeCreate.safeParse(await jsonBody(c));
    if (!body.success) throw validationError(body.error);
    const row = await fetchrow(sql`
        UPDATE resumes SET name = ${resumeName(body.data.name)}, text = ${resumeBody(body.data.text)}, updated_at = now()
        WHERE id = ${c.req.param("resume_id")} AND owner_id = ${user.sub}
        RETURNING id::text, owner_id, name, page_count, created_at, updated_at, length(text) AS chars, text
        `);
    if (row === undefined) throw resumeNotFound();
    return c.json(Resume.parse(row));
});

resumes.delete("/resumes/:resume_id", async (c) => {
    const user = await getCurrentUser(c);
    // Interviews and presets attached to it keep their rows: the FK is ON DELETE SET NULL, so a run keeps
    // its transcript and merely stops being tailored to a resume that no longer exists.
    const row = await fetchrow(sql`DELETE FROM resumes WHERE id = ${c.req.param("resume_id")} AND owner_id = ${user.sub} RETURNING id`);
    if (row === undefined) throw resumeNotFound();
    return c.body(null, 204);
});

// A review is derived from one column of a resume, so it dies with the resume (CASCADE). An edit does NOT
// retire it: the review is what the candidate paid a turn for, so it stays on the page marked stale and the
// next review replaces it. sha256 runs in Postgres: the alternative is pulling 60k chars over the wire to hash them here.
resumes.get("/resumes/:resume_id/review", async (c) => {
    const user = await getCurrentUser(c);
    const row = await fetchrow(sql`
        SELECT rr.review, rr.created_at, rr.source_hash = encode(sha256(convert_to(r.text, 'UTF8')), 'hex') AS fresh
        FROM resume_reviews rr JOIN resumes r ON r.id = rr.resume_id
        WHERE rr.resume_id = ${c.req.param("resume_id")} AND r.owner_id = ${user.sub}
        `);
    if (row === undefined) return c.json(null);
    return c.json(reviewResponse(row.review, row.created_at as string, !row.fresh));
});

resumes.post("/resumes/:resume_id/review", async (c) => {
    const resumeId = c.req.param("resume_id");
    const user = await getCurrentUser(c);
    const tier = await resolveTier(user);
    const config = chatConfig(await resolveConfig(user), tier);
    const row = await fetchrow(sql`SELECT text FROM resumes WHERE id = ${resumeId} AND owner_id = ${user.sub}`);
    if (row === undefined) throw resumeNotFound();
    if (isStub(config)) throw new HttpError(503, "No scoring engine is configured on this deployment, so a review cannot run.");
    await spendChatTurnOrFail(user, config, tier);
    const got = await reviewResume(row.text as string, config);
    if (got === null) throw new HttpError(503, "The reviewer could not read this resume right now. Try again in a moment.");
    const saved = await fetchrow(sql`
        INSERT INTO resume_reviews (resume_id, source_hash, review) VALUES (${resumeId}, ${sourceHash(row.text as string)}, ${got})
        ON CONFLICT (resume_id) DO UPDATE SET source_hash = EXCLUDED.source_hash, review = EXCLUDED.review, created_at = now()
        RETURNING review, created_at
        `);
    assert(saved !== undefined);
    return c.json(reviewResponse(saved.review, saved.created_at as string, false), 201);
});

resumes.post("/resumes/:resume_id/review/rewrite", async (c) => {
    const resumeId = c.req.param("resume_id");
    const user = await getCurrentUser(c);
    const body = ReviewRewriteRequest.safeParse(await jsonBody(c));
    if (!body.success) throw validationError(body.error);
    const tier = await resolveTier(user);
    const config = chatConfig(await resolveConfig(user), tier);
    const row = await fetchrow(sql`
        SELECT r.text, rr.review
        FROM resumes r
        LEFT JOIN resume_reviews rr ON rr.resume_id = r.id AND rr.source_hash = encode(sha256(convert_to(r.text, 'UTF8')), 'hex')
        WHERE r.id = ${resumeId} AND r.owner_id = ${user.sub}
        `);
    if (row === undefined) throw resumeNotFound();
    // The client returns a line the reviewer quoted from this page. One it cannot find is either stale or
    // forged, and either way it is not a line of this resume.
    const text = row.text as string;
    const source = claim(body.data.source, LINE_MAX);
    const flat = text.trim().split(/\s+/).join(" ");
    if (source === "" || (!text.includes(source) && !flat.includes(source))) throw new HttpError(422, "That line is not on this resume any more. Re-review it and try again.");
    const current = row.review as ReviewDraft | null;
    if (current === null) throw new HttpError(409, "Review this resume first: there is no edit to retry.");
    if (isStub(config)) throw new HttpError(503, "No scoring engine is configured on this deployment, so an edit cannot be retried.");
    await spendChatTurnOrFail(user, config, tier);
    const got = await rewriteLine(text, source, config);
    if (got === null) throw new HttpError(503, "The reviewer could not write a different line right now. Try again in a moment.");
    const stored = { ...current, rewrites: [{ source, rewrite: got }, ...(current.rewrites ?? []).filter((item) => item.source !== source)].slice(0, MAX_REWRITES) };
    const saved = await fetchrow(sql`UPDATE resume_reviews SET review = ${stored} WHERE resume_id = ${resumeId} RETURNING review, created_at`);
    assert(saved !== undefined);
    return c.json(reviewResponse(saved.review, saved.created_at as string, false));
});

// The LaTeX preview compiles the text in the request, not the stored row: an editor has to render the
// edit the candidate is typing. Ownership is the only thing this needs from the database.
resumes.post("/resumes/preview", async (c) => {
    await getCurrentUser(c);
    const body = LatexSource.safeParse(await jsonBody(c));
    if (!body.success) throw validationError(body.error);
    if (!body.data.text.includes("\\documentclass")) throw new HttpError(422, "That is not a LaTeX document: it needs a \\documentclass line.");
    if (!latex.available()) throw new HttpError(503, "No LaTeX engine is installed on this deployment.");
    let pdf: Buffer;
    try {
        pdf = await latex.compilePdf(body.data.text);
    } catch (error) {
        if (error instanceof latex.CompileBusy) return c.json({ detail: "The preview is busy. Try again in a moment." }, 503, { "retry-after": "5" });
        if (error instanceof latex.CompileError) throw new HttpError(422, error.detail);
        throw error;
    }
    return c.body(new Uint8Array(pdf), 200, { "content-type": "application/pdf", "cache-control": "no-store" });
});
