import { describe, expect, it } from "vitest";
import { z } from "zod";
import { app } from "../src/app.ts";
import { config, readConfig, reconfigure } from "../src/env.ts";
import { validationError } from "../src/errors.ts";

describe("config", () => {
    it("reads the Python defaults from an empty env", () => {
        const c = readConfig({});
        expect([c.appEnv, c.logLevel, c.rateLimit, c.resumeMaxBytes, c.voiceMaxUploadBytes, c.voiceTtsCacheBytes, c.latexMemoryMb]).toEqual(["development", "INFO", "120/minute", 2097152, 8388608, 8388608, 192]);
        expect(c.corsAllowOrigins).toEqual([]);
        expect(c.llmGraderBaseUrl).toBe("");
    });

    it("parses a comma list and falls back on a non-finite int", () => {
        expect(readConfig({ CORS_ALLOW_ORIGINS: "https://a.test, https://b.test ," }).corsAllowOrigins).toEqual(["https://a.test", "https://b.test"]);
        expect(readConfig({ DB_POOL_MAX: "many" }).dbPoolMax).toBe(20);
    });

    it("reconfigures the shared object in place", () => {
        reconfigure({ appEnv: "test" });
        expect(config.appEnv).toBe("test");
        reconfigure({ appEnv: "development" });
    });
});

describe("app", () => {
    it("serves health under the /api prefix", async () => {
        const res = await app.request("/api/health");
        expect(await res.json()).toEqual({ status: "ok", up: 1 });
    });

    it("answers an unknown route with the handled envelope", async () => {
        const res = await app.request("/api/missing");
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ detail: "Not Found" });
    });

    it("rejects an oversized client error report before parsing", async () => {
        const res = await app.request("/api/client-errors", { method: "POST", body: "{}", headers: { "content-length": "5000" } });
        expect(res.status).toBe(413);
    });

    it("accepts a valid report with 204 and rejects a malformed one", async () => {
        const ok = await app.request("/api/client-errors", { method: "POST", body: JSON.stringify({ message: "boom" }) });
        expect(ok.status).toBe(204);
        const bad = await app.request("/api/client-errors", { method: "POST", body: JSON.stringify({ route: "/x" }) });
        expect(bad.status).toBe(422);
        expect(await bad.json()).toEqual({ detail: "Not a browser error report" });
    });

    it("maps a zod failure to 422 with loc and msg", () => {
        const parsed = z.object({ message: z.string().min(1) }).safeParse({ message: "" });
        if (parsed.success) throw new Error("expected a zod failure");
        const error = validationError(parsed.error);
        expect(error.status).toBe(422);
        expect(error.detail).toEqual([{ loc: ["body", "message"], msg: expect.any(String) }]);
    });
});
