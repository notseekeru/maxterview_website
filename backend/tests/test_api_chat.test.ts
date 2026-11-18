import { generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import { utcDay } from "../src/billing.ts";
import { fetchrow, getPool, sql } from "../src/db.ts";
import { config } from "../src/env.ts";
import * as llm from "../src/llm.ts";
import { Dials } from "../src/models.ts";
import { FAIL_CLASSES } from "../src/rating.ts";
import * as telemetry from "../src/observability.ts";
import { client } from "./helpers/client.ts";
import { withConfig } from "./helpers/config.ts";
import { type HttpStub, json, sse, stubHttp } from "./helpers/http.ts";

// llm.ts builds PRO_CONFIG once, at import, from the env the setup file wrote - which leaves
// LLM_PRO_MODEL empty. Configuring one is the deployment the up-tier exists for, and the only seam:
// chatconfig reads the constant, never the mutable config.
const PRO = await vi.hoisted(async () => {
    const { config: env } = await import("../src/env.ts");
    env.llmProModel = "pro-unit-test";
    env.llmProBaseUrl = "https://pro.test/v1";
    return { baseUrl: "https://pro.test/v1", model: "pro-unit-test" };
});

const SYSTEM_URL = "https://llm.test/v1";
const BYOK_URL = "https://api.example.com/v1";
const BYOK_KEY = "sk-unit-test-key-abcd";
const completions = (baseUrl: string) => `${baseUrl}/chat/completions`;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS = { keys: [{ ...publicKey.export({ format: "jwk" }), alg: "RS256", kid: "chat-kid" }] };
const JWKS_URL = "https://clerk.test/jwks";

type Message = { role: string; content: string; move_class: string | null; comment: string | null };
type Usage = { byok: boolean; chat_turns_used_today: number; chat_turns_per_day_dev: number; chat_turns_remaining_today: number };
type DialGroup = { key: string; runs: number; rated: number; avg_accuracy: number | null; hire_rate: number | null };
type Run = {
    id: string;
    level: string;
    status: string;
    accuracy: number | null;
    grade: string | null;
    decision: string | null;
    turns: number;
    moves: Record<string, number>;
    scores: Record<string, number>;
};
type AnalyticsPayload = {
    runs: Run[];
    move_classes: Record<string, number>;
    dials: Record<string, DialGroup[]>;
    offers: { summary: { count: number; best_id: string | null } };
    activity: { week: string; started: number; completed: number }[];
    total_turns: number;
    streak_days: number;
    hardcore_failures: number;
};

async function withLlm<T>(patch: Partial<llm.LLMConfig>, body: () => Promise<T>): Promise<T> {
    const saved = { ...llm.SYSTEM_CONFIG };
    Object.assign(llm.SYSTEM_CONFIG, patch);
    try {
        return await body();
    } finally {
        Object.assign(llm.SYSTEM_CONFIG, saved);
    }
}

async function create(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const created = await client.post("/api/interviews", { json: body });
    expect(created.status).toBe(201);
    return await created.json<Record<string, unknown>>();
}

async function started(body: Record<string, unknown>): Promise<string> {
    const id = (await create(body)).id as string;
    expect((await client.post(`/api/interviews/${id}/start`)).status).toBe(200);
    return id;
}

/** The grader only runs when a candidate answered a graded phase: the first answer replies to the rapport opener. */
async function answered(id: string): Promise<void> {
    expect((await client.post(`/api/interviews/${id}/chat/opening`)).status).toBe(200);
    for (const content of ["answer 1", "answer 2"]) {
        expect((await send(id, content)).status).toBe(200);
    }
}

const remove = (id: string) => client.delete(`/api/interviews/${id}`);
const send = (id: string, content: string) => client.post(`/api/interviews/${id}/chat/send`, { json: { interview_id: id, content } });

async function transcript(id: string): Promise<Message[]> {
    return await (await client.get(`/api/interviews/${id}/chat`)).json<Message[]>();
}

async function usage(): Promise<Usage> {
    return await (await client.get("/api/billing/usage")).json<Usage>();
}

function reply(text: string): Response {
    return json({ choices: [{ message: { content: text } }] });
}

const allDimensions = (value: number) => Object.fromEntries(llm.FEEDBACK_DIMS.map((dim) => [dim, value]));
const feedbackContent = (verdict: string) => JSON.stringify({ scores: allDimensions(7), verdict, tips: ["Keep going."], decision: "lean_hire", certainty: 60 });
const movesContent = JSON.stringify({ moves: [{ turn: 1, class: "good", comment: "A concrete example." }] });

/** A completions route whose replies the test queues: an empty queue is the model coming back with nothing. */
function modelQueue(stub: HttpStub, baseUrl = SYSTEM_URL): (...replies: string[]) => void {
    const pending: string[] = [];
    stub.post(completions(baseUrl), () => reply(pending.shift() ?? ""));
    return (...replies: string[]) => {
        pending.push(...replies);
    };
}

/** COMPLETE_MAX_FEEDBACK_ATTEMPTS is private to feedback.ts, so the loop is counted through the span it opens per attempt. */
function countAttempts(): { spans: () => number; stop: () => void } {
    const spy = vi.spyOn(telemetry, "withSpan");
    return {
        spans: () => spy.mock.calls.filter(([name]) => name === "feedback.generate").length,
        stop: () => spy.mockRestore(),
    };
}

const encryptionKey = () => Buffer.alloc(32, 7).toString("base64url");

async function signIn(sub: string): Promise<Record<string, string>> {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sub, iss: config.clerkDomain, iat: now, exp: now + 3600 }).setProtectedHeader({ alg: "RS256", kid: "chat-kid" }).sign(privateKey);
    return { authorization: `Bearer ${token}` };
}

async function subscribe(ownerId: string): Promise<void> {
    await fetchrow(sql`INSERT INTO subscriptions (owner_id, plan, status) VALUES (${ownerId}, 'premium', 'active') ON CONFLICT (owner_id) DO UPDATE SET plan = 'premium', status = 'active'`);
}

async function unsubscribe(ownerId: string): Promise<void> {
    await fetchrow(sql`DELETE FROM subscriptions WHERE owner_id = ${ownerId}`);
}

async function resetUsage(ownerId: string): Promise<void> {
    await fetchrow(sql`DELETE FROM turn_usage WHERE owner_id = ${ownerId} AND day = ${utcDay()}`);
}

async function insertTurn(interviewId: string, role: string, text: string, moveClass: string | null = null, comment: string | null = null): Promise<void> {
    await fetchrow(sql`INSERT INTO chat_turns (interview_id, role, content, move_class, comment) VALUES (${interviewId}, ${role}, ${text}, ${moveClass}, ${comment})`);
}

/**
 * main.py monkeypatched fetchrow to fail on the shout INSERT. The failure belongs to the store, so the
 * injector is a BEFORE INSERT trigger narrowed to the one interview: a DB hiccup at that instant, not a
 * block on every assistant write in the suite. Postgres cannot infer a bind parameter inside a utility
 * statement, so the id goes in as a checked literal.
 */
async function withFailingAssistantWrites<T>(interviewId: string, body: () => Promise<T>): Promise<T> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(interviewId)) throw new Error(`not an interview id: ${interviewId}`);
    await getPool().unsafe("CREATE FUNCTION chat_turns_fail_assistant() RETURNS trigger LANGUAGE plpgsql AS $fn$ BEGIN RAISE EXCEPTION 'db down'; END $fn$");
    await getPool().unsafe(`CREATE TRIGGER chat_turns_fail_assistant BEFORE INSERT ON chat_turns FOR EACH ROW WHEN (NEW.role = 'assistant' AND NEW.interview_id = '${interviewId}'::uuid) EXECUTE FUNCTION chat_turns_fail_assistant()`);
    try {
        return await body();
    } finally {
        await getPool().unsafe("DROP TRIGGER IF EXISTS chat_turns_fail_assistant ON chat_turns");
        await getPool().unsafe("DROP FUNCTION IF EXISTS chat_turns_fail_assistant()");
    }
}

describe("chat", () => {
    it("refuses turns after the plan is spent", async () => {
        const turns = llm.interviewPlan(Dials.parse({ depth: "screen" })).length;
        const id = await started({ role: "Plan Exhausted", depth: "screen" });
        const before = (await usage()).chat_turns_used_today;
        expect((await client.post(`/api/interviews/${id}/chat/opening`)).status).toBe(200);
        for (let i = 0; i < turns - 1; i += 1) {
            expect((await send(id, `answer ${i}`)).status).toBe(200);
        }
        expect((await usage()).chat_turns_used_today).toBe(before + turns);

        const transcriptBefore = await transcript(id);
        expect(transcriptBefore[transcriptBefore.length - 1].content).toContain(llm.CLOSING_MESSAGE);
        const refused = await send(id, "one more thing");
        expect(refused.status).toBe(409);
        expect((await refused.json<{ detail: string }>()).detail).toContain("Press Finish");
        // Refused before the model call, the credit and the write: an over-plan turn costs none of them.
        expect((await usage()).chat_turns_used_today).toBe(before + turns);
        expect(await transcript(id)).toEqual(transcriptBefore);
        await remove(id);
    });

    it("kickoff generates the opener once and spends a turn", async () => {
        const id = await started({ role: "Opener" });
        const before = (await usage()).chat_turns_used_today;
        const opener = await client.post(`/api/interviews/${id}/chat/opening`, { json: {} });
        expect(opener.status).toBe(200);
        expect(await opener.text()).toContain("event: done");
        expect((await transcript(id)).map((message) => message.role)).toEqual(["assistant"]);
        expect((await usage()).chat_turns_used_today).toBe(before + 1);

        expect((await client.post(`/api/interviews/${id}/chat/opening`, { json: {} })).status).toBe(409);
        expect((await usage()).chat_turns_used_today).toBe(before + 1);
        await remove(id);
    });

    it("rolls back the turn when the model fails", async () => {
        const id = await started({ role: "Rollback On Model Failure" });
        const body = await withLlm({ base_url: SYSTEM_URL, model: "unit-model" }, async () => {
            const stub = stubHttp();
            stub.post(completions(SYSTEM_URL), () => {
                throw new Error("provider exploded");
            });
            return await (await send(id, "my answer")).text();
        });
        expect(body).toContain("event: error");
        expect(body).not.toContain("event: done");
        expect(await transcript(id)).toEqual([]);

        expect((await send(id, "my answer")).status).toBe(200);
        expect((await transcript(id)).map((message) => message.role)).toEqual(["user", "assistant"]);
        await remove(id);
    });

    it("keeps the turn when finish lands mid-stream", async () => {
        const id = await started({ role: "Rollback After Complete" });
        const body = await withLlm({ base_url: SYSTEM_URL, model: "unit-model" }, async () => {
            const stub = stubHttp();
            stub.post(completions(SYSTEM_URL), async () => {
                await fetchrow(sql`UPDATE interviews SET status = 'completed' WHERE id = ${id}`);
                throw new Error("provider exploded");
            });
            return await (await send(id, "my answer")).text();
        });
        expect(body).toContain("event: error");
        expect((await transcript(id)).map((message) => message.content)).toEqual(["my answer"]);
        // The reason for keeping it: the completed run is still scorable.
        expect((await client.post(`/api/interviews/${id}/feedback/generate`)).status).toBe(200);
        await remove(id);
    });

    it("names the provider it could not reach", async () => {
        const id = await started({ role: "Unreachable Provider" });
        const body = await withLlm({ base_url: SYSTEM_URL, model: "unit-model" }, async () => {
            const stub = stubHttp();
            stub.post(completions(SYSTEM_URL), () => {
                throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 127.0.0.1:443") });
            });
            return await (await send(id, "hi")).text();
        });
        expect(body).toContain("Could not reach the deployment's provider");
        // Node reports a dead host as a TypeError where httpx raised ConnectError; the detail names what
        // this runtime actually raised.
        expect(body).toContain("- TypeError.");
        await remove(id);
    });

    it("repairs a dangling user turn", async () => {
        const id = await started({ role: "Dangling Turn Repair" });
        await insertTurn(id, "user", "abandoned answer");
        expect((await transcript(id)).map((message) => message.content)).toEqual(["abandoned answer"]);

        expect((await send(id, "the retry")).status).toBe(200);
        const answers = (await transcript(id)).filter((message) => message.role === "user").map((message) => message.content);
        expect(answers).toEqual(["the retry"]);
        await remove(id);
    });
});

describe("usage and feedback", () => {
    it("tracks the global daily counter", async () => {
        const id = await started({ role: "Cap Probe" });
        const before = (await usage()).chat_turns_used_today;
        expect((await send(id, "ping")).status).toBe(200);
        expect((await usage()).chat_turns_used_today).toBe(before + 1);
        await remove(id);
    });

    it("regenerate rejects an incomplete and a foreign interview", async () => {
        const pending = (await create({ role: "Regen Guard" })).id as string;
        expect((await client.post(`/api/interviews/${pending}/feedback/generate`)).status).toBe(409);
        expect((await client.post("/api/interviews/00000000-0000-0000-0000-000000000000/feedback/generate")).status).toBe(404);
        await remove(pending);
    });

    it("finish requires at least one message", async () => {
        const id = await started({ role: "Empty Complete" });
        expect((await client.post(`/api/interviews/${id}/finish`)).status).toBe(409);
        expect((await (await client.get(`/api/interviews/${id}`)).json<{ status: string }>()).status).toBe("in_progress");

        // The opener is a stored assistant turn and is not an answer: the guard must not accept it.
        expect((await client.post(`/api/interviews/${id}/chat/opening`)).status).toBe(200);
        expect((await client.post(`/api/interviews/${id}/finish`)).status).toBe(409);

        expect((await send(id, "hi")).status).toBe(200);
        expect((await client.post(`/api/interviews/${id}/finish`)).status).toBe(200);
        await remove(id);
    });

    it("regenerate rejects an empty transcript", async () => {
        const id = (await create({ role: "Empty Regen" })).id as string;
        await fetchrow(sql`UPDATE interviews SET status = 'completed' WHERE id = ${id}`);
        const refused = await client.post(`/api/interviews/${id}/feedback/generate`);
        expect(refused.status).toBe(409);
        expect((await refused.json<{ detail: string }>()).detail).toContain("no answers");
        await remove(id);
    });

    it("regenerate writes when the model recovers", async () => {
        const id = await started({ role: "Regen Recovers" });
        await answered(id);

        await withLlm({ base_url: SYSTEM_URL, model: "unit-model" }, async () => {
            modelQueue(stubHttp())();
            const finished = await client.post(`/api/interviews/${id}/finish`);
            expect(finished.status).toBe(200);
            expect((await finished.json<{ status: string }>()).status).toBe("completed");
            expect((await client.get(`/api/interviews/${id}/feedback`)).status).toBe(404);
        });

        const recovered = await withLlm({ base_url: SYSTEM_URL, model: "unit-model" }, async () => {
            modelQueue(stubHttp())("The candidate was specific and calm.", feedbackContent("Recovered"), movesContent);
            return await client.post(`/api/interviews/${id}/feedback/generate`);
        });
        expect(recovered.status).toBe(200);
        expect((await recovered.json<{ verdict: string }>()).verdict).toBe("Recovered");
        const stored = await client.get(`/api/interviews/${id}/feedback`);
        expect(stored.status).toBe(200);
        expect((await stored.json<{ verdict: string }>()).verdict).toBe("Recovered");
        await remove(id);
    });
});

describe("auto review", () => {
    it("retries then leaves the run unscored when every attempt comes back empty", async () => {
        const id = await started({ role: "AutoRetry Exhaust" });
        await answered(id);

        const attempts = countAttempts();
        try {
            const calls = await withLlm({ base_url: SYSTEM_URL, model: "unit-model" }, async () => {
                const stub = stubHttp();
                modelQueue(stub)();
                const finished = await client.post(`/api/interviews/${id}/finish`);
                expect(finished.status).toBe(200);
                expect((await finished.json<{ status: string }>()).status).toBe("completed");
                return stub.calls.length;
            });
            // COMPLETE_MAX_FEEDBACK_ATTEMPTS is private to feedback.ts: 3 attempts, each spending the grader's
            // single retry, is 6 outbound calls. That is "retried, then stopped", and the row stays unscored.
            expect(calls).toBe(6);
            // One feedback.generate span per attempt: a retry folded into runFeedbackPipeline keeps the call
            // count at 6 but leaves this at 1.
            expect(attempts.spans()).toBe(3);
        } finally {
            attempts.stop();
        }
        expect((await client.get(`/api/interviews/${id}/feedback`)).status).toBe(404);
        await remove(id);
    });

    it("stops the retry on the first success", async () => {
        const id = await started({ role: "AutoRetry Recover" });
        await answered(id);

        const attempts = countAttempts();
        try {
            const calls = await withLlm({ base_url: SYSTEM_URL, model: "unit-model" }, async () => {
                const stub = stubHttp();
                modelQueue(stub)("", "", "The candidate answered with an example.", feedbackContent("Auto recovered"), movesContent);
                const finished = await client.post(`/api/interviews/${id}/finish`);
                expect(finished.status).toBe(200);
                expect((await finished.json<{ status: string }>()).status).toBe("completed");
                return stub.calls.length;
            });
            // Two empty grader calls in the first attempt, then notes + format + moves in the second: the
            // recovery ended the retry, so no third attempt was made.
            expect(calls).toBe(5);
            expect(attempts.spans()).toBe(2);
        } finally {
            attempts.stop();
        }
        const stored = await client.get(`/api/interviews/${id}/feedback`);
        expect(stored.status).toBe(200);
        expect((await stored.json<{ verdict: string }>()).verdict).toBe("Auto recovered");
        await remove(id);
    });
});

describe("review redos", () => {
    it("caps redos per run and charges only on success", async () => {
        const owner = "user_redo";
        const stub = stubHttp();
        stub.on("GET", JWKS_URL, () => json(JWKS));
        const queue = modelQueue(stub);
        await withConfig({ clerkEnabled: true, clerkJwksUrl: JWKS_URL, premiumRedos: 1 }, async () => {
            const headers = await signIn(owner);
            const post = (path: string, json?: unknown) => client.post(path, { json, headers });
            const get = (path: string) => client.get(path, { headers });
            const created = await post("/api/interviews", { role: "Redo Cap" });
            expect(created.status).toBe(201);
            const id = (await created.json<{ id: string }>()).id;
            try {
                expect((await post(`/api/interviews/${id}/start`)).status).toBe(200);
                expect((await post(`/api/interviews/${id}/chat/opening`)).status).toBe(200);
                for (const content of ["answer 1", "answer 2"]) {
                    expect((await post(`/api/interviews/${id}/chat/send`, { interview_id: id, content })).status).toBe(200);
                }
                // The FIRST review is included in the run: /finish auto-generates it and spends no redo,
                // even when the model comes back empty and the row is never written.
                await withLlm({ base_url: SYSTEM_URL, model: "unit-model" }, async () => {
                    queue();
                    expect((await post(`/api/interviews/${id}/finish`)).status).toBe(200);
                    expect((await get(`/api/interviews/${id}/feedback`)).status).toBe(404);
                });

                await withLlm({ base_url: SYSTEM_URL, model: "unit-model" }, async () => {
                    queue("The candidate answered directly.", feedbackContent("Rebuilt"), movesContent);
                    const first = await post(`/api/interviews/${id}/feedback/generate`);
                    expect(first.status).toBe(200);
                    expect((await first.json<{ redos: number }>()).redos).toBe(1);
                });

                // Spent: the cap is the run's, and it is not a reason to drop the review already there.
                // An entitled tier reads 409; a free one gets the upsell (402), as the resume cap does.
                await subscribe(owner);
                const over = await post(`/api/interviews/${id}/feedback/generate`);
                expect(over.status).toBe(409);
                expect((await over.json<{ detail: string }>()).detail).toContain("review redos");
                expect((await (await get(`/api/interviews/${id}/feedback`)).json<{ redos: number }>()).redos).toBe(1);

                await unsubscribe(owner);
                const upsell = await post(`/api/interviews/${id}/feedback/generate`);
                expect(upsell.status).toBe(402);
                expect((await upsell.json<{ detail: string }>()).detail).toContain("Pro raises");
            } finally {
                await remove(id);
                await unsubscribe(owner);
                await resetUsage(owner);
            }
        });
    });
});

describe("byok", () => {
    it("skips the tier quota for a byok turn but still meters it", async () => {
        const tierLimit = 5;
        await withConfig({ byokEncryptionKey: encryptionKey(), devChatTurns: tierLimit }, async () => {
            try {
                await fetchrow(sql`INSERT INTO turn_usage (owner_id, day, turns) VALUES (${config.devUserSub}, ${utcDay()}, ${tierLimit}) ON CONFLICT (owner_id, day) DO UPDATE SET turns = ${tierLimit}`);
                const stored = await client.put("/api/settings/llm", { json: { base_url: BYOK_URL, model: "m", api_key: BYOK_KEY } });
                expect(stored.status).toBe(200);

                const stub = stubHttp();
                stub.post(completions(BYOK_URL), () => sse(["Sure - "]));
                const id = await started({ role: "BYOK quota" });
                const sent = await send(id, "hi");
                expect(sent.status).toBe(200);
                expect(await sent.text()).toContain("Sure - ");
                // The owner's target, not the system one: the turn resolved the saved credential.
                expect(stub.calls[0].headers.get("authorization")).toBe(`Bearer ${BYOK_KEY}`);
                expect(stub.calls[0].url).toBe(completions(BYOK_URL));

                const state = await usage();
                expect([state.byok, state.chat_turns_used_today]).toEqual([true, tierLimit + 1]);
                await remove(id);
            } finally {
                await client.delete("/api/settings/llm");
                await resetUsage(config.devUserSub);
            }
        });
    });

    it("stops turns at the byok ceiling", async () => {
        const ceiling = 3;
        await withConfig({ byokEncryptionKey: encryptionKey(), byokPremiumChatTurns: ceiling }, async () => {
            try {
                expect((await client.put("/api/settings/llm", { json: { base_url: BYOK_URL, model: "m", api_key: BYOK_KEY } })).status).toBe(200);
                const id = await started({ role: "BYOK ceiling" });
                await fetchrow(sql`INSERT INTO turn_usage (owner_id, day, turns) VALUES (${config.devUserSub}, ${utcDay()}, ${ceiling}) ON CONFLICT (owner_id, day) DO UPDATE SET turns = ${ceiling}`);
                await insertTurn(id, "user", "abandoned answer");

                const state = await usage();
                expect([state.byok, state.chat_turns_per_day_dev, state.chat_turns_used_today, state.chat_turns_remaining_today]).toEqual([true, ceiling, ceiling, 0]);
                const refused = await send(id, "hi");
                expect(refused.status).toBe(402);
                expect((await refused.json<{ detail: string }>()).detail).toContain("your own provider");
                expect((await usage()).chat_turns_used_today).toBe(ceiling);
                expect((await transcript(id)).map((message) => message.content)).toEqual(["abandoned answer"]);
                await remove(id);
            } finally {
                await client.delete("/api/settings/llm");
                await resetUsage(config.devUserSub);
            }
        });
    });

    it("refuses this deployment's own provider and its network", async () => {
        await withConfig({ byokEncryptionKey: encryptionKey() }, async () => {
            const saved = { ...llm.SYSTEM_CONFIG };
            const put = (url: string, model: string, apiKey: string) => client.put("/api/settings/llm", { json: { base_url: url, model, api_key: apiKey } });
            try {
                Object.assign(llm.SYSTEM_CONFIG, { base_url: "http://100.64.2.2:8080/v1", model: "qwen", api_key: "" });
                const refused = [
                    "http://100.64.2.2:8080/v1", // the system provider, as written
                    "http://100.64.2.2:8080/other", // any path on that listener
                    "https://100.64.2.2:8080", // its https spelling
                    "http://[::ffff:100.64.2.2]:8080/v1", // and as a mapped IPv6 literal
                    "http://100.64.2.9:8080/v1", // the next box on the tailnet
                    "http://10.1.2.3:11434/v1", // the LAN, and the k8s service range
                    "http://192.168.1.10:11434/v1", // a LAN box
                    "http://127.0.0.1:11434/v1", // the pod itself
                    "http://169.254.169.254/v1", // node metadata
                ];
                for (const url of refused) {
                    expect((await put(url, "m", "")).status, url).toBe(422);
                }

                Object.assign(llm.SYSTEM_CONFIG, { base_url: "http://9.9.9.9:8080/v1", model: "qwen", api_key: "" });
                expect((await put("http://9.9.9.9:8080/v1", "qwen", "")).status).toBe(422);

                // The moment the origin needs a key, the same host is fine: bringing your own key for the
                // provider we happen to pay is not abusing anything.
                Object.assign(llm.SYSTEM_CONFIG, { base_url: "https://9.9.9.9/v1", model: "managed", api_key: "sk-deployment-key" });
                expect((await put("https://9.9.9.9/v1", "managed", "sk-own-key-1234")).status).toBe(200);
                expect((await put("http://93.184.216.34:1234/v1", "m", "sk-own-key-1234")).status).toBe(200);
            } finally {
                Object.assign(llm.SYSTEM_CONFIG, saved);
                await client.delete("/api/settings/llm");
            }
        });
    });

    it("round trips settings without ever returning the key", async () => {
        await withConfig({ byokEncryptionKey: encryptionKey() }, async () => {
            try {
                const status = await (await client.get("/api/settings/llm")).json<{ enabled: boolean; byok: boolean; system: Record<string, unknown> }>();
                expect([status.enabled, status.byok]).toEqual([true, false]);
                expect(new Set(Object.keys(status.system))).toEqual(new Set(["configured", "base_url", "model"]));

                const written = await client.put("/api/settings/llm", { json: { base_url: "https://api.example.com/v1/", model: "some-model", api_key: BYOK_KEY } });
                expect(written.status).toBe(200);
                const body = await written.json<{ byok: boolean; base_url: string; model: string; key_hint: string }>();
                expect([body.byok, body.base_url, body.model, body.key_hint]).toEqual([true, "https://api.example.com/v1", "some-model", "abcd"]);
                expect(await written.text()).not.toContain(BYOK_KEY);
                expect(await (await client.get("/api/settings/llm")).text()).not.toContain(BYOK_KEY);

                expect((await (await client.put("/api/settings/llm", { json: { base_url: "https://api.example.com/v1", model: "another", api_key: "" } })).json<{ model: string }>()).model).toBe("another");
                expect((await client.delete("/api/settings/llm")).status).toBe(204);
                expect((await (await client.get("/api/settings/llm")).json<{ byok: boolean }>()).byok).toBe(false);
            } finally {
                await client.delete("/api/settings/llm");
            }
        });
    });

    it("refuses a write without the deployment encryption key", async () => {
        await withConfig({ byokEncryptionKey: "" }, async () => {
            const refused = await client.put("/api/settings/llm", { json: { base_url: BYOK_URL, model: "m", api_key: BYOK_KEY } });
            expect(refused.status).toBe(503);
            expect((await refused.json<{ detail: string }>()).detail).toContain("BYOK_ENCRYPTION_KEY");
            expect((await (await client.get("/api/settings/llm")).json<{ enabled: boolean }>()).enabled).toBe(false);
        });
    });
});

describe("hardcore", () => {
    for (const cls of FAIL_CLASSES) {
        it(`ends the run on the first failing answer: ${cls}`, async () => {
            const note = "Named no trade-off: state what you gave up.";
            const iv = await create({ role: "Hardcore Judge", hardcore: true });
            expect(iv.hardcore).toBe(true);
            const id = iv.id as string;
            expect((await client.post(`/api/interviews/${id}/start`)).status).toBe(200);

            const body = await withLlm({ base_url: SYSTEM_URL, model: "unit-model" }, async () => {
                const stub = stubHttp();
                stub.post(completions(SYSTEM_URL), [() => reply(JSON.stringify({ class: cls, comment: note })), () => reply("")]);
                return await (await send(id, "uh, I think we just retried it")).text();
            });
            const shout = llm.FAIL_MESSAGE.replace("{cls}", cls.toUpperCase());
            expect(body).toContain(shout); // shouted, in caps, in the transcript
            expect(body).toContain(`"failed": {"turn": 1, "class": "${cls}"}`); // ...and the client is told why it ended
            expect((await send(id, "one more")).status).toBe(409);

            // The failing answer keeps its class, which is what the review points at, and the note it was
            // judged with: written by that same live call rather than a second pass after the fact.
            const messages = await transcript(id);
            expect(messages.filter((message) => message.role === "user").map((message) => [message.move_class, message.comment])).toEqual([[cls, note]]);
            expect(messages[messages.length - 1].role).toBe("assistant");
            expect(messages[messages.length - 1].content).toBe(shout);

            await withLlm({ base_url: SYSTEM_URL, model: "unit-model" }, async () => {
                const stub = stubHttp();
                stub.post(completions(SYSTEM_URL), [() => reply("The candidate hedged every answer."), () => reply(JSON.stringify({ scores: allDimensions(4), verdict: "run over", tips: ["Read it."], decision: "hire", certainty: 90 }))]);
                expect((await client.post(`/api/interviews/${id}/finish`)).status).toBe(200);
            });
            const fb = await (await client.get(`/api/interviews/${id}/feedback`)).json<{ failed_turn: number; failed_class: string; grade: string; decision: string; verdict: string }>();
            expect([fb.failed_turn, fb.failed_class]).toEqual([1, cls]);
            expect([fb.grade, fb.decision]).toEqual(["F", "reject"]); // a failure overrides the average
            expect(fb.verdict).not.toBe("");
            expect(fb.verdict).toBe(fb.verdict.toUpperCase());

            const listed = (await (await client.get("/api/interviews")).json<{ id: string; failed_turn: number; failed_class: string; grade: string }[]>()).find((row) => row.id === id);
            expect([listed?.failed_turn, listed?.failed_class, listed?.grade]).toEqual([1, cls, "F"]);
            await remove(id);
        });
    }

    it("reaches the client with the shout even if the store fails", async () => {
        const id = await started({ role: "Hardcore Store", hardcore: true });
        await withLlm({ base_url: SYSTEM_URL, model: "unit-model" }, async () => {
            const stub = stubHttp();
            stub.post(completions(SYSTEM_URL), [() => reply(JSON.stringify({ class: "mistake", comment: "Named no trade-off: state what you gave up." })), () => reply("")]);
            await withFailingAssistantWrites(id, async () => {
                const body = await (await send(id, "uh, we retried it")).text();
                expect(body).toContain(llm.FAIL_MESSAGE.replace("{cls}", "MISTAKE")); // still delivered
                expect(body).toContain('"class": "mistake"'); // ...and the client is still told why the run ended
            });
        });
        expect((await transcript(id)).map((message) => message.role)).toEqual(["user"]);
        await remove(id);
    });

    it("survives a judge that comes back empty", async () => {
        const id = await started({ role: "Hardcore Outage", hardcore: true });
        await withLlm({ base_url: SYSTEM_URL, model: "unit-model" }, async () => {
            const stub = stubHttp();
            stub.post(completions(SYSTEM_URL), (call) => {
                const request = JSON.parse(call.body) as { stream?: boolean };
                // The judge names a class it cannot use, twice, and the turn itself still streams.
                return request.stream === true ? sse(["Still here. "]) : reply(JSON.stringify({ class: "unsure" }));
            });
            expect((await send(id, "something the judge could not read")).status).toBe(200);
            expect((await send(id, "the next turn still runs")).status).toBe(200);
        });
        const row = (await (await client.get("/api/interviews")).json<{ id: string; failed_turn: number | null; failed_class: string | null }[]>()).find((entry) => entry.id === id);
        expect([row?.failed_turn, row?.failed_class]).toEqual([null, null]);
        await remove(id);
    });
});

describe("pro model", () => {
    it("runs the pro model for the chat turn but not the grader", async () => {
        const owner = "user_pro";
        const stub = stubHttp();
        stub.on("GET", JWKS_URL, () => json(JWKS));
        const chatModels: string[] = [];
        const graderModels: string[] = [];
        const record = (body: { stream?: boolean; model: string }) => {
            (body.stream === true ? chatModels : graderModels).push(body.model);
        };
        stub.post(completions(PRO.baseUrl), (call) => {
            record(JSON.parse(call.body) as { stream?: boolean; model: string });
            return sse(["Go on."]);
        });
        const sysReplies = ["The candidate was clear.", feedbackContent("Pro review"), movesContent];
        stub.post(completions(SYSTEM_URL), (call) => {
            const body = JSON.parse(call.body) as { stream?: boolean; model: string };
            record(body);
            if (body.stream === true) return sse(["System reply. "]);
            return reply(sysReplies.shift() ?? "");
        });
        const byokModels: string[] = [];
        stub.post(completions(BYOK_URL), (call) => {
            byokModels.push((JSON.parse(call.body) as { model: string }).model);
            return sse(["Byok reply. "]);
        });

        await withConfig({ clerkEnabled: true, clerkJwksUrl: JWKS_URL, byokEncryptionKey: encryptionKey() }, async () => {
            const headers = await signIn(owner);
            const post = (path: string, json?: unknown) => client.post(path, { json, headers });
            const id = (await (await post("/api/interviews", { role: "Pro model" })).json<{ id: string }>()).id;
            let byokId: string | null = null;
            try {
                await withLlm({ base_url: SYSTEM_URL, model: "unit-model" }, async () => {
                    await subscribe(owner);
                    expect((await post(`/api/interviews/${id}/start`)).status).toBe(200);
                    expect(await (await post(`/api/interviews/${id}/chat/opening`)).text()).toContain("Go on.");
                    expect(chatModels[chatModels.length - 1]).toBe(PRO.model);

                    for (const content of ["answer 1", "answer 2"]) {
                        expect((await post(`/api/interviews/${id}/chat/send`, { interview_id: id, content })).status).toBe(200);
                    }
                    expect((await post(`/api/interviews/${id}/finish`)).status).toBe(200);
                    // The up-tier is the interview turn only: a Pro review must stay comparable with a Free one.
                    expect(graderModels.length).toBeGreaterThan(0);
                    expect(graderModels.every((model) => model === llm.SYSTEM_CONFIG.model)).toBe(true);

                    await unsubscribe(owner);
                    const free = (await (await post("/api/interviews", { role: "Free model" })).json<{ id: string }>()).id;
                    await post(`/api/interviews/${free}/start`);
                    await post(`/api/interviews/${free}/chat/opening`);
                    expect(chatModels[chatModels.length - 1]).toBe(llm.SYSTEM_CONFIG.model);
                    await remove(free);

                    // BYOK still wins, because that owner pays.
                    expect((await client.put("/api/settings/llm", { json: { base_url: BYOK_URL, model: "byok-unit-test", api_key: BYOK_KEY }, headers })).status).toBe(200);
                    byokId = (await (await post("/api/interviews", { role: "Pro BYOK model" })).json<{ id: string }>()).id;
                    await post(`/api/interviews/${byokId}/start`);
                    await post(`/api/interviews/${byokId}/chat/opening`);
                    expect(byokModels[byokModels.length - 1]).toBe("byok-unit-test");
                });
            } finally {
                await client.delete("/api/settings/llm", { headers });
                await remove(id);
                if (byokId !== null) await remove(byokId);
                await unsubscribe(owner);
            }
        });
    });

    it("falls back to the deployment model when no pro model is configured", async () => {
        const owner = "user_pro_absent";
        const stub = stubHttp();
        stub.on("GET", JWKS_URL, () => json(JWKS));
        const chatModels: string[] = [];
        const proCalls: string[] = [];
        stub.post(completions(SYSTEM_URL), (call) => {
            chatModels.push((JSON.parse(call.body) as { model: string }).model);
            return sse(["Base reply. "]);
        });
        stub.post(completions(PRO.baseUrl), (call) => {
            proCalls.push(call.body);
            return sse(["Pro reply. "]);
        });

        // PRO_CONFIG is built once at import and this file builds it non-null, so the no-pro deployment is
        // only reachable by hiding the constant. The descriptor goes back before the file goes on.
        const original = Object.getOwnPropertyDescriptor(llm, "PRO_CONFIG") as PropertyDescriptor;
        Object.defineProperty(llm, "PRO_CONFIG", { configurable: true, enumerable: true, get: () => null });
        try {
            await withConfig({ clerkEnabled: true, clerkJwksUrl: JWKS_URL }, async () => {
                const headers = await signIn(owner);
                const post = (path: string, json?: unknown) => client.post(path, { json, headers });
                await subscribe(owner);
                const id = (await (await post("/api/interviews", { role: "Pro absent" })).json<{ id: string }>()).id;
                try {
                    await withLlm({ base_url: SYSTEM_URL, model: "unit-model" }, async () => {
                        expect((await post(`/api/interviews/${id}/start`)).status).toBe(200);
                        expect(await (await post(`/api/interviews/${id}/chat/opening`)).text()).toContain("Base reply.");
                        expect(chatModels.at(-1)).toBe(llm.SYSTEM_CONFIG.model);
                    });
                    expect(proCalls).toEqual([]);
                } finally {
                    await remove(id);
                    await unsubscribe(owner);
                }
            });
        } finally {
            Object.defineProperty(llm, "PRO_CONFIG", original);
        }
        expect(llm.PRO_CONFIG?.model).toBe(PRO.model);
    });
});

describe("analytics", () => {
    const OWNER = "analytics-history-owner";

    it("aggregates the whole history", async () => {
        const headers = { "x-dev-sub": OWNER };
        await fetchrow(sql`DELETE FROM interviews WHERE owner_id = ${OWNER}`);
        const seed: [string, string, boolean, string, number | null, string | null, string[]][] = [
            ["An senior", "senior", false, "completed", 90, "hire", ["brilliant", "great"]],
            ["An junior", "junior", false, "completed", 30, "reject", ["mistake", "blunder"]],
            ["An hardcore", "junior", true, "completed", 50, null, ["good", "inaccuracy"]],
            ["An unscored", "mid", false, "completed", null, null, []],
            ["An running", "mid", false, "in_progress", null, null, ["good"]],
        ];
        const ids: string[] = [];
        try {
            for (const [index, [role, level, hardcore, status, accuracy, decision, classes]] of seed.entries()) {
                const created = await fetchrow(sql`
                    INSERT INTO interviews (owner_id, role, level, hardcore, status, created_at)
                    VALUES (${OWNER}, ${role}, ${level}, ${hardcore}, ${status}, now() - make_interval(mins => ${index}))
                    RETURNING id::text`);
                const id = created?.id as string;
                for (const cls of classes) {
                    await fetchrow(sql`INSERT INTO chat_turns (interview_id, role, content, move_class) VALUES (${id}, 'user', 'a', ${cls})`);
                }
                if (status === "completed" && accuracy !== null) {
                    await fetchrow(sql`INSERT INTO feedback (interview_id, verdict, scores, accuracy, decision) VALUES (${id}, 'v', ${JSON.stringify({ clarity: 4 })}::jsonb, ${accuracy}, ${decision})`);
                }
                if (decision === "hire") {
                    await fetchrow(sql`INSERT INTO offers (interview_id, title, band, base_salary, performance) VALUES (${id}, 'Senior Engineer', 'senior', 1000000, ${accuracy})`);
                }
                ids.push(id);
            }

            const d = await (await client.get("/api/stats/analytics", { headers })).json<AnalyticsPayload>();
            const seeded = d.runs.filter((run) => ids.includes(run.id));
            expect(new Set(seeded.map((run) => run.id))).toEqual(new Set(ids));
            const byId = new Map(seeded.map((run) => [run.id, run]));
            expect([byId.get(ids[0])?.accuracy, byId.get(ids[0])?.grade, byId.get(ids[0])?.decision]).toEqual([90, "S", "hire"]);
            // The run log mixes finished and unfinished runs, so a row has to say which it is.
            expect([byId.get(ids[0])?.status, byId.get(ids[4])?.status]).toEqual(["completed", "in_progress"]);
            expect([byId.get(ids[3])?.scores, byId.get(ids[3])?.grade]).toEqual([{}, null]);
            expect([byId.get(ids[4])?.turns, byId.get(ids[4])?.moves]).toEqual([1, { good: 1 }]);

            // Move distribution: every annotated turn, including the in-progress run's.
            const moves = d.move_classes;
            expect(new Set(Object.keys(moves))).toEqual(new Set(["brilliant", "great", "good", "book", "inaccuracy", "mistake", "blunder"]));
            expect([moves.brilliant, moves.great, moves.good, moves.book]).toEqual([1, 1, 2, 0]);
            expect([moves.inaccuracy, moves.mistake, moves.blunder]).toEqual([1, 1, 1]);
            expect(Object.values(moves).reduce((total, count) => total + count, 0)).toBe(7);
            expect(d.hardcore_failures).toBeGreaterThanOrEqual(0);
            expect(Number.isInteger(d.streak_days)).toBe(true);

            // Dials bucket COMPLETED runs only, in the vocabulary's order.
            const levels = new Map(d.dials.level.map((group) => [group.key, group]));
            expect(levels.get("senior")?.runs).toBe(1);
            expect(levels.get("senior")?.avg_accuracy).toBe(90);
            expect(levels.get("junior")?.runs).toBe(2);
            expect(levels.get("junior")?.rated).toBe(2);
            expect(levels.get("junior")?.avg_accuracy).toBe(40); // mean(30, 50), not diluted by the unscored run
            expect([levels.get("mid")?.runs, levels.get("mid")?.avg_accuracy]).toEqual([1, null]);
            expect(levels.get("mid")?.hire_rate).toBeNull(); // nothing decided, not a 0% rejection rate

            const hardcore = new Map(d.dials.hardcore.map((group) => [group.key, group]));
            expect([hardcore.get("hardcore")?.runs, hardcore.get("standard")?.runs]).toEqual([1, 3]);
            // Hire rate is denominated on DECIDED runs: 1 of 2 here, unaffected by the undecided ones.
            expect([levels.get("junior")?.hire_rate, levels.get("senior")?.hire_rate]).toEqual([0, 100]);

            expect([d.offers.summary.count, d.offers.summary.best_id]).toEqual([1, ids[0]]);

            // Activity: the weekly buckets the page charts, over the seeded runs.
            expect(d.activity.length).toBeGreaterThan(0);
            expect(d.activity.every((entry) => ["week", "started", "completed"].every((key) => key in entry))).toBe(true);
            expect(d.activity.reduce((total, entry) => total + entry.started, 0)).toBeGreaterThanOrEqual(5);
            expect(d.activity.reduce((total, entry) => total + entry.completed, 0)).toBeGreaterThanOrEqual(4);
            expect(d.total_turns).toBeGreaterThanOrEqual(5);
        } finally {
            await fetchrow(sql`DELETE FROM interviews WHERE owner_id = ${OWNER}`);
        }
    });

    it("is owner scoped", async () => {
        const foreign = await fetchrow(sql`
            INSERT INTO interviews (owner_id, role, status) VALUES ('analytics-foreign-owner', 'Not yours', 'completed')
            RETURNING id::text`);
        const foreignId = foreign?.id as string;
        await fetchrow(sql`INSERT INTO chat_turns (interview_id, role, content, move_class) VALUES (${foreignId}, 'user', 'a', 'brilliant')`);
        await fetchrow(sql`INSERT INTO feedback (interview_id, verdict, scores, accuracy) VALUES (${foreignId}, 'v', ${JSON.stringify({ clarity: 10 })}::jsonb, 100)`);
        try {
            const d = await (await client.get("/api/stats/analytics", { headers: { "x-dev-sub": "analytics-scope-owner" } })).json<AnalyticsPayload>();
            expect(d.runs.every((run) => run.id !== foreignId)).toBe(true);
            expect(Object.values(d.move_classes).every((count) => count === 0)).toBe(true);
            expect(Object.values(d.dials).every((group) => group.length === 0)).toBe(true);
        } finally {
            await fetchrow(sql`DELETE FROM interviews WHERE id = ${foreignId}`);
        }
    });

    it("counts consecutive days in the streak", async () => {
        const owner = "analytics-streak-owner";
        const streakFor = async (offsets: number[]): Promise<number> => {
            await fetchrow(sql`DELETE FROM interviews WHERE owner_id = ${owner}`);
            for (const offset of offsets) {
                await fetchrow(sql`INSERT INTO interviews (owner_id, role, status, created_at) VALUES (${owner}, 'Streak Probe', 'pending', CURRENT_DATE - make_interval(days => ${offset}))`);
            }
            return (await (await client.get("/api/stats/analytics", { headers: { "x-dev-sub": owner } })).json<AnalyticsPayload>()).streak_days;
        };
        try {
            expect(await streakFor([0, 1, 2])).toBe(3); // today, yesterday, the day before
            expect(await streakFor([1, 2, 3])).toBe(3); // still alive: practised yesterday, not yet today
            expect(await streakFor([0, 3])).toBe(1); // today only; the older day starts a separate run
            expect(await streakFor([5])).toBe(0); // a week idle is over
            expect(await streakFor([])).toBe(0); // never practised
        } finally {
            await fetchrow(sql`DELETE FROM interviews WHERE owner_id = ${owner}`);
        }
    });
});
