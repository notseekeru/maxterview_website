import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { type Attributes, context, type Gauge, type Histogram, metrics, type Span, trace } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AggregationType, InstrumentType, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { Context, MiddlewareHandler } from "hono";
import { matchedRoutes } from "hono/route";
import pino from "pino";
import { config } from "./env.ts";

// The timeout only bounds shutdown: the batch processor exports off the request path and drops on a full queue.
const EXPORT_TIMEOUT_MS = 5_000;
const METRIC_EXPORT_INTERVAL_MS = 60_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const STARTED = performance.now();

// The SDK's default boundaries are written for milliseconds but applied whatever the unit, so with unit="s"
// every request under the largest one lands in a single bucket. These span the real range.
const BUCKET_BOUNDARIES_S = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 40, 60, 120];

let sdk: NodeSDK | null = null;
const instruments = new Map<string, Histogram | Gauge>();

export function enabled(): boolean {
    return config.otelExporterOtlpEndpoint !== "";
}

function set(attributes: Attributes): Attributes {
    return Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined && value !== null));
}

function tracer(): ReturnType<typeof trace.getTracer> {
    return trace.getTracer("maxterview");
}

// `withSpan` needs a callback to run under the span; a streaming call site that yields mid-span holds
// this handle instead.
export function startSpan(name: string, attributes: Attributes = {}): Span {
    return tracer().startSpan(name, { attributes: set(attributes) });
}

export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
    return tracer().startActiveSpan(name, { attributes: set(attributes) }, async (span) => {
        try {
            return await fn(span);
        } catch (err) {
            span.setAttribute("error.type", err instanceof Error ? err.name : String(err));
            throw err;
        } finally {
            span.end();
        }
    });
}

export function record(name: string, value: number, attributes: Attributes = {}): void {
    let instrument = instruments.get(name);
    if (instrument === undefined) {
        instrument = metrics.getMeter("maxterview").createHistogram(name, { unit: "s" });
        // An instrument created before the SDK starts stays a no-op for its whole life, so it is not cached.
        if (sdk !== null) instruments.set(name, instrument);
    }
    instrument.record(value, set(attributes));
}

export function gauge(name: string, value: number, attributes: Attributes = {}): void {
    let instrument = instruments.get(name);
    if (instrument === undefined) {
        instrument = metrics.getMeter("maxterview").createGauge(name, { unit: "1" });
        if (sdk !== null) instruments.set(name, instrument);
    }
    instrument.record(value, set(attributes));
}

export function configure(): boolean {
    if (!enabled() || sdk !== null) return false;
    const endpoint = config.otelExporterOtlpEndpoint;
    sdk = new NodeSDK({
        resource: resourceFromAttributes({ "service.name": "maxterview-backend", "deployment.environment": config.appEnv }),
        traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces`, timeoutMillis: EXPORT_TIMEOUT_MS }),
        metricReaders: [
            new PeriodicExportingMetricReader({
                exporter: new OTLPMetricExporter({ url: `${endpoint}/v1/metrics`, timeoutMillis: EXPORT_TIMEOUT_MS }),
                exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
            }),
        ],
        views: [{ instrumentType: InstrumentType.HISTOGRAM, instrumentUnit: "s", aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries: BUCKET_BOUNDARIES_S } } }],
    });
    sdk.start();
    return true;
}

export function heartbeat(): NodeJS.Timeout {
    const beat = () => gauge("app.uptime", (performance.now() - STARTED) / 1000);
    beat();
    return setInterval(beat, HEARTBEAT_INTERVAL_MS);
}

export async function shutdown(): Promise<void> {
    const current = sdk;
    sdk = null;
    if (current === null) return;
    try {
        await current.shutdown();
    } catch {}
}

export const activeSpan = (): Span | undefined => trace.getSpan(context.active());

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
