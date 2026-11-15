import { Hono } from "hono";
import type { Context } from "hono";
import type { Row } from "postgres";
import { z } from "zod";
import { getCurrentUser } from "../auth.ts";
import { resolveConfig } from "../byok.ts";
import { fetch, fetchrow, getPool } from "../db.ts";
import { DIAL_FIELDS, planPhases } from "../dials.ts";
import { HttpError, jsonBody as jsonBodyText, validationError } from "../errors.ts";
import { autoGenerateAndPersistFeedback } from "../feedback.ts";
import { Interview, InterviewCreate } from "../models.ts";
import { grade } from "../rating.ts";

// Shared: a query that forgets a dial returns the field's default, so the row is silently wrong rather
// than an error.
const INTERVIEW_COLS = `id::text, owner_id, role, level, topic, resume_id::text, status, created_at, updated_at, failed_turn, failed_class, archived_at, ${DIAL_FIELDS.join(", ")}`;

// AI HERE: main.py built these statements with an f-string. postgres.js cannot put a generated column
// list inside a tagged template, so the text is built from constants here and handed to unsafe(), which
// still sends the same $1-style statement asyncpg saw, placeholders and all.
function unsafe(text: string, ...parameters: (string | number | boolean | null)[]) {
    return getPool().unsafe(text, parameters);
}

// Accuracy arrives only on the list query (from the feedback join); a row without the column reads as
// ungraded, exactly as the model's None default did.
function toInterview(row: Row): Interview {
    return Interview.parse({ ...row, grade: grade(row.accuracy ?? null, row.failed_turn != null), plan: planPhases(row.depth) });
}

const LIST = `
        SELECT i.id::text, i.owner_id, i.role, i.level, i.topic, i.resume_id::text, i.status, i.created_at, i.updated_at,
               ${DIAL_FIELDS.map((field) => `i.${field}`).join(", ")},
               i.failed_turn, i.failed_class, i.archived_at,
               f.verdict AS verdict, f.decision AS decision, f.certainty AS certainty, f.accuracy AS accuracy
        FROM interviews i
        LEFT JOIN feedback f ON f.interview_id = i.id
        WHERE i.owner_id = $1
          AND ($2::bool IS NULL OR (i.archived_at IS NOT NULL) = $2)
        ORDER BY i.created_at DESC
        LIMIT $3 OFFSET $4
        `;

const CREATE = `
        INSERT INTO interviews (owner_id, role, level, topic, resume_id, ${DIAL_FIELDS.join(", ")})
        SELECT $1, $2, $3, $4, $5::uuid, ${DIAL_FIELDS.map((_, index) => `$${index + 6}`).join(", ")}
        WHERE $5::uuid IS NULL OR EXISTS (SELECT 1 FROM resumes WHERE id = $5::uuid AND owner_id = $1)
        RETURNING ${INTERVIEW_COLS}`;

const GET = `SELECT ${INTERVIEW_COLS} FROM interviews WHERE id = $1 AND owner_id = $2`;

const REMOVE = "DELETE FROM interviews WHERE id = $1 AND owner_id = $2 RETURNING id";

const ARCHIVE = `UPDATE interviews SET archived_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE id = $1 AND owner_id = $2 RETURNING ${INTERVIEW_COLS}`;

const START = `UPDATE interviews SET status = 'in_progress', updated_at = now() WHERE id = $1 AND owner_id = $2 AND status = 'pending' RETURNING ${INTERVIEW_COLS}`;

// The row must hold a CANDIDATE turn: the generated opener is an assistant row, so a run that never
// answered anything is not completable.
const FINISH = `UPDATE interviews SET status = 'completed', updated_at = now() WHERE id = $1 AND owner_id = $2 AND status = 'in_progress' AND EXISTS (SELECT 1 FROM chat_turns m WHERE m.interview_id = interviews.id AND m.role = 'user') RETURNING ${INTERVIEW_COLS}`;

const TRUTHY = new Set(["1", "on", "t", "true", "y", "yes"]);
const FALSY = new Set(["0", "off", "f", "false", "n", "no"]);

const Integer = z
    .string()
    .regex(/^[+-]?\d+$/, "Input should be a valid integer, unable to parse string as an integer")
    .transform((value) => Number(value));

const ListQuery = z.object({
    limit: Integer.pipe(z.number().min(1, "Input should be greater than or equal to 1").max(200, "Input should be less than or equal to 200")),
    offset: Integer.pipe(z.number().min(0, "Input should be greater than or equal to 0")),
    archived: z
        .string()
        .transform((value, ctx) => {
            const lower = value.toLowerCase();
            if (TRUTHY.has(lower)) return true;
            if (FALSY.has(lower)) return false;
            ctx.addIssue({ code: "custom", message: "Input should be a valid boolean, unable to interpret input" });
            return z.NEVER;
        })
        .nullable(),
});

async function jsonBody(c: Context): Promise<unknown> {
    return jsonBodyText(await c.req.text());
}

async function setArchived(interviewId: string, ownerId: string, archived: boolean): Promise<Row> {
    const row = await fetchrow(unsafe(ARCHIVE, interviewId, ownerId, archived));
    if (row === undefined) throw new HttpError(404, "Interview not found");
    return row;
}

// Distinguish "foreign/not found" (404) from "already started" (409).
async function startError(interviewId: string, ownerId: string): Promise<HttpError> {
    const row = await fetchrow(unsafe("SELECT status FROM interviews WHERE id = $1 AND owner_id = $2", interviewId, ownerId));
    if (row === undefined) return new HttpError(404, "Interview not found");
    return new HttpError(409, "Interview is not pending");
}

async function finishError(interviewId: string, ownerId: string): Promise<HttpError> {
    const row = await fetchrow(unsafe("SELECT status FROM interviews WHERE id = $1 AND owner_id = $2", interviewId, ownerId));
    if (row === undefined) return new HttpError(404, "Interview not found");
    // In progress but the UPDATE matched nothing => no gradable turns.
    if (row.status === "in_progress") return new HttpError(409, "Nothing to score yet: send at least one message before completing.");
    return new HttpError(409, "Interview is not in progress");
}

export const interviews = new Hono();

// Accuracy is the derived 0-100 move-review average, not recomputed here: the class -> points -> grade
// scale lives only in rating.ts, and `grade` is a computed field on the model.
interviews.get("/interviews", async (c) => {
    const user = await getCurrentUser(c);
    const raw = c.req.query();
    const parsed = ListQuery.safeParse({ limit: raw.limit ?? "50", offset: raw.offset ?? "0", archived: raw.archived ?? null });
    if (!parsed.success) throw validationError(parsed.error, "query");
    const { limit, offset, archived } = parsed.data;
    const rows = await fetch(unsafe(LIST, user.sub, archived, limit, offset));
    return c.json(rows.map(toInterview));
});

interviews.post("/interviews", async (c) => {
    const user = await getCurrentUser(c);
    const parsed = InterviewCreate.safeParse(await jsonBody(c));
    if (!parsed.success) throw validationError(parsed.error);
    const body = parsed.data;
    // A None row here means a foreign or deleted id; this path has no cap to confuse it with.
    const row = await fetchrow(unsafe(CREATE, user.sub, body.role, body.level, body.topic, body.resume_id, ...DIAL_FIELDS.map((field) => body[field])));
    if (row === undefined) throw new HttpError(404, "Resume not found");
    return c.json(toInterview(row), 201);
});

interviews.get("/interviews/:interview_id", async (c) => {
    const user = await getCurrentUser(c);
    const interviewId = c.req.param("interview_id");
    const row = await fetchrow(unsafe(GET, interviewId, user.sub));
    if (row === undefined) throw new HttpError(404, "Interview not found");
    return c.json(toInterview(row));
});

interviews.delete("/interviews/:interview_id", async (c) => {
    const user = await getCurrentUser(c);
    const interviewId = c.req.param("interview_id");
    const row = await fetchrow(unsafe(REMOVE, interviewId, user.sub));
    if (row === undefined) throw new HttpError(404, "Interview not found");
    return c.body(null, 204);
});

interviews.post("/interviews/:interview_id/archive", async (c) => {
    const user = await getCurrentUser(c);
    return c.json(toInterview(await setArchived(c.req.param("interview_id"), user.sub, true)));
});

interviews.delete("/interviews/:interview_id/archive", async (c) => {
    const user = await getCurrentUser(c);
    return c.json(toInterview(await setArchived(c.req.param("interview_id"), user.sub, false)));
});

interviews.post("/interviews/:interview_id/start", async (c) => {
    const user = await getCurrentUser(c);
    const interviewId = c.req.param("interview_id");
    const row = await fetchrow(unsafe(START, interviewId, user.sub));
    if (row === undefined) throw await startError(interviewId, user.sub);
    return c.json(toInterview(row));
});

interviews.post("/interviews/:interview_id/finish", async (c) => {
    const user = await getCurrentUser(c);
    const interviewId = c.req.param("interview_id");
    const llmConfig = await resolveConfig(user);
    const row = await fetchrow(unsafe(FINISH, interviewId, user.sub));
    if (row === undefined) throw await finishError(interviewId, user.sub);
    const interview = toInterview(row);
    await autoGenerateAndPersistFeedback(interviewId, llmConfig);
    return c.json(interview);
});
