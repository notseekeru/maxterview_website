import { generateKeyPairSync } from "node:crypto";
import dc from "node:diagnostics_channel";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { fetch as dbFetch, getPool, sql } from "../src/db.ts";
import { planPhases } from "../src/dials.ts";
import { config } from "../src/env.ts";
import * as latex from "../src/latex.ts";
import { GRADER_PROMPT_V1, type LLMConfig, REVIEW_EXAMPLE, REWRITE_LINE_PROMPT, SYSTEM_CONFIG, SYSTEM_PROMPT_V1, UNTRUSTED_INPUT } from "../src/llm.ts";
import { RUNGS } from "../src/review.ts";
import { client, type RequestOptions } from "./helpers/client.ts";
import { withConfig } from "./helpers/config.ts";
import { type HttpStub, json, sse, stubHttp } from "./helpers/http.ts";
import { encrypted, miniPdf } from "./helpers/pdf.ts";

const USAGE = "/api/billing/usage";
const DASHBOARD = "/api/stats/dashboard";
const LLM_URL = "http://llm.test/v1/chat/completions";
const JWKS_URL = "https://clerk.test/jwks";
const MISSING = "00000000-0000-0000-0000-000000000000";

type Row = Record<string, unknown>;
type Param = string | number | boolean | null | Record<string, number>;

async function queryRows<T extends Row>(text: string, parameters: Param[] = []): Promise<T[]> {
    return (await getPool().unsafe(text, parameters)) as unknown as T[];
}

async function queryOne<T extends Row>(text: string, parameters: Param[] = []): Promise<T | undefined> {
    return (await queryRows<T>(text, parameters))[0];
}

async function run(text: string, parameters: Param[] = []): Promise<void> {
    await queryRows(text, parameters);
}

function pick(value: Row, expected: Row): Row {
    return Object.fromEntries(Object.keys(expected).map((key) => [key, value[key]]));
}

async function listTemplates(): Promise<{ id: string; name: string; [key: string]: unknown }[]> {
    return await (await client.get("/api/templates")).json();
}

async function wipeTemplates(): Promise<void> {
    for (const template of await listTemplates()) expect((await client.delete(`/api/templates/${template.id}`)).status).toBe(204);
}

async function wipeResumes(): Promise<void> {
    for (const resume of await (await client.get("/api/resumes")).json<{ id: string }[]>()) expect((await client.delete(`/api/resumes/${resume.id}`)).status).toBe(204);
}

function resumePayload(name = "CV", text = "Alex Mender - platform engineer. Go, Terraform, Kubernetes."): { name: string; text: string } {
    return { name, text };
}

async function turnsUsed(): Promise<number> {
    return (await (await client.get(USAGE)).json<{ chat_turns_used_today: number }>()).chat_turns_used_today;
}

function llmReply(content: unknown): Response {
    return json({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] });
}

function systemOf(call: { body: string }): string {
    return (JSON.parse(call.body) as { messages: { content: string }[] }).messages[0].content;
}

function userOf(call: { body: string }): string {
    return (JSON.parse(call.body) as { messages: { content: string }[] }).messages[1].content;
}

async function withLiveConfig<T>(body: () => Promise<T>): Promise<T> {
    const saved: LLMConfig = { ...SYSTEM_CONFIG };
    Object.assign(SYSTEM_CONFIG, { base_url: "http://llm.test/v1", model: "qwen-unit-test" });
    try {
        return await body();
    } finally {
        Object.assign(SYSTEM_CONFIG, saved);
    }
}

// test_api.py's `app.dependency_overrides[get_current_user]`: a signed-in, non-premium owner. Expressing
// it as a real token is the only way in here, and it is what makes tier resolution cost its subscription read.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS = { keys: [{ ...publicKey.export({ format: "jwk" }), alg: "RS256", kid: "test-kid" }] };

async function clerkToken(sub: string): Promise<string> {
    const issued = Math.floor(Date.now() / 1000);
    return await new SignJWT({ sub, iss: config.clerkDomain, iat: issued, exp: issued + 3600 }).setProtectedHeader({ alg: "RS256", kid: "test-kid" }).sign(privateKey);
}

function bearer(token: string) {
    const options = (extra: RequestOptions = {}): RequestOptions => ({ ...extra, headers: { authorization: `Bearer ${token}` } });
    return {
        get: (path: string) => client.get(path, options()),
        post: (path: string, extra: RequestOptions = {}) => client.post(path, options(extra)),
        put: (path: string, extra: RequestOptions = {}) => client.put(path, options(extra)),
        delete: (path: string) => client.delete(path, options()),
    };
}

async function clerkStub(): Promise<HttpStub> {
    const stub = stubHttp();
    stub.on("GET", JWKS_URL, () => json(JWKS));
    return stub;
}

describe("interviews", () => {
    it("interview_dials_round_trip_and_default", async () => {
        const made = await client.post("/api/interviews", { json: { role: "Dials Default" } });
        expect(made.status).toBe(201);
        const created = await made.json<Row>();
        expect([created.company_size, created.cynicism, created.brutally_honest, created.human_mode]).toEqual(["any", "neutral", false, true]);
        expect(created.depth).toBe("standard");
        expect(created.plan).toEqual(planPhases("standard"));
        expect((await client.delete(`/api/interviews/${created.id as string}`)).status).toBe(204);

        const roundTrip = await client.post("/api/interviews", {
            json: { role: "Dials Round Trip", level: "staff", company_size: "51-200", cynicism: "skeptical", brutally_honest: true, human_mode: false, depth: "full" },
        });
        expect(roundTrip.status).toBe(201);
        const iid = (await roundTrip.json<{ id: string }>()).id;
        const expected = { company_size: "51-200", cynicism: "skeptical", brutally_honest: true, human_mode: false, depth: "full" };
        const listed = (await (await client.get("/api/interviews")).json<{ id: string }[]>()).find((item) => item.id === iid) as Row;
        for (const payload of [await roundTrip.json<Row>(), await (await client.get(`/api/interviews/${iid}`)).json<Row>(), listed]) {
            expect(pick(payload, expected)).toEqual(expected);
        }

        const started = await (await client.post(`/api/interviews/${iid}/start`)).json<Row>();
        expect(pick(started, expected)).toEqual(expected);
        await client.post(`/api/interviews/${iid}/chat/send`, { json: { interview_id: iid, content: "hello" } });
        const completed = await (await client.post(`/api/interviews/${iid}/finish`)).json<Row>();
        expect(pick(completed, expected)).toEqual(expected);
        expect((await client.delete(`/api/interviews/${iid}`)).status).toBe(204);
    });

    it("interview_dials_reject_values_outside_the_vocabulary", async () => {
        for (const bad of [{ company_size: "1-10k" }, { cynicism: "harsh" }, { depth: "deep" }, { depth: 3 }]) {
            expect((await client.post("/api/interviews", { json: { role: "Bad Dials", ...bad } })).status).toBe(422);
        }
    });

    it("dev_sub_header_owns_the_interview_it_creates", async () => {
        const sub = { "x-dev-sub": "k6-sweep-r1-7" };
        const made = await client.post("/api/interviews", { json: { role: "k6 sweep" }, headers: sub });
        expect(made.status).toBe(201);
        const created = await made.json<{ id: string; owner_id: string }>();
        expect(created.owner_id).toBe("k6-sweep-r1-7");
        const mine = await (await client.get("/api/interviews", { headers: sub })).json<{ id: string; owner_id: string }[]>();
        expect(mine.find((item) => item.id === created.id)?.owner_id).toBe("k6-sweep-r1-7");
        expect((await (await client.get("/api/interviews")).json<{ id: string }[]>()).every((item) => item.id !== created.id)).toBe(true);
        expect((await client.delete(`/api/interviews/${created.id}`, { headers: sub })).status).toBe(204);
    });

    it("dev_sub_header_is_ignored_outside_development", async () => {
        await withConfig({ appEnv: "production" }, async () => {
            const made = await client.post("/api/interviews", { json: { role: "prod header" }, headers: { "x-dev-sub": "k6-sweep-r1-7" } });
            expect(made.status).toBe(201);
            const created = await made.json<{ id: string; owner_id: string }>();
            expect(created.owner_id).toBe("dev-user");
            expect((await client.delete(`/api/interviews/${created.id}`)).status).toBe(204);
        });
    });

    it("dev_sub_header_rejects_a_malformed_value", async () => {
        const made = await client.post("/api/interviews", { json: { role: "bad sub" }, headers: { "x-dev-sub": "bad sub/slash" } });
        expect(made.status).toBe(400);
        expect((await made.json<{ detail: string }>()).detail).toBe("Invalid X-Dev-Sub");
    });

    it("interview_lifecycle_owner_scoped", async () => {
        const made = await client.post("/api/interviews", { json: { role: "Software Engineer", topic: "system design" } });
        expect(made.status).toBe(201);
        const interview = await made.json<{ id: string; owner_id: string; status: string; role: string }>();
        expect(interview.owner_id).toBe("dev-user");
        expect(interview.status).toBe("pending");
        const iid = interview.id;

        const listed = await client.get("/api/interviews");
        expect(listed.status).toBe(200);
        expect((await listed.json<{ id: string }[]>()).some((item) => item.id === iid)).toBe(true);

        const one = await client.get(`/api/interviews/${iid}`);
        expect(one.status).toBe(200);
        expect((await one.json<{ role: string }>()).role).toBe("Software Engineer");

        expect((await client.post(`/api/interviews/${iid}/chat/send`, { json: { interview_id: iid, content: "hi" } })).status).toBe(409);

        const started = await client.post(`/api/interviews/${iid}/start`);
        expect(started.status).toBe(200);
        expect((await started.json<{ status: string }>()).status).toBe("in_progress");
        expect((await client.post(`/api/interviews/${iid}/chat/opening`)).status).toBe(200);
        const sent = await client.post(`/api/interviews/${iid}/chat/send`, { json: { interview_id: iid, content: "I have 5 years of experience." } });
        expect(sent.status).toBe(200);
        expect(sent.headers.get("content-type")).toContain("text/event-stream");

        const chat = await client.get(`/api/interviews/${iid}/chat`);
        expect(chat.status).toBe(200);
        const early = await chat.json<{ role: string }[]>();
        expect(early.some((message) => message.role === "user") && early.some((message) => message.role === "assistant")).toBe(true);

        const finished = await client.post(`/api/interviews/${iid}/finish`);
        expect(finished.status).toBe(200);
        expect((await finished.json<{ status: string }>()).status).toBe("completed");

        type Feedback = { verdict: string; decision: string; certainty: number; accuracy: number; grade: string };
        const feedback = await client.get(`/api/interviews/${iid}/feedback`);
        expect(feedback.status).toBe(200);
        const review = await feedback.json<Feedback>();
        expect(review.verdict).toBeTruthy();
        expect([review.decision, review.certainty]).toEqual(["lean_hire", 40]);
        expect([review.accuracy, review.grade]).toEqual([85, "A"]);

        const messages = await (await client.get(`/api/interviews/${iid}/chat`)).json<{ role: string; move_class: string | null; comment: string | null }[]>();
        expect(messages.filter((message) => message.role === "user").map((message) => message.move_class)).toEqual(["good"]);
        expect(messages.filter((message) => message.role !== "user").every((message) => message.move_class === null)).toBe(true);
        expect(messages.filter((message) => message.move_class !== null).every((message) => message.comment !== null && message.comment !== "")).toBe(true);
        expect(messages.filter((message) => message.role !== "user").every((message) => message.comment === null)).toBe(true);

        const row = (await (await client.get("/api/interviews")).json<Row[]>()).find((item) => item.id === iid) as Row;
        expect([row.decision, row.certainty]).toEqual(["lean_hire", 40]);
        expect([row.accuracy, row.grade]).toEqual([85, "A"]);

        expect((await client.post(`/api/interviews/${iid}/feedback`, { json: { scores: { clarity: 4 }, verdict: "Good", tips: ["be concise"] } })).status).toBe(201);
        expect((await (await client.get(`/api/interviews/${iid}/feedback`)).json<Feedback>()).verdict).toBe("Good");
        const better = await client.post(`/api/interviews/${iid}/feedback`, { json: { scores: { clarity: 5 }, verdict: "Better", tips: ["shorter"], decision: "hire", certainty: 80 } });
        expect(better.status).toBe(201);
        // jsonb_typeof, not the value: a pre-stringified parameter stores a JSON string and every reader
        // downstream (the dashboard's jsonb_each_text, the offer's benefits) then fails on it.
        const stored = await queryOne<{ scores: string; tips: string }>("SELECT jsonb_typeof(scores) AS scores, jsonb_typeof(tips) AS tips FROM feedback WHERE interview_id = $1::uuid", [iid]);
        expect(stored).toEqual({ scores: "object", tips: "array" });
        const updated = await (await client.get(`/api/interviews/${iid}/feedback`)).json<Feedback>();
        expect(updated.verdict).toBe("Better");
        expect([updated.decision, updated.certainty]).toEqual(["hire", 80]);
        expect([updated.accuracy, updated.grade]).toEqual([85, "A"]);

        expect((await client.post(`/api/interviews/${iid}/feedback`, { json: { verdict: "Hmm", decision: "strong_hire", certainty: 80 } })).status).toBe(422);
        expect((await client.post(`/api/interviews/${iid}/feedback`, { json: { verdict: "Hmm", decision: "hire", certainty: 101 } })).status).toBe(422);

        expect((await client.post(`/api/interviews/${iid}/chat/send`, { json: { interview_id: iid, content: "late" } })).status).toBe(409);
        expect([200, 404]).toContain((await client.get(`/api/interviews/${iid}`)).status);
        expect((await client.delete(`/api/interviews/${iid}`)).status).toBe(204);
    });

    it("archive_hides_a_run_from_history_but_keeps_it_in_the_stats", async () => {
        const iid = (await (await client.post("/api/interviews", { json: { role: "Archive Probe" } })).json<{ id: string }>()).id;

        const archived = await client.post(`/api/interviews/${iid}/archive`);
        expect(archived.status).toBe(200);
        const archivedBody = await archived.json<{ archived_at: string | null; status: string }>();
        expect(archivedBody.archived_at).not.toBeNull();
        expect(archivedBody.status).toBe("pending");

        expect((await (await client.get("/api/interviews")).json<{ id: string }[]>()).some((item) => item.id === iid)).toBe(true);
        const listed = (await (await client.get("/api/interviews")).json<{ id: string; archived_at: string | null }[]>()).find((item) => item.id === iid);
        expect(listed?.archived_at).not.toBeNull();
        expect((await (await client.get(`/api/interviews/${iid}`)).json<{ archived_at: string | null }>()).archived_at).not.toBeNull();

        const cleared = await client.delete(`/api/interviews/${iid}/archive`);
        expect(cleared.status).toBe(200);
        expect((await cleared.json<{ archived_at: string | null }>()).archived_at).toBeNull();

        expect((await client.post(`/api/interviews/${MISSING}/archive`)).status).toBe(404);
        expect((await client.delete(`/api/interviews/${MISSING}/archive`)).status).toBe(404);
        expect((await client.delete(`/api/interviews/${iid}`)).status).toBe(204);
    });

    it("default_templates_seeded_once", async () => {
        await wipeTemplates();
        await run("DELETE FROM template_seeds WHERE owner_id = 'dev-user'");

        const seeded = await listTemplates();
        expect(seeded.map((template) => template.name)).toEqual(["Killer", "Griller", "Chiller"]);

        const killer = seeded[0];
        expect([killer.hardcore, killer.brutally_honest, killer.human_mode]).toEqual([true, true, false]);
        expect([killer.company_size, killer.cynicism]).toEqual(["5k+", "skeptical"]);
        const payload: Row = { ...killer };
        for (const key of ["id", "name", "owner_id", "created_at", "updated_at"]) delete payload[key];
        const made = await client.post("/api/interviews", { json: payload });
        expect(made.status).toBe(201);
        expect((await client.delete(`/api/interviews/${(await made.json<{ id: string }>()).id}`)).status).toBe(204);
        expect((await listTemplates()).map((template) => template.id)).toEqual(seeded.map((template) => template.id));

        expect((await client.delete(`/api/templates/${killer.id}`)).status).toBe(204);
        expect((await listTemplates()).map((template) => template.name)).toEqual(["Griller", "Chiller"]);
        await wipeTemplates();
    });

    it("templates_round_trip_rename_and_cap", async () => {
        await wipeTemplates();
        const body = {
            name: "Senior BE @5k",
            role: "Backend Engineer",
            level: "senior",
            topic: "system design",
            company_size: "5k+",
            cynicism: "skeptical",
            brutally_honest: true,
            human_mode: false,
            hardcore: true,
            depth: "full",
        };
        const made = await client.post("/api/interviews", { json: { role: body.role, level: body.level, topic: body.topic, company_size: body.company_size, cynicism: body.cynicism, brutally_honest: body.brutally_honest, human_mode: body.human_mode, hardcore: body.hardcore, depth: body.depth } });
        expect(made.status).toBe(201);
        expect((await client.delete(`/api/interviews/${(await made.json<{ id: string }>()).id}`)).status).toBe(204);

        const created = await client.post("/api/templates", { json: body });
        expect(created.status).toBe(201);
        const preset = await created.json<Row>();
        expect(pick(preset, body)).toEqual(body);
        expect((await listTemplates())[0].id).toBe(preset.id as string);

        const bare = await (await client.post("/api/templates", { json: { name: "Bare", role: "Any Role" } })).json<Row>();
        expect([bare.cynicism, bare.human_mode, bare.depth]).toEqual(["neutral", true, "standard"]);

        const renamed = await client.put(`/api/templates/${preset.id as string}`, { json: { ...body, name: "Renamed", cynicism: "kind" } });
        expect([renamed.status, (await renamed.json<Row>()).name, (await renamed.json<Row>()).cynicism]).toEqual([200, "Renamed", "kind"]);
        expect((await listTemplates()).find((template) => template.id === preset.id)?.cynicism).toBe("kind");

        expect((await client.delete(`/api/templates/${preset.id as string}`)).status).toBe(204);
        expect((await client.delete(`/api/templates/${preset.id as string}`)).status).toBe(404);
        expect((await listTemplates()).map((template) => template.name)).toEqual(["Bare"]);

        for (let n = 2; n <= 20; n += 1) {
            expect((await client.post("/api/templates", { json: { name: `Cap ${n}`, role: "Filler" } })).status).toBe(201);
        }
        const over = await client.post("/api/templates", { json: { name: "Over", role: "Filler" } });
        expect(over.status).toBe(409);
        expect((await over.json<{ detail: string }>()).detail).toContain("20");
        const listed = await listTemplates();
        expect((await client.delete(`/api/templates/${listed.find((template) => template.name === "Cap 2")?.id as string}`)).status).toBe(204);
        expect((await client.post("/api/templates", { json: { name: "Fits", role: "Filler" } })).status).toBe(201);

        await wipeTemplates();
    });

    it("template_owner_scoping", async () => {
        await wipeTemplates();
        const foreign = (await queryOne<{ id: string }>("INSERT INTO interview_templates (owner_id, name, role) VALUES ('someone-else', 'Not yours', 'Backend Engineer') RETURNING id::text"))?.id as string;

        expect((await listTemplates()).every((template) => template.id !== foreign)).toBe(true);
        expect((await client.put(`/api/templates/${foreign}`, { json: { name: "Hijack", role: "Backend Engineer" } })).status).toBe(404);
        expect((await client.delete(`/api/templates/${foreign}`)).status).toBe(404);
        expect((await client.delete(`/api/templates/${MISSING}`)).status).toBe(404);
    });

    it("resume_import_round_trip_and_list_shape", async () => {
        await wipeResumes();
        const got = await client.post("/api/resumes/extract", { files: { file: { name: "cv.pdf", data: miniPdf("Alex Mender - Platform Engineer"), type: "application/pdf" } } });
        expect(got.status).toBe(200);
        const extracted = await got.json<{ text: string; pages: number; truncated: boolean }>();
        expect(extracted.text).toContain("Alex Mender");
        expect([extracted.pages, extracted.truncated]).toEqual([1, false]);

        const made = await client.post("/api/resumes", { json: { name: "cv.pdf", text: extracted.text } });
        expect(made.status).toBe(201);
        const row = await made.json<{ id: string; name: string; page_count: number; chars: number; text: string }>();
        expect([row.name, row.page_count, row.chars]).toEqual(["cv", 0, extracted.text.length]);

        const listed = await (await client.get("/api/resumes")).json<Row[]>();
        expect(listed[0].id).toBe(row.id);
        expect("text" in listed[0]).toBe(false);
        expect((await (await client.get(`/api/resumes/${row.id}`)).json<{ text: string }>()).text).toBe(extracted.text);

        const fixed = await client.put(`/api/resumes/${row.id}`, { json: { name: "CV fixed", text: "Corrected." } });
        expect(fixed.status).toBe(200);
        const fixedBody = await fixed.json<{ name: string; text: string; chars: number }>();
        expect([fixedBody.name, fixedBody.text, fixedBody.chars]).toEqual(["CV fixed", "Corrected.", 10]);

        expect((await client.delete(`/api/resumes/${row.id}`)).status).toBe(204);
        expect((await client.delete(`/api/resumes/${row.id}`)).status).toBe(404);
        expect((await client.get(`/api/resumes/${row.id}`)).status).toBe(404);
    });

    it("resume_import_rejects_documents_it_cannot_read", async () => {
        const upload = (data: Uint8Array) => client.post("/api/resumes/extract", { files: { file: { name: "cv.pdf", data, type: "application/pdf" } } });

        expect((await upload(new TextEncoder().encode("<html>not a pdf at all</html>"))).status).toBe(422);
        expect((await (await upload(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).json<{ detail: string }>()).detail).toContain("isn't a PDF");
        const oversized = new Uint8Array(5 + config.resumeMaxBytes + 1);
        oversized.set(new TextEncoder().encode("%PDF-"));
        expect((await upload(oversized)).status).toBe(413);
        expect((await (await upload(encrypted())).json<{ detail: string }>()).detail).toContain("password-protected");
        expect((await (await upload(miniPdf(""))).json<{ detail: string }>()).detail).toContain("Paste the text instead");
    });

    it("resume_tier_caps_free_is_402_paid_is_409", async () => {
        await wipeResumes();
        await clerkStub();
        const as = bearer(await clerkToken("dev-user"));

        await withConfig({ clerkEnabled: true, clerkJwksUrl: JWKS_URL, freeResumes: 1 }, async () => {
            expect((await as.post("/api/resumes", { json: resumePayload("Free one") })).status).toBe(201);
            const over = await as.post("/api/resumes", { json: resumePayload("Free two") });
            expect(over.status).toBe(402);
            expect((await over.json<{ detail: string }>()).detail.toLowerCase()).toContain("upgrade");
            expect((await (await as.get(USAGE)).json<{ resume_limit: number }>()).resume_limit).toBe(1);
            expect((await as.delete(`/api/resumes/${(await (await as.get("/api/resumes")).json<{ id: string }[]>())[0].id}`)).status).toBe(204);
            expect((await as.post("/api/resumes", { json: resumePayload("Free two") })).status).toBe(201);
        });

        await withConfig({ devResumes: 2 }, async () => {
            expect((await client.post("/api/resumes", { json: resumePayload("Paid one") })).status).toBe(201);
            const full = await client.post("/api/resumes", { json: resumePayload("Paid two") });
            expect(full.status).toBe(409);
            expect((await full.json<{ detail: string }>()).detail).toContain("maximum");
        });
        await wipeResumes();
    });

    it("resume_owner_scoping", async () => {
        await wipeResumes();
        const foreign = (await queryOne<{ id: string }>("INSERT INTO resumes (owner_id, name, text) VALUES ('someone-else', 'Not yours', 'secret') RETURNING id::text"))?.id as string;

        expect((await (await client.get("/api/resumes")).json<{ id: string }[]>()).every((item) => item.id !== foreign)).toBe(true);
        expect((await client.get(`/api/resumes/${foreign}`)).status).toBe(404);
        expect((await client.put(`/api/resumes/${foreign}`, { json: resumePayload("Hijack") })).status).toBe(404);
        expect((await client.delete(`/api/resumes/${foreign}`)).status).toBe(404);
        expect((await client.post("/api/interviews", { json: { role: "Backend Engineer", resume_id: foreign } })).status).toBe(404);
        expect((await client.post("/api/templates", { json: { name: "Steal", role: "Backend Engineer", resume_id: foreign } })).status).toBe(404);
        expect((await client.post("/api/interviews", { json: { role: "Backend Engineer", resume_id: "not-a-uuid" } })).status).toBe(422);
    });

    it("resume_attaches_to_an_interview_and_outlives_its_delete", async () => {
        await wipeResumes();
        const rid = (await (await client.post("/api/resumes", { json: resumePayload("Attach me") })).json<{ id: string }>()).id;
        const made = await client.post("/api/interviews", { json: { role: "Backend Engineer", resume_id: rid } });
        expect(made.status).toBe(201);
        const interview = await made.json<{ id: string; resume_id: string | null }>();
        expect(interview.resume_id).toBe(rid);
        expect((await (await client.get(`/api/interviews/${interview.id}`)).json<{ resume_id: string | null }>()).resume_id).toBe(rid);
        expect((await (await client.get("/api/interviews")).json<{ id: string; resume_id: string | null }[]>()).find((item) => item.id === interview.id)?.resume_id).toBe(rid);

        expect((await client.delete(`/api/resumes/${rid}`)).status).toBe(204);
        const after = await client.get(`/api/interviews/${interview.id}`);
        expect(after.status).toBe(200);
        expect((await after.json<{ resume_id: string | null }>()).resume_id).toBeNull();
        expect((await client.delete(`/api/interviews/${interview.id}`)).status).toBe(204);
    });

    it("template_remembers_the_resume", async () => {
        await wipeResumes();
        const rid = (await (await client.post("/api/resumes", { json: resumePayload("Preset resume") })).json<{ id: string }>()).id;
        const created = await client.post("/api/templates", { json: { name: "With resume", role: "Backend Engineer", resume_id: rid } });
        expect(created.status).toBe(201);
        const template = await created.json<{ id: string; resume_id: string | null }>();
        expect(template.resume_id).toBe(rid);

        const renamed = await client.put(`/api/templates/${template.id}`, { json: { name: "Renamed", role: "Backend Engineer", resume_id: rid } });
        expect((await renamed.json<{ resume_id: string | null }>()).resume_id).toBe(rid);
        const detached = await client.put(`/api/templates/${template.id}`, { json: { name: "Renamed", role: "Backend Engineer" } });
        expect((await detached.json<{ resume_id: string | null }>()).resume_id).toBeNull();
        const reattached = await client.put(`/api/templates/${template.id}`, { json: { name: "Renamed", role: "Backend Engineer", resume_id: rid } });
        expect((await reattached.json<{ resume_id: string | null }>()).resume_id).toBe(rid);

        expect((await client.delete(`/api/resumes/${rid}`)).status).toBe(204);
        expect((await listTemplates())[0].resume_id).toBeNull();
        expect((await client.delete(`/api/templates/${template.id}`)).status).toBe(204);
    });

    it("resume_write_paths_share_one_hygiene", async () => {
        await wipeResumes();
        const made = await client.post("/api/resumes", { json: { name: "Hi\u200bthere", text: "Line one\u200b\u202e\n\n\n\nLine two" } });
        expect(made.status).toBe(201);
        const row = await made.json<{ id: string; name: string }>();
        expect(row.name).toBe("Hithere");
        expect((await (await client.get(`/api/resumes/${row.id}`)).json<{ text: string }>()).text).toBe("Line one\n\nLine two");
        expect((await client.post("/api/resumes", { json: { name: "Empty", text: "   \n\u200b  " } })).status).toBe(422);
        expect((await client.put(`/api/resumes/${row.id}`, { json: { name: "Empty", text: " " } })).status).toBe(422);
        expect((await client.delete(`/api/resumes/${row.id}`)).status).toBe(204);
    });

    it("resume_review_survives_an_edit_and_is_marked_stale", async () => {
        await wipeResumes();
        const rid = (await (await client.post("/api/resumes", { json: resumePayload("Review me", "Alex cut p99 from 40s to 900ms on a 40-node K3s cluster.") })).json<{ id: string }>()).id;
        expect(await (await client.get(`/api/resumes/${rid}/review`)).json()).toBeNull();

        const stub = stubHttp();
        stub.post(LLM_URL, () => llmReply(REVIEW_EXAMPLE));

        type Review = { verdict: string; levels: { level: string }[]; reads_at: string; stale: boolean; created_at: string };
        let body: Review | undefined;
        await withLiveConfig(async () => {
            const turns = await turnsUsed();
            const made = await client.post(`/api/resumes/${rid}/review`);
            expect(made.status).toBe(201);
            expect(await turnsUsed()).toBe(turns + 1);
            expect(stub.calls[0].body).toContain("40-node K3s cluster");
            body = await made.json<Review>();
        });
        const created = body as Review;
        expect([created.reads_at, created.levels.length, created.levels[0].level]).toEqual(["mid", RUNGS.length, "intern"]);
        expect(created.stale).toBe(false);
        expect((await queryOne<{ kind: string }>("SELECT jsonb_typeof(review) AS kind FROM resume_reviews WHERE resume_id = $1::uuid", [rid]))?.kind).toBe("object");
        expect((await (await client.get(`/api/resumes/${rid}/review`)).json<{ verdict: string }>()).verdict).toBe(created.verdict);

        expect((await client.put(`/api/resumes/${rid}`, { json: resumePayload("Review me", "Rewritten.") })).status).toBe(200);
        const kept = await (await client.get(`/api/resumes/${rid}/review`)).json<Review>();
        expect([kept.verdict, kept.stale, kept.created_at]).toEqual([created.verdict, true, created.created_at]);

        expect((await client.delete(`/api/resumes/${rid}`)).status).toBe(204);
        expect(await (await client.get(`/api/resumes/${rid}/review`)).json()).toBeNull();
        expect((await client.post(`/api/resumes/${rid}/review`)).status).toBe(404);
    });

    it("resume_reaches_both_prompts_from_the_database", async () => {
        await wipeResumes();
        const rid = (await (await client.post("/api/resumes", { json: resumePayload("Fodder", "Alex ran a 40-node K3s cluster and cut p99 from 40s to 900ms.") })).json<{ id: string }>()).id;
        const iid = (await (await client.post("/api/interviews", { json: { role: "Platform Engineer", resume_id: rid } })).json<{ id: string }>()).id;
        await client.post(`/api/interviews/${iid}/start`);
        await client.post(`/api/interviews/${iid}/chat/opening`);

        const stub = stubHttp();
        stub.post(LLM_URL, (call) => {
            const system = systemOf(call);
            if (system.startsWith(SYSTEM_PROMPT_V1)) return sse(["Tell me about the cluster."]);
            if (system.startsWith(GRADER_PROMPT_V1)) return llmReply("Alex was concrete about the cluster.");
            throw new Error(`unexpected prompt: ${system.slice(0, 80)}`);
        });

        await withLiveConfig(async () => {
            const sent = await client.post(`/api/interviews/${iid}/chat/send`, { json: { interview_id: iid, content: "hi" } });
            expect(await sent.text()).toContain("Tell me about the cluster.");
            const interviewer = systemOf(stub.calls[0]);
            expect(interviewer).toContain("40-node K3s cluster");
            expect(interviewer.startsWith(SYSTEM_PROMPT_V1)).toBe(true);
            expect((await client.post(`/api/interviews/${iid}/chat/send`, { json: { interview_id: iid, content: "I run the platform team." } })).status).toBe(200);
            await client.post(`/api/interviews/${iid}/finish`);
        });

        const grader = stub.calls.map(systemOf).find((system) => system.startsWith(GRADER_PROMPT_V1)) ?? "";
        expect(grader).toContain("40-node K3s cluster");
        expect(grader).toContain("A resume IS attached");
        expect(grader).toContain(UNTRUSTED_INPUT);
        expect((await client.delete(`/api/interviews/${iid}`)).status).toBe(204);
    });

    it("dimensions_aggregate_averages_rated_runs_and_the_newest_window", async () => {
        const seeds: [number, string, string, number | null, Record<string, number>][] = [
            [60, "Dim oldest", "completed", 60, { clarity: 1, structure: 10 }],
            [50, "Dim old", "completed", 60, { clarity: 2 }],
            [40, "Dim mid", "completed", 60, { clarity: 3 }],
            [30, "Dim newer", "completed", 60, { clarity: 4 }],
            [20, "Dim recent", "completed", 60, { clarity: 5 }],
            [10, "Dim newest", "completed", 60, { clarity: 6, structure: 4 }],
            [1, "Dim unrated", "completed", null, { clarity: 9, structure: 9 }],
            [0, "Dim unfinished", "in_progress", 90, { clarity: 10 }],
        ];
        const ids: string[] = [];
        for (const [ageMin, role, status, acc, scores] of seeds) {
            const made = (await queryOne<{ id: string }>("INSERT INTO interviews (owner_id, role, status, created_at) VALUES ('dev-user', $1, $2, now() - make_interval(mins => $3::int)) RETURNING id::text", [role, status, ageMin]))?.id as string;
            ids.push(made);
            await run("INSERT INTO feedback (interview_id, verdict, scores, accuracy) VALUES ($1::uuid, 'v', $2::jsonb, $3)", [made, scores, acc]);
        }

        const r = await client.get(DASHBOARD);
        expect(r.status).toBe(200);
        const d = await r.json<{ count: number; recent_n: number; averages: Row; recent: Row }>();
        expect(d.count).toBe(6);
        expect(d.averages).toEqual({ clarity: 3.5, structure: 7 });
        expect(d.recent_n).toBe(5);
        expect(d.recent).toEqual({ clarity: 4, structure: 4 });

        for (const iid of ids) expect((await client.delete(`/api/interviews/${iid}`)).status).toBe(204);

        const empty = await (await client.get(DASHBOARD)).json<Row>();
        expect(pick(empty, { count: 0, recent_n: 0, averages: {}, recent: {} })).toEqual({ count: 0, recent_n: 0, averages: {}, recent: {} });
    });

    it("dimensions_are_owner_scoped", async () => {
        const foreign = (await queryOne<{ id: string }>("INSERT INTO interviews (owner_id, role, status) VALUES ('someone-else', 'Not yours', 'completed') RETURNING id::text"))?.id as string;
        await run("INSERT INTO feedback (interview_id, verdict, scores, accuracy) VALUES ($1::uuid, 'v', '{\"clarity\": 10}'::jsonb, 90)", [foreign]);

        const empty = await (await client.get(DASHBOARD)).json<Row>();
        expect(pick(empty, { count: 0, recent_n: 0, averages: {}, recent: {} })).toEqual({ count: 0, recent_n: 0, averages: {}, recent: {} });

        await run("DELETE FROM interviews WHERE id = $1::uuid", [foreign]);
    });

    it("dashboard_dims_come_from_the_server", async () => {
        type Dims = {
            total: number;
            completed: number;
            rated: number;
            decided: number;
            hiring: number;
            week_runs: number;
            daily_runs: number[];
            daily_finished: number[];
            accuracy_trend: { accuracy: number }[];
            last_run_days: number;
            hire_spark: number[];
        };
        const seeds: [string, string, number | null, string | null, string | null][] = [
            ["Dash hired", "completed", 80, "hire", null],
            ["Dash rejected", "completed", 40, "reject", "2020-01-01"],
            ["Dash unscored", "completed", null, null, null],
            ["Dash running", "in_progress", null, null, null],
        ];

        const before = await (await client.get(DASHBOARD)).json<Dims>();
        const ids: string[] = [];
        try {
            for (const [seq, [role, status, acc, decision, archivedAt]] of seeds.entries()) {
                const made = (await queryOne<{ id: string }>("INSERT INTO interviews (owner_id, role, status, created_at, archived_at) VALUES ('dev-user', $1, $2, now() + make_interval(secs => $3::int), $4::text::timestamptz) RETURNING id::text", [role, status, seq, archivedAt]))?.id as string;
                ids.push(made);
                if (acc !== null) {
                    await run("INSERT INTO feedback (interview_id, verdict, scores, accuracy, decision, certainty) VALUES ($1::uuid, 'v', '{}'::jsonb, $2, $3, 60)", [made, acc, decision]);
                }
            }

            const r = await client.get(DASHBOARD);
            expect(r.status).toBe(200);
            const d = await r.json<Dims>();
            expect([d.total - before.total, d.completed - before.completed, d.rated - before.rated]).toEqual([4, 3, 2]);
            expect([d.decided - before.decided, d.hiring - before.hiring, d.week_runs - before.week_runs]).toEqual([2, 1, 4]);
            expect([d.daily_runs.length, d.daily_finished.length]).toEqual([14, 14]);
            expect((d.daily_runs.at(-1) as number) - (before.daily_runs.at(-1) as number)).toBe(4);
            expect(d.accuracy_trend.slice(-2).map((point) => point.accuracy)).toEqual([80, 40]);
            expect(d.last_run_days).toBe(0);
            expect(d.hire_spark.length).toBe(Math.min(20, d.decided));
        } finally {
            await dbFetch(sql`DELETE FROM interviews WHERE id = ANY(${ids}::uuid[])`);
        }
    });

    it("move_review_annotates_every_candidate_turn", async () => {
        const iid = (await (await client.post("/api/interviews", { json: { role: "Move Review Multi" } })).json<{ id: string }>()).id;
        await client.post(`/api/interviews/${iid}/start`);
        for (const answer of ["I shipped a cache layer in front of the read path.", "It dropped p99 by 40%."]) {
            expect((await client.post(`/api/interviews/${iid}/chat/send`, { json: { interview_id: iid, content: answer } })).status).toBe(200);
        }
        expect((await client.post(`/api/interviews/${iid}/finish`)).status).toBe(200);

        const messages = await (await client.get(`/api/interviews/${iid}/chat`)).json<{ role: string; move_class: string | null; comment: string | null }[]>();
        expect(messages.filter((message) => message.role === "user").map((message) => message.move_class)).toEqual(["good", "inaccuracy"]);
        const notes = messages.filter((message) => message.role === "user").map((message) => message.comment);
        expect(notes.every((note) => note !== null && note !== "")).toBe(true);
        expect(notes[0]).not.toBe(notes[1]);
        const feedback = await (await client.get(`/api/interviews/${iid}/feedback`)).json<{ accuracy: number; grade: string }>();
        expect([feedback.accuracy, feedback.grade]).toEqual([73, "B"]);
        expect((await client.delete(`/api/interviews/${iid}`)).status).toBe(204);
    });

    it("get_interview_missing_returns_404", async () => {
        expect((await client.get(`/api/interviews/${MISSING}`)).status).toBe(404);
    });

    it("interviews_unlimited_at_creation", async () => {
        const first = await client.post("/api/interviews", { json: { role: "Quota Probe" } });
        expect(first.status).toBe(201);
        const iid1 = (await first.json<{ id: string }>()).id;
        const second = await client.post("/api/interviews", { json: { role: "Quota Probe 2" } });
        expect(second.status).toBe(201);
        const iid2 = (await second.json<{ id: string }>()).id;

        const usage = await client.get(USAGE);
        expect(usage.status).toBe(200);
        const body = await usage.json<Row & { tier: string; chat_turns_per_day_dev: number; chat_turns_used_today: number; chat_turns_remaining_today: number }>();
        expect("daily_interviews" in body).toBe(false);
        expect(body.tier).toBe("dev");
        expect(body.chat_turns_per_day_dev).toBe(config.devChatTurns);
        expect(body.chat_turns_used_today).toBeGreaterThanOrEqual(0);
        expect(body.chat_turns_remaining_today).toBeGreaterThanOrEqual(0);

        expect((await client.delete(`/api/interviews/${iid1}`)).status).toBe(204);
        expect((await client.delete(`/api/interviews/${iid2}`)).status).toBe(204);
    });

    it("resume_review_retry_rewrites_one_line_and_stores_it", async () => {
        await wipeResumes();
        const line = "Ran the payroll export pipeline nightly.";
        const rid = (await (await client.post("/api/resumes", { json: resumePayload("Retry", `Alex cut p99 from 40s to 900ms.\n${line}`) })).json<{ id: string }>()).id;
        expect((await client.post(`/api/resumes/${rid}/review/rewrite`, { json: { source: line } })).status).toBe(409);

        const stub = stubHttp();
        stub.post(LLM_URL, (call) => (systemOf(call) === REWRITE_LINE_PROMPT ? llmReply({ rewrite: "Owned the payroll export pipeline, 1.2M records nightly." }) : llmReply(REVIEW_EXAMPLE)));

        await withLiveConfig(async () => {
            expect((await client.post(`/api/resumes/${rid}/review`)).status).toBe(201);
            expect((await client.post(`/api/resumes/${rid}/review/rewrite`, { json: { source: "Invented a line." } })).status).toBe(422);
            const turns = await turnsUsed();
            const got = await client.post(`/api/resumes/${rid}/review/rewrite`, { json: { source: line } });
            expect(got.status).toBe(200);
            expect(userOf(stub.calls[stub.calls.length - 1])).toContain(`<line>\n${line}\n</line>`);
            expect((await got.json<{ rewrites: { rewrite: string }[] }>()).rewrites[0].rewrite.startsWith("Owned the payroll export")).toBe(true);
            expect(await turnsUsed()).toBe(turns + 1);
        });
        expect((await (await client.get(`/api/resumes/${rid}/review`)).json<{ rewrites: { rewrite: string }[] }>()).rewrites[0].rewrite.startsWith("Owned the payroll export")).toBe(true);
        expect((await client.delete(`/api/resumes/${rid}`)).status).toBe(204);
    });

    it("resume_preview_compiles_latex_and_rejects_plain_text", async () => {
        const source = "\\documentclass{article}\\begin{document}Alex Mender\\end{document}";
        expect((await client.post("/api/resumes/preview", { json: { text: "plain text, no documentclass" } })).status).toBe(422);
        if (!latex.available()) {
            expect((await client.post("/api/resumes/preview", { json: { text: source } })).status).toBe(503);
            return;
        }
        const got = await client.post("/api/resumes/preview", { json: { text: source } });
        expect(got.status).toBe(200);
        expect((await got.text()).slice(0, 4)).toBe("%PDF");
        expect(got.headers.get("content-type")).toBe("application/pdf");
        const broken = await client.post("/api/resumes/preview", { json: { text: "\\documentclass{article}\\begin{document}\\nosuchcommand\\end{document}" } });
        expect(broken.status).toBe(422);
        expect((await broken.json<{ detail: string }>()).detail).toContain("Undefined control sequence");
    });

    // These two need a real pdflatex, which this host does not have: they skip out loud rather than pass
    // having asserted nothing. tests/test_latex.test.ts covers the module itself through a fake engine.
    it.skipIf(!latex.available())("resume_preview_refuses_to_read_outside_its_own_directory", async () => {
        const directory = await mkdtemp(join(tmpdir(), "mxt-preview-"));
        try {
            const secret = join(directory, "secret.tex");
            await writeFile(secret, "TOPSECRET", "utf-8");
            const got = await client.post("/api/resumes/preview", { json: { text: `\\documentclass{article}\\begin{document}\\input{${join(directory, "secret")}}\\end{document}` } });
            expect(got.status).toBe(422);
            const detail = (await got.json<{ detail: string }>()).detail;
            expect(detail.includes("secret") || detail.includes("LaTeX Error")).toBe(true);
            expect(detail).not.toContain("TOPSECRET");
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it.skipIf(!latex.available())("resume_preview_says_so_when_a_document_has_no_pages", async () => {
        const got = await client.post("/api/resumes/preview", { json: { text: "\\documentclass{article}\n\\begin{document}\n\\end{document}" } });
        expect(got.status).toBe(422);
        expect((await got.json<{ detail: string }>()).detail.toLowerCase()).toContain("no pages");
    });

    it("round_trip_budget", async () => {
        await clerkStub();
        const as = bearer(await clerkToken("dev-user"));
        const starts = dc.channel("tracing:postgres:query:start");
        let counted = 0;
        const onStart = (): void => {
            counted += 1;
        };
        starts.subscribe(onStart);

        const statements = async <T>(call: () => Promise<T>): Promise<[T, number]> => {
            counted = 0;
            const got = await call();
            return [got, counted];
        };

        try {
            await withConfig({ clerkEnabled: true, clerkJwksUrl: JWKS_URL, byokEncryptionKey: "" }, async () => {
                const iid = (await (await as.post("/api/interviews", { json: { role: "Round trips" } })).json<{ id: string }>()).id;
                try {
                    const [, emptyCount] = await statements(() => as.get(`/api/interviews/${iid}/chat`));
                    expect(emptyCount).toBe(1);
                    const [empty, secondCount] = await statements(() => as.get(`/api/interviews/${iid}/chat`));
                    expect([empty.status, await empty.json(), secondCount]).toEqual([200, [], 1]);
                    expect((await as.get(`/api/interviews/${iid}`)).status).toBe(200);
                    const foreignChat = await as.get(`/api/interviews/${MISSING}/chat`);
                    expect([foreignChat.status, (await foreignChat.json<{ detail: string }>()).detail]).toEqual([404, "Interview not found"]);

                    const [absent, absentCount] = await statements(() => as.get(`/api/interviews/${iid}/feedback`));
                    expect([absent.status, (await absent.json<{ detail: string }>()).detail, absentCount]).toEqual([404, "Feedback not found", 1]);
                    const foreignFeedback = await as.get(`/api/interviews/${MISSING}/feedback`);
                    expect([foreignFeedback.status, (await foreignFeedback.json<{ detail: string }>()).detail]).toEqual([404, "Interview not found"]);

                    await as.post(`/api/interviews/${iid}/start`);
                    const [turn, turnCount] = await statements(() => as.post(`/api/interviews/${iid}/chat/send`, { json: { interview_id: iid, content: "hi" } }));
                    expect([turn.status, turnCount]).toEqual([200, 4]);

                    await as.post(`/api/interviews/${iid}/finish`);
                    const [, generateCount] = await statements(() => as.post(`/api/interviews/${iid}/feedback/generate`));
                    expect(generateCount).toBe(11);

                    const stub = stubHttp();
                    stub.post(LLM_URL, (call) => (systemOf(call) === REWRITE_LINE_PROMPT ? llmReply({ rewrite: "a different line" }) : llmReply(REVIEW_EXAMPLE)));
                    const rid = (await (await as.post("/api/resumes", { json: { name: "r.txt", text: "line one\nline two" } })).json<{ id: string }>()).id;
                    await withLiveConfig(async () => {
                        expect((await as.post(`/api/resumes/${rid}/review`)).status).toBe(201);
                        const [, rewriteCount] = await statements(() => as.post(`/api/resumes/${rid}/review/rewrite`, { json: { source: "line one" } }));
                        expect(rewriteCount).toBe(4);
                    });
                    await as.delete(`/api/resumes/${rid}`);

                    await run("DELETE FROM interview_templates WHERE owner_id = 'dev-user'");
                    await run("DELETE FROM template_seeds WHERE owner_id = 'dev-user'");
                    const [seeded, seedCount] = await statements(() => as.get("/api/templates"));
                    expect([seedCount, (await seeded.json<{ name: string }[]>()).map((template) => template.name)]).toEqual([2, ["Killer", "Griller", "Chiller"]]);
                } finally {
                    await as.delete(`/api/interviews/${iid}`);
                }
            });
        } finally {
            starts.unsubscribe(onStart);
        }
    });
});
