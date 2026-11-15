import { Hono, type MiddlewareHandler } from "hono";
import { describe, expect, it, vi } from "vitest";
import { config, readConfig } from "../src/env.ts";
import { ChatTurn } from "../src/models.ts";
import { rateLimit } from "../src/ratelimit.ts";
import { client } from "./helpers/client.ts";
import { withConfig } from "./helpers/config.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const throttled = (status: number) => status === 429;

describe("security", () => {
    it("health is never throttled", async () => {
        const statuses = await withConfig({ rateLimit: "1/minute" }, async () => {
            const seen: number[] = [];
            for (let i = 0; i < 3; i += 1) seen.push((await client.get("/api/health")).status);
            return seen;
        });

        expect(statuses).toEqual([200, 200, 200]);
    });

    it("client is throttled past the window budget", async () => {
        const { first, refused } = await withConfig({ rateLimit: "2/minute" }, async () => {
            const first: number[] = [];
            for (let i = 0; i < 2; i += 1) first.push((await client.get("/api/interviews")).status);
            return { first, refused: await client.get("/api/interviews") };
        });

        expect(first.filter(throttled)).toEqual([]);
        expect(refused.status).toBe(429);
        expect((await refused.json<{ detail: string }>()).detail.startsWith("Too many requests")).toBe(true);
        expect(refused.headers.get("retry-after")).toBe("60");
    });

    it("forwarded for is charged by its right most hop", async () => {
        const hops = await withConfig({ rateLimit: "3/minute" }, async () => {
            const seen: number[] = [];
            for (const forwarded of ["1.2.3.4, 5.6.7.8", "9.9.9.9, 5.6.7.8", "7.7.7.7, 5.6.7.8", "8.8.8.8, 5.6.7.8", "5.6.7.8, 1.2.3.4"]) {
                seen.push((await client.get("/api/interviews", { headers: { "x-forwarded-for": forwarded } })).status);
            }
            return seen;
        });

        // Three different left-most hops, one bucket: the right-most hop is what gets charged.
        expect(hops.slice(0, 3).filter(throttled)).toEqual([]);
        expect(hops[3]).toBe(429);
        // The first hop of an earlier request is a bucket of its own once it moves to the right.
        expect(hops[4]).not.toBe(429);

        // No X-Forwarded-For at all: every caller shares one bucket, so the second request is refused.
        const direct = await withConfig({ rateLimit: "1/minute" }, async () => [(await client.get("/api/interviews")).status, (await client.get("/api/interviews")).status]);
        expect(direct[0]).not.toBe(429);
        expect(direct[1]).toBe(429);
    });

    it("cors stays off until an origin is listed", () => {
        expect(config.corsAllowOrigins).toEqual([]);
        expect(readConfig({ CORS_ALLOW_ORIGINS: " https://a.example ,https://b.example, " }).corsAllowOrigins).toEqual(["https://a.example", "https://b.example"]);
    });

    it("chat turn length is bounded", async () => {
        const cap = ChatTurn.shape.content.maxLength;
        expect(cap).toBeTypeOf("number");

        for (const content of ["", "x".repeat((cap ?? 0) + 1)]) {
            const response = await client.post("/api/interviews/x/chat/send", { json: { interview_id: "x", content } });
            expect(response.status, `content length ${content.length}`).toBe(422);
        }
    });

    it("cors middleware answers preflight only for listed origins", async () => {
        process.env.CORS_ALLOW_ORIGINS = "https://app.example,https://other.example";
        vi.resetModules();
        try {
            const [{ app: reloaded }, { config: reloadedConfig }] = await Promise.all([import("../src/app.ts"), import("../src/env.ts")]);
            expect(reloadedConfig.corsAllowOrigins).toEqual(["https://app.example", "https://other.example"]);

            const preflight = (origin: string) => reloaded.request("/api/billing/usage", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "GET" } });

            const allowed = await preflight("https://app.example");
            expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example");
            expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");
            expect((await preflight("https://evil.example")).headers.get("access-control-allow-origin")).toBeNull();
        } finally {
            delete process.env.CORS_ALLOW_ORIGINS;
            vi.resetModules();
        }
    });

    it("middleware does not buffer streaming responses", async () => {
        function probe(middleware: MiddlewareHandler) {
            const probeApp = new Hono().basePath("/api");
            probeApp.use("*", middleware);
            probeApp.get("/stream", () => {
                const body = new ReadableStream<Uint8Array>({
                    async start(controller) {
                        controller.enqueue(new TextEncoder().encode("first\n"));
                        await sleep(300);
                        controller.enqueue(new TextEncoder().encode("second\n"));
                        controller.close();
                    },
                });
                return new Response(body, { headers: { "content-type": "text/plain" } });
            });
            return probeApp;
        }

        async function profile(middleware: MiddlewareHandler): Promise<{ body: string; spread: number }> {
            const response = await probe(middleware).request("/api/stream");
            const reader = (response.body as ReadableStream<Uint8Array>).getReader();
            const chunks: { at: number; text: string }[] = [];
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push({ at: performance.now(), text: new TextDecoder().decode(value) });
            }
            return {
                body: chunks.map((chunk) => chunk.text).join(""),
                spread: chunks.length > 1 ? chunks[chunks.length - 1].at - chunks[0].at : 0,
            };
        }

        const buffering: MiddlewareHandler = async (c, next) => {
            await next();
            c.res = new Response(await c.res.arrayBuffer(), { status: c.res.status, headers: c.res.headers });
        };

        const streamed = await withConfig({ rateLimit: "100/minute" }, () => profile(rateLimit));
        expect(streamed.body).toBe("first\nsecond\n");
        expect(streamed.spread).toBeGreaterThan(0.2);
        // The control proves the probe can SEE buffering: this is what a regression would look like.
        expect(await profile(buffering)).toEqual({ body: "first\nsecond\n", spread: 0 });
    });
});
