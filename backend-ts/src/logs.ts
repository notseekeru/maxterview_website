import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import pino from "pino";
import { config } from "./env.ts";
import { activeSpan, record, withSpan } from "./telemetry.ts";

const SKIP_PATH = "/api/health";

type RequestContext = { request_id: string };

const storage = new AsyncLocalStorage<RequestContext>();

// The structlog `merge_contextvars` equivalent: read per record, so every line emitted below this point
// carries the id and the ids of the span it ran under, without threading them through call signatures.
function contextFields(): Record<string, string> {
    const fields: Record<string, string> = { ...storage.getStore() };
    const span = activeSpan()?.spanContext();
    if (span !== undefined && span.traceId !== "00000000000000000000000000000000") {
        fields.trace_id = span.traceId;
        fields.span_id = span.spanId;
    }
    return fields;
}

function level(name: string): string {
    const value = name.toLowerCase();
    return value === "warning" ? "warn" : value === "critical" ? "fatal" : value;
}

const logger = pino({
    level: level(config.logLevel),
    base: { env: config.appEnv },
    // `timestamp` rather than `time`, and no space after `:` or `,`: the Loki datasource's derived field
    // is a regex over the raw line with no room for whitespace.
    timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
    formatters: { level: (label) => ({ level: label === "warn" ? "warning" : label }) },
    mixin: contextFields,
});

type Fields = Record<string, unknown>;

function emit(method: "debug" | "info" | "warn" | "error"): (event: string, fields?: Fields) => void {
    return (event, fields) => logger[method]({ event, ...fields });
}

// `warning`, not pino's `warn`: the level vocabulary stays the Python's, which the Grafana rules read.
export const log = { debug: emit("debug"), info: emit("info"), warning: emit("warn"), error: emit("error") };

type RequestState = { user_sub?: string };

// FastAPI set `scope["route"]` on a match only. An unmatched path is a scanner, and a metric label per
// random path is a cardinality bill, so the wildcard middleware label becomes "unmatched".
function matchedRoute(c: Context): string {
    const path = matchedRoutes(c).at(-1)?.path;
    return path === undefined || path === "*" ? "unmatched" : path;
}

export const requestContext: MiddlewareHandler = async (c, next) => {
    const requestId = randomUUID().replaceAll("-", "");
    const path = c.req.path;
    const method = c.req.method;
    const started = performance.now();

    const trace = async () => {
        // Probe path gets no line, no sample, no span: all three would measure the kubelet asking whether
        // the pod is alive.
        if (path === SKIP_PATH) {
            await next();
            return;
        }
        await withSpan("http.server", { "http.request.method": method }, async (span) => {
            let status = 500;
            try {
                await next();
                status = c.res.status;
            } finally {
                const route = matchedRoute(c);
                const elapsed = (performance.now() - started) / 1000;
                span.updateName(`${method} ${route}`);
                span.setAttribute("http.route", route);
                span.setAttribute("http.response.status_code", status);
                record("http.server.request.duration", elapsed, {
                    "http.request.method": method,
                    "http.route": route,
                    "http.response.status_code": status,
                });
                log.info("http.request", {
                    method,
                    path,
                    status,
                    duration_ms: Math.round(elapsed * 10000) / 10,
                    user: (c.var as RequestState).user_sub ?? null,
                    interview_id: c.req.param("interview_id") ?? null,
                });
            }
        });
    };

    await storage.run({ request_id: requestId }, async () => {
        try {
            await trace();
        } finally {
            c.header("X-Request-ID", requestId);
        }
    });
};
