import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import dc from "node:diagnostics_channel";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { type ServerType, serve } from "@hono/node-server";
import postgres from "postgres";
import { miniPdf } from "../tests/helpers/pdf.ts";

const ROOT = join(import.meta.dirname, "..");
const BASE_DSN = process.env.MXT_BASE_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://x:x@localhost:5432/x";
const DB_NAME = `maxterview_smoke_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
const DSN = `${BASE_DSN.slice(0, BASE_DSN.lastIndexOf("/") + 1)}${DB_NAME}`;

const ALICE = "smoke-alice";
const BOB = "smoke-bob";
const BYOK_KEY = "sk-smoke-byok-key-0001";
const BYOK_MODEL = "byok-smoke-model";
const LATEX = "\\documentclass{article}\\begin{document}Smoke test.\\end{document}";

const STREAM_DELTAS = ["Tell me about the last system you owned end to end. ", "What broke, and what did you change after it?"];

const STUB_FEEDBACK = {
    scores: { clarity: 8, relevance: 7, structure: 8, confidence: 7, technical_depth: 7, problem_solving: 8, production: 7, ownership: 8, collaboration: 7, growth_potential: 8 },
    verdict: "Owned the debugging story end to end and named what changed afterwards.",
    tips: ["Quantify the impact of that migration.", "Say what you would monitor after the change."],
    decision: "hire",
    certainty: 74,
    moves: [1, 2, 3, 4, 5, 6].map((turn) => ({ turn, class: "good", comment: "Concrete detail and a named tradeoff." })),
};

type StubCall = { stream: boolean; model: string; authorization: string; responseFormat: string };
type Stub = { url: string; calls: StubCall[]; close: () => Promise<void> };
type Outcome = { status: "PASS" | "FAIL" | "SKIP"; detail: string };
type Leg = Outcome & { name: string };
type Reply = { status: number; text: string };
type Frame = { event: string; data: string };

const legs: Leg[] = [];
let origin = "";
let queries = 0;
let stubUrl = "";
let stubCalls: StubCall[] = [];

function json(reply: Reply): Record<string, unknown> {
    const parsed: unknown = JSON.parse(reply.text);
    assert.equal(typeof parsed, "object", `expected a JSON body, got ${reply.text.slice(0, 120)}`);
    return parsed as Record<string, unknown>;
}

function sendJson(response: ServerResponse, payload: unknown): void {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
}

async function startStub(): Promise<Stub> {
    const calls: StubCall[] = [];
    const server: Server = createServer((incoming, response) => {
        if (incoming.method !== "POST" || !(incoming.url ?? "").endsWith("/chat/completions")) {
            response.writeHead(404).end();
            return;
        }
        let raw = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk: string) => {
            raw += chunk;
        });
        incoming.on("end", () => {
            const body = JSON.parse(raw === "" ? "{}" : raw) as { model?: unknown; stream?: unknown; response_format?: { type?: unknown } };
            calls.push({
                stream: body.stream === true,
                model: String(body.model ?? ""),
                authorization: incoming.headers.authorization ?? "",
                responseFormat: typeof body.response_format?.type === "string" ? body.response_format.type : "",
            });
            if (body.stream === true) {
                response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
                for (const piece of STREAM_DELTAS) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
                response.write("data: [DONE]\n\n");
                response.end();
                return;
            }
            sendJson(response, { choices: [{ message: { content: JSON.stringify(STUB_FEEDBACK) } }] });
        });
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", () => listening()));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("the stub server did not bind a TCP port");
    return {
        url: `http://127.0.0.1:${address.port}`,
        calls,
        close: async () => await new Promise<void>((done) => server.close(() => done())),
    };
}

// PayMongo reads PAYMONGO_SECRET_KEY and PAYMONGO_WEBHOOK_SECRET from the environment only: never a .env file,
// never a report, never an error message.
function applyEnv(stubUrl: string): void {
    const values: Record<string, string> = {
        APP_ENV: "test",
        CLERK_ENABLED: "false",
        RATE_LIMIT: "off",
        LOG_LEVEL: process.env.LOG_LEVEL ?? "silent",
        DATABASE_URL: DSN,
        LLM_BASE_URL: `${stubUrl}/v1`,
        LLM_MODEL: "smoke-model",
        LLM_API_KEY: "smoke-system-key",
        LLM_PRO_BASE_URL: `${stubUrl}/v1`,
        LLM_PRO_MODEL: "smoke-pro-model",
        LLM_PRO_API_KEY: "smoke-system-key",
        LLM_GRADER_BASE_URL: `${stubUrl}/v1`,
        LLM_GRADER_MODEL: "smoke-grader-model",
        BYOK_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
        BYOK_ALLOW_PRIVATE_HOSTS: "true",
    };
    for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

async function createDatabase(): Promise<void> {
    const admin = postgres(BASE_DSN, { max: 1, onnotice: () => {} });
    try {
        await admin.unsafe(`CREATE DATABASE "${DB_NAME}"`);
    } catch (error) {
        throw new Error(`the smoke needs a reachable Postgres in DATABASE_URL: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        await admin.end({ timeout: 1 });
    }
}

function migrate(): void {
    execFileSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "scripts", "migrate.ts"), "apply"], {
        env: { ...process.env, DATABASE_URL: DSN, APP_ENV: "test" },
        stdio: ["ignore", "pipe", "pipe"],
    });
}

async function dropDatabase(): Promise<void> {
    const admin = postgres(BASE_DSN, { max: 1, onnotice: () => {} });
    try {
        await admin`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${DB_NAME} AND pid <> pg_backend_pid()`;
        await admin.unsafe(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
    } finally {
        await admin.end({ timeout: 1 });
    }
}

async function request(method: string, path: string, options: { sub?: string; json?: unknown; body?: string | FormData; headers?: Record<string, string> } = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.sub !== undefined) headers["x-dev-sub"] = options.sub;
    let body = options.body;
    if (options.json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(options.json);
    }
    const response = await fetch(`${origin}/api${path}`, { method, headers, body });
    return { status: response.status, text: await response.text() };
}

function parseFrames(text: string): Frame[] {
    const frames: Frame[] = [];
    for (const block of text.split("\n\n")) {
        let event = "";
        const data: string[] = [];
        for (const line of block.split("\n")) {
            if (line.startsWith("event:")) event = line.slice("event:".length).trim();
            else if (line.startsWith("data:")) data.push(line.slice("data:".length).replace(/^ /, ""));
        }
        if (event !== "" || data.length > 0) frames.push({ event, data: data.join("\n") });
    }
    return frames;
}

async function sse(path: string, sub: string, body?: unknown): Promise<Frame[]> {
    const reply = await request("POST", path, { sub, json: body });
    assert.equal(reply.status, 200, `${path} answered ${reply.status}: ${reply.text.slice(0, 200)}`);
    return parseFrames(reply.text);
}

function delivered(frames: Frame[], path: string): string {
    const spoken = frames
        .filter((frame) => frame.event === "message")
        .map((frame) => frame.data)
        .join("");
    const failed = frames.filter((frame) => frame.event === "error").map((frame) => frame.data);
    assert.ok(failed.length === 0, `${path} sent an error frame: ${failed.join(" | ")}`);
    assert.ok(spoken.trim() !== "", `${path} sent no message frame`);
    assert.ok(
        frames.some((frame) => frame.event === "done"),
        `${path} sent no done frame`,
    );
    return spoken;
}

async function runLeg(name: string, body: () => Promise<Outcome>): Promise<void> {
    try {
        legs.push({ name, ...(await body()) });
    } catch (error) {
        legs.push({ name, status: "FAIL", detail: error instanceof Error ? error.message : String(error) });
    }
}

function printTable(): void {
    const width = legs.reduce((widest, leg) => Math.max(widest, leg.name.length), 0);
    for (const leg of legs) console.log(`${leg.status.padEnd(4)}  ${leg.name.padEnd(width)}  ${leg.detail}`);
    const count = (status: Outcome["status"]) => legs.filter((leg) => leg.status === status).length;
    console.log(`${count("PASS")} passed, ${count("FAIL")} failed, ${count("SKIP")} skipped`);
}

async function runLegs(): Promise<void> {
    let interviewId = "";
    const sql = (await import("../src/db.ts")).sql;

    await runLeg("a health", async () => {
        const before = queries;
        const reply = await request("GET", "/health");
        assert.equal(reply.status, 200, `/api/health answered ${reply.status}`);
        assert.deepEqual(json(reply), { status: "ok", up: 1 });
        const during = queries - before;
        assert.equal(during, 0, `/api/health ran ${during} database queries`);
        return { status: "PASS", detail: "200, 0 database queries" };
    });

    await runLeg("b interviews + identity", async () => {
        const created = await request("POST", "/interviews", { sub: ALICE, json: { role: "Backend Engineer", level: "senior", topic: "payments", depth: "standard" } });
        assert.equal(created.status, 201, `POST /interviews answered ${created.status}: ${created.text.slice(0, 200)}`);
        interviewId = String(json(created).id ?? "");
        assert.ok(interviewId !== "", "the created interview has no id");
        const own = await request("GET", `/interviews/${interviewId}`, { sub: ALICE });
        assert.equal(own.status, 200, `the owner read answered ${own.status}`);
        const foreign = await request("GET", `/interviews/${interviewId}`, { sub: BOB });
        assert.equal(foreign.status, 404, `${BOB} read ${ALICE}'s interview: ${foreign.status} ${foreign.text.slice(0, 120)}`);
        return { status: "PASS", detail: `owner 200, ${BOB} 404` };
    });

    await runLeg("c chat opening + send", async () => {
        const started = await request("POST", `/interviews/${interviewId}/start`, { sub: ALICE });
        assert.equal(started.status, 200, `POST /interviews/:id/start answered ${started.status}: ${started.text.slice(0, 200)}`);
        delivered(await sse(`/interviews/${interviewId}/chat/opening`, ALICE), "chat/opening");
        delivered(await sse(`/interviews/${interviewId}/chat/send`, ALICE, { interview_id: interviewId, content: "I owned the ledger migration for eleven months." }), "chat/send 1");
        delivered(await sse(`/interviews/${interviewId}/chat/send`, ALICE, { interview_id: interviewId, content: "A double-write made the reconciliation drift; I added a checksum and an alert." }), "chat/send 2");
        const transcript = await request("GET", `/interviews/${interviewId}/chat`, { sub: ALICE });
        assert.equal(transcript.status, 200, `GET chat answered ${transcript.status}`);
        const rows = JSON.parse(transcript.text) as { role: string; content: string }[];
        assert.deepEqual(
            rows.map((row) => row.role),
            ["assistant", "user", "assistant", "user", "assistant"],
            `stored transcript is ${rows.length} rows: ${rows.map((row) => row.role).join(",")}`,
        );
        assert.ok(rows[4].content.trim() !== "", "the stored assistant reply is empty");
        const usage = await request("GET", "/billing/usage", { sub: ALICE });
        assert.equal(usage.status, 200, `GET billing/usage answered ${usage.status}`);
        const used = json(usage).chat_turns_used_today;
        assert.equal(used, 3, `the turn counter reads ${String(used)} after opening plus two sends`);
        return { status: "PASS", detail: "3 SSE turns, 5 rows stored, turn counter 3" };
    });

    await runLeg("d finish + feedback + offer", async () => {
        const before = stubCalls.length;
        const finish = await request("POST", `/interviews/${interviewId}/finish`, { sub: ALICE });
        assert.equal(finish.status, 200, `finish answered ${finish.status}: ${finish.text.slice(0, 200)}`);
        assert.equal(json(finish).status, "completed");
        const feedback = await request("GET", `/interviews/${interviewId}/feedback`, { sub: ALICE });
        assert.equal(feedback.status, 200, `GET feedback answered ${feedback.status}`);
        const scored = json(feedback);
        assert.ok(typeof scored.verdict === "string" && scored.verdict !== "", "the feedback row has no verdict");
        assert.ok(Object.keys((scored.scores as Record<string, unknown>) ?? {}).length > 0, "the feedback row has no scores");
        const offer = await request("GET", `/interviews/${interviewId}/offer`, { sub: ALICE });
        assert.equal(offer.status, 200, `GET offer answered ${offer.status}`);
        assert.ok(Number(json(offer).base_salary ?? 0) > 0, "the offer has no base salary");
        const calls = stubCalls.slice(before);
        assert.ok(
            calls.some((call) => !call.stream),
            "the feedback pipeline made no non-streaming model call",
        );
        assert.ok(
            calls.some((call) => call.responseFormat !== ""),
            "no scoring call asked for a JSON response format",
        );
        return { status: "PASS", detail: `feedback + offer, ${calls.length} stub calls` };
    });

    await runLeg("e resume extract + preview", async () => {
        const form = new FormData();
        form.append("file", new Blob([new Uint8Array(miniPdf("Hello Resume"))], { type: "application/pdf" }), "resume.pdf");
        const extract = await request("POST", "/resumes/extract", { sub: ALICE, body: form });
        assert.equal(extract.status, 200, `POST /resumes/extract answered ${extract.status}: ${extract.text.slice(0, 200)}`);
        const text = String(json(extract).text ?? "");
        assert.ok(text.includes("Hello Resume"), `the extracted text is ${JSON.stringify(text.slice(0, 80))}`);
        const preview = await request("POST", "/resumes/preview", { sub: ALICE, json: { text: LATEX } });
        if (preview.status === 503 && preview.text.includes("No LaTeX engine")) return { status: "SKIP", detail: "pdflatex not installed: extraction passed, preview not exercised" };
        assert.equal(preview.status, 200, `POST /resumes/preview answered ${preview.status}: ${preview.text.slice(0, 200)}`);
        assert.ok(preview.text.startsWith("%PDF"), "the preview is not a PDF");
        return { status: "PASS", detail: "text extracted, preview compiled" };
    });

    await runLeg("f BYOK", async () => {
        const saved = await request("PUT", "/settings/llm", { sub: ALICE, json: { base_url: `${stubUrl}/v1`, model: BYOK_MODEL, api_key: BYOK_KEY } });
        assert.equal(saved.status, 200, `PUT /settings/llm answered ${saved.status}: ${saved.text.slice(0, 200)}`);
        assert.equal(json(saved).enabled, true, "BYOK reports disabled after a save");
        const before = stubCalls.length;
        const created = await request("POST", "/interviews", { sub: ALICE, json: { role: "Platform Engineer", level: "staff", depth: "standard" } });
        assert.equal(created.status, 201, `POST /interviews answered ${created.status}`);
        const byokInterview = String(json(created).id);
        const started = await request("POST", `/interviews/${byokInterview}/start`, { sub: ALICE });
        assert.equal(started.status, 200, `POST /interviews/:id/start answered ${started.status}`);
        delivered(await sse(`/interviews/${byokInterview}/chat/opening`, ALICE), "BYOK chat/opening");
        const byokCalls = stubCalls.slice(before).filter((call) => call.authorization === `Bearer ${BYOK_KEY}`);
        assert.ok(
            byokCalls.length > 0,
            `the stub saw no request carrying the saved BYOK key (${stubCalls
                .slice(before)
                .map((call) => call.authorization)
                .join(", ")})`,
        );
        assert.ok(
            byokCalls.some((call) => call.model === BYOK_MODEL),
            `the stub was called with ${byokCalls.map((call) => call.model).join(", ")} instead of ${BYOK_MODEL}`,
        );
        return { status: "PASS", detail: `chat went out on ${BYOK_MODEL} with the saved key` };
    });

    await runLeg("g paymongo checkout + webhook", async () => {
        const webhookSecret = process.env.PAYMONGO_WEBHOOK_SECRET ?? "";
        if ((process.env.PAYMONGO_SECRET_KEY ?? "") === "" || webhookSecret === "") return { status: "SKIP", detail: "SKIPPED, no PayMongo keys" };
        const payer = "smoke-paymongo";
        const checkout = await request("POST", "/billing/checkout", { sub: payer });
        assert.equal(checkout.status, 200, `POST /billing/checkout answered ${checkout.status}: ${checkout.text.slice(0, 200)}`);
        const intent = await sql`SELECT provider_subscription_id FROM subscriptions WHERE owner_id = ${payer}`;
        const intentId = String(intent[0]?.provider_subscription_id ?? "");
        assert.ok(intentId !== "", "the checkout stored no payment intent id");
        const [before] = await sql`SELECT plan, status, current_period_end FROM subscriptions WHERE owner_id = ${payer}`;
        assert.equal(before?.status, "incomplete", `the checkout left status ${String(before?.status)}`);
        assert.equal(before?.plan, "premium", `the checkout left plan ${String(before?.plan)}`);
        assert.equal(before?.current_period_end, null, `the checkout already wrote a period end ${String(before?.current_period_end)}`);
        const payment = { id: `pay_smoke_${randomUUID()}`, type: "payment", attributes: { payment_intent_id: intentId, status: "paid" } };
        const event = { data: { id: `evt_smoke_${randomUUID()}`, type: "event", attributes: { type: "payment.paid", livemode: false, created_at: Math.floor(Date.now() / 1000), data: payment } } };
        const raw = JSON.stringify(event);
        const stamp = String(Math.floor(Date.now() / 1000));
        const signature = createHmac("sha256", webhookSecret).update(`${stamp}.`).update(raw).digest("hex");
        const deliveredReply = await request("POST", "/billing/webhook", { body: raw, headers: { "content-type": "application/json", "paymongo-signature": `t=${stamp},te=${signature}` } });
        assert.equal(deliveredReply.status, 200, `POST /billing/webhook answered ${deliveredReply.status}: ${deliveredReply.text.slice(0, 200)}`);
        const entitled = await sql`SELECT current_period_end FROM subscriptions WHERE owner_id = ${payer} AND plan = 'premium' AND status = ANY(ARRAY['active', 'cancelled']) AND current_period_end > now()`;
        assert.equal(entitled.length, 1, "the signed webhook did not flip the entitlement");
        const [after] = await sql`SELECT plan, status, current_period_end, provider_subscription_id FROM subscriptions WHERE owner_id = ${payer}`;
        assert.equal(after?.status, "active", `status after the webhook is ${String(after?.status)}`);
        assert.equal(after?.plan, "premium", `plan after the webhook is ${String(after?.plan)}`);
        assert.equal(String(after?.provider_subscription_id), intentId, "the credited row is not the intent the checkout stored");
        return { status: "PASS", detail: `${String(before?.plan)}/${String(before?.status)}/no period -> ${String(after?.plan)}/${String(after?.status)}, until ${new Date(after?.current_period_end as Date).toISOString().slice(0, 10)}` };
    });
}

async function main(): Promise<void> {
    const stub = await startStub();
    stubUrl = stub.url;
    stubCalls = stub.calls;
    applyEnv(stub.url);
    await createDatabase();
    let closePool: (() => Promise<void>) | null = null;
    let httpServer: ServerType | null = null;
    try {
        migrate();
        const { app } = await import("../src/app.ts");
        const db = await import("../src/db.ts");
        closePool = db.closePool;
        dc.tracingChannel("postgres:query").start.subscribe(() => {
            queries += 1;
        });
        db.initPool();
        httpServer = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
        await new Promise<void>((listening) => httpServer?.once("listening", () => listening()));
        const address = httpServer.address();
        if (address === null || typeof address === "string") throw new Error("the app did not bind a TCP port");
        origin = `http://127.0.0.1:${address.port}`;
        await runLegs();
    } finally {
        const bound = httpServer;
        if (bound !== null) {
            await new Promise<void>((done) => {
                bound.close(() => done());
                if ("closeAllConnections" in bound) bound.closeAllConnections();
            });
        }
        if (closePool !== null) await closePool();
        await dropDatabase();
        await stub.close();
        printTable();
    }
}

try {
    await main();
} catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
}

if (legs.some((leg) => leg.status === "FAIL")) process.exitCode = 1;
