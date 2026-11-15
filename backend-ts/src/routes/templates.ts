import { Hono, type Context } from "hono";
import { getCurrentUser } from "../auth.ts";
import { fetch, fetchrow, sql } from "../db.ts";
import { HttpError, jsonBody as jsonBodyText, validationError } from "../errors.ts";
import { TemplateCreate } from "../models.ts";

export const templates = new Hono();

const TEMPLATE_CAP = 20;

const DEFAULT_TEMPLATES = [
    TemplateCreate.parse({ name: "Killer", role: "Software Engineer", company_size: "5k+", cynicism: "skeptical", brutally_honest: true, human_mode: false, hardcore: true, depth: "screen" }),
    TemplateCreate.parse({ name: "Griller", role: "Software Engineer", company_size: "201-1k", cynicism: "skeptical", brutally_honest: true }),
    TemplateCreate.parse({ name: "Chiller", role: "Software Engineer", company_size: "1-10", cynicism: "kind", depth: "screen" }),
];

const DEFAULT_TEMPLATES_ROWS = JSON.stringify(DEFAULT_TEMPLATES);

function listTemplates(ownerId: string) {
    return sql`SELECT id::text, owner_id, name, role, level, topic, resume_id::text, created_at, updated_at, company_size, cynicism, brutally_honest, human_mode, hardcore, depth FROM interview_templates WHERE owner_id = ${ownerId} ORDER BY created_at DESC`;
}

// The marker insert returns a row only the first time, so a deleted default stays deleted. Three rows
// arrive as ONE jsonb parameter. Bound as text and parsed here, because a parameter the server types
// as jsonb is JSON.stringify'd first: the recordset would receive a JSON scalar and refuse it.
// created_at is staggered off `ordinality`, or all three share one timestamp and return in any order.
function seedDefaults(ownerId: string) {
    return sql`
        WITH seed AS (
            INSERT INTO template_seeds (owner_id) VALUES (${ownerId}) ON CONFLICT DO NOTHING RETURNING owner_id
        ), added AS (
            INSERT INTO interview_templates (owner_id, name, role, level, topic, resume_id, company_size, cynicism, brutally_honest, human_mode, hardcore, depth, created_at)
            SELECT ${ownerId}, d.name, d.role, d.level, d.topic, d.resume_id, d.company_size, d.cynicism, d.brutally_honest, d.human_mode, d.hardcore, d.depth, now() - (d.ordinality * interval '1 microsecond')
            FROM seed, ROWS FROM (jsonb_to_recordset((${DEFAULT_TEMPLATES_ROWS}::text)::jsonb) AS (name text, role text, level text, topic text, resume_id uuid, company_size text, cynicism text, brutally_honest boolean, human_mode boolean, hardcore boolean, depth text)) WITH ORDINALITY AS d
            RETURNING id::text, owner_id, name, role, level, topic, resume_id::text, created_at, updated_at, company_size, cynicism, brutally_honest, human_mode, hardcore, depth
        )
        SELECT * FROM added ORDER BY created_at DESC
        `;
}

async function templateBody(c: Context): Promise<TemplateCreate> {
    const parsed = TemplateCreate.safeParse(jsonBodyText(await c.req.text()));
    if (!parsed.success) throw validationError(parsed.error, "body");
    return parsed.data;
}

templates.get("/templates", async (c) => {
    const user = await getCurrentUser(c);
    let rows = await fetch(listTemplates(user.sub));
    // AI HERE: a brand-new owner seeds on the first read. Seeding at owner creation needs a user row
    // and Clerk owns identity, so the first-request hook is the upgrade.
    if (rows.length === 0) {
        const seeded = await fetch(seedDefaults(user.sub));
        rows = seeded.length > 0 ? seeded : await fetch(listTemplates(user.sub));
    }
    return c.json(rows);
});

templates.post("/templates", async (c) => {
    const user = await getCurrentUser(c);
    const body = await templateBody(c);
    // Cap and resume ownership checked inside the INSERT: one round trip, no pre-count race.
    const row = await fetchrow(sql`
        INSERT INTO interview_templates (owner_id, name, role, level, topic, resume_id, company_size, cynicism, brutally_honest, human_mode, hardcore, depth)
        SELECT ${user.sub}, ${body.name}, ${body.role}, ${body.level}, ${body.topic}, ${body.resume_id}::uuid, ${body.company_size}, ${body.cynicism}, ${body.brutally_honest}, ${body.human_mode}, ${body.hardcore}, ${body.depth}
        WHERE (SELECT count(*) FROM interview_templates WHERE owner_id = ${user.sub}) < ${TEMPLATE_CAP}
          AND (${body.resume_id}::uuid IS NULL OR EXISTS (SELECT 1 FROM resumes WHERE id = ${body.resume_id}::uuid AND owner_id = ${user.sub}))
        RETURNING id::text, owner_id, name, role, level, topic, resume_id::text, created_at, updated_at, company_size, cynicism, brutally_honest, human_mode, hardcore, depth
        `);
    if (row === undefined) {
        // Distinguish the two no-row causes: a foreign resume is a 404, the cap is a 409.
        if (body.resume_id !== null && (await fetchrow(sql`SELECT 1 FROM resumes WHERE id = ${body.resume_id} AND owner_id = ${user.sub}`)) === undefined) {
            throw new HttpError(404, "Resume not found");
        }
        throw new HttpError(409, `Template limit reached (${TEMPLATE_CAP}); delete one to save another.`);
    }
    return c.json(row, 201);
});

templates.put("/templates/:template_id", async (c) => {
    const user = await getCurrentUser(c);
    const templateId = c.req.param("template_id");
    const body = await templateBody(c);
    const row = await fetchrow(sql`
        UPDATE interview_templates SET name = ${body.name}, role = ${body.role}, level = ${body.level}, topic = ${body.topic}, resume_id = ${body.resume_id}::uuid, company_size = ${body.company_size}, cynicism = ${body.cynicism}, brutally_honest = ${body.brutally_honest}, human_mode = ${body.human_mode}, hardcore = ${body.hardcore}, depth = ${body.depth}, updated_at = now()
        WHERE id = ${templateId} AND owner_id = ${user.sub} AND (${body.resume_id}::uuid IS NULL OR EXISTS (SELECT 1 FROM resumes WHERE id = ${body.resume_id}::uuid AND owner_id = ${user.sub}))
        RETURNING id::text, owner_id, name, role, level, topic, resume_id::text, created_at, updated_at, company_size, cynicism, brutally_honest, human_mode, hardcore, depth
        `);
    if (row === undefined) {
        if (body.resume_id !== null && (await fetchrow(sql`SELECT 1 FROM resumes WHERE id = ${body.resume_id} AND owner_id = ${user.sub}`)) === undefined) {
            throw new HttpError(404, "Resume not found");
        }
        throw new HttpError(404, "Template not found");
    }
    return c.json(row);
});

templates.delete("/templates/:template_id", async (c) => {
    const user = await getCurrentUser(c);
    const row = await fetchrow(sql`DELETE FROM interview_templates WHERE id = ${c.req.param("template_id")} AND owner_id = ${user.sub} RETURNING id`);
    if (row === undefined) {
        throw new HttpError(404, "Template not found");
    }
    return c.body(null, 204);
});
