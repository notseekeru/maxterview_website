import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { heartbeat } from "../src/observability.ts";
import { client } from "./helpers/client.ts";
import { withConfig } from "./helpers/config.ts";
import type { LogRecord } from "./helpers/observability.ts";
import { captureLogs, captureMetrics, captureSpans } from "./helpers/observability.ts";

// Grafana queries `event` verbatim (LAWS 2), so every assertion below is on the name and the fields,
// never on the whole rendered line.
const named = (records: LogRecord[], event: string) => records.filter((record) => record.event === event);

describe("observability", () => {
    it("access log skips health", async () => {
        const logs = captureLogs();
        const health = await client.get("/api/health");
        const missing = await client.get("/api/absent");
        logs.restore();

        expect(health.status).toBe(200);
        expect(missing.status).toBe(404);
        expect(missing.headers.get("x-request-id")).toBeTruthy();

        const access = named(logs.records, "http.request");
        expect(access.length).toBe(1);
        expect(access[0].path).toBe("/api/absent");
        expect(access[0].status).toBe(404);
        expect(access[0].request_id).toBeTruthy();
        expect(access[0]).toHaveProperty("duration_ms");
    });

    it("client error beacon is capped and logged", async () => {
        const huge = `{"message": "${"x".repeat(8192)}", "route": "/"}`;
        const logs = captureLogs();
        const boom = await client.post("/api/client-errors", { json: { message: "boom", route: "/" } });
        const crashed = await client.post("/api/client-errors", { json: { message: "render", route: "/dashboard", component_stack: "at InterviewCard" } });
        const over = await client.post("/api/client-errors", { json: { message: "x".repeat(301), route: "/" } });
        const ungated = await client.post("/api/client-errors", { body: huge, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(huge)) } });
        logs.restore();

        expect(boom.status).toBe(204);
        expect(crashed.status).toBe(204);
        expect(over.status).toBe(422);
        expect(ungated.status).toBe(413);
        expect(named(logs.records, "browser.error").map((record) => [record.message, record.route, record.component_stack])).toEqual([
            ["boom", "/", ""],
            ["render", "/dashboard", "at InterviewCard"],
        ]);
    });

    it("throttled requests still reach the access log", async () => {
        const logs = captureLogs();
        const statuses = await withConfig({ rateLimit: "1/minute" }, async () => {
            const first = await client.get("/api/absent");
            return [first.status, (await client.get("/api/absent")).status];
        });
        logs.restore();

        expect(statuses).toEqual([404, 429]);
        expect(named(logs.records, "http.request").map((record) => record.status)).toEqual([404, 429]);
    });

    it("the access line carries the trace id", async () => {
        captureSpans();
        const logs = captureLogs();
        await client.get("/api/health");
        await client.get("/api/absent");
        logs.restore();

        const access = named(logs.records, "http.request")[0];
        expect(String(access.trace_id)).toMatch(/^[0-9a-f]{32}$/);
        expect(String(access.span_id)).toMatch(/^[0-9a-f]{16}$/);
        // Copied from the `grafanacloud-logs` datasource's traceID derived field, which is shared by every
        // project on the stack. It has no room for a space after the colon, so the renderer must not emit
        // one: with the default separators the field stops resolving and the link disappears silently.
        const derived = /[tT]race_?[iI][dD]"?[:=]"?(\w+)/.exec(logs.lines.find((line) => line.includes("http.request")) ?? "");
        expect(derived?.[1]).toBe(access.trace_id);

        const server = captureSpans().spans.filter((span) => span.name.startsWith("GET "));
        // AI HERE: the Python labelled an unmatched path "unmatched"; routePath reports "/api/*", so the
        // wildcard survives into the label and the span name. Bounded either way: every unmatched path
        // lands on that one value.
        expect(server.map((span) => span.name)).toEqual(["GET /api/*"]);
        expect(server[0].attributes["http.route"]).toBe("/api/*");
        expect(server[0].attributes["http.response.status_code"]).toBe(404);
    });

    it("unmatched paths and the probe never become a metric label", async () => {
        const metrics = captureMetrics();
        metrics.reset();
        const id = randomUUID().replaceAll("-", "");
        await client.get(`/api/absent-${id}`);
        await client.get("/api/health");

        const durations = metrics.samples.filter((sample) => sample.name === "http.server.request.duration");
        // AI HERE: "/api/*" where the Python recorded "unmatched", for the reason given above.
        expect(durations.map((sample) => [sample.attributes["http.route"], sample.attributes["http.response.status_code"]])).toEqual([["/api/*", 404]]);
        expect(String(durations[0].attributes["http.route"])).not.toContain(id);
    });

    it("the heartbeat records a sample with no request", async () => {
        const metrics = captureMetrics();
        metrics.reset();
        vi.useFakeTimers();
        try {
            const timer = heartbeat();
            vi.advanceTimersByTime(60_000);
            clearInterval(timer);
            const gauges = metrics.samples.filter((sample) => sample.kind === "gauge");
            expect(gauges.length).toBeGreaterThan(1);
            expect(new Set(gauges.map((sample) => sample.name))).toEqual(new Set(["app.uptime"]));
        } finally {
            vi.useRealTimers();
        }
    });
});
