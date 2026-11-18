import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { type Attributes, type Context, type ContextManager, context, type Meter, type MeterProvider, metrics, ROOT_CONTEXT, type Span, type TracerProvider, trace } from "@opentelemetry/api";
import { afterEach } from "vitest";

export type LogRecord = { event?: string; [field: string]: unknown };

export type LogCapture = {
    /** Every line pino rendered, parsed: assert on `event` and the fields, not on the whole line. */
    records: LogRecord[];
    /** The same lines as written, for the formatting rules a parsed record cannot show. */
    lines: string[];
    restore: () => void;
};

const captures: LogCapture[] = [];

afterEach(() => {
    for (const capture of captures.splice(0).reverse()) capture.restore();
});

function parse(line: string): LogRecord | null {
    try {
        return JSON.parse(line) as LogRecord;
    } catch {
        return null;
    }
}

/**
 * Sibling of stubHttp(). pino writes to fd 1 through sonic-boom, which bypasses
 * `process.stdout.write`, so the fd write is the only place a line can be read before it is lost.
 *
 * sonic-boom queues a line behind a write that is still in flight and flushes it from that write's
 * callback, which would land the line after the assertion one statement below. Writing fd 1
 * synchronously and releasing the queue here keeps the capture and the assertion on the same tick.
 */
export function captureLogs(): LogCapture {
    const original = fs.write;
    const records: LogRecord[] = [];
    const lines: string[] = [];
    let restored = false;

    fs.write = ((...args: unknown[]) => {
        const [fd, chunk, ...rest] = args;
        if (fd !== 1 || (typeof chunk !== "string" && !Buffer.isBuffer(chunk))) return (original as unknown as (...rest: unknown[]) => unknown).apply(fs, args);
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        for (const line of text.split("\n")) {
            if (line === "") continue;
            lines.push(line);
            const record = parse(line);
            if (record !== null) records.push(record);
        }
        const written = fs.writeSync(1, typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        const release = rest.find((value) => typeof value === "function") as ((err: null, written: number) => void) | undefined;
        release?.(null, written);
        return written;
    }) as typeof fs.write;

    const capture: LogCapture = {
        records,
        lines,
        restore: () => {
            if (restored) return;
            restored = true;
            fs.write = original;
        },
    };
    captures.push(capture);
    return capture;
}

export type MetricSample = { name: string; kind: "gauge" | "histogram"; value: number; attributes: Attributes };

export type MetricCapture = { samples: MetricSample[]; reset: () => void };

const samples: MetricSample[] = [];
let meterInstalled = false;

/**
 * A MeterProvider shim in place of an OTLP reader: it keeps the name, the instrument kind, the value
 * and the attributes, which is everything a cardinality or a "no sample" assertion needs. Installed
 * once, because the API accepts one global provider.
 */
export function captureMetrics(): MetricCapture {
    if (!meterInstalled) {
        meterInstalled = true;
        const meter = {
            createHistogram: (name: string) => ({
                record: (value: number, attributes: Attributes = {}) => samples.push({ name, kind: "histogram", value, attributes }),
            }),
            createGauge: (name: string) => ({
                record: (value: number, attributes: Attributes = {}) => samples.push({ name, kind: "gauge", value, attributes }),
            }),
        } as unknown as Meter;
        metrics.setGlobalMeterProvider({ getMeter: () => meter } as unknown as MeterProvider);
    }
    return { samples, reset: () => samples.splice(0) };
}

export type SpanRecord = { name: string; attributes: Attributes };

export type SpanCapture = { spans: SpanRecord[]; reset: () => void };

const spans: SpanRecord[] = [];
let tracerInstalled = false;

function openSpan(name: string, attributes: Attributes = {}): Span {
    const record: SpanRecord = { name, attributes: { ...attributes } };
    const spanContext = { traceId: randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex"), traceFlags: 1 };
    const span = {
        spanContext: () => spanContext,
        setAttribute: (key: string, value: Attributes[string]) => {
            record.attributes[key] = value;
            return span;
        },
        updateName: (next: string) => {
            record.name = next;
            return span;
        },
        end: () => {
            spans.push(record);
        },
        setStatus: () => span,
        recordException: () => {},
    };
    return span as unknown as Span;
}

const tracer = {
    startSpan: (name: string, options?: { attributes?: Attributes }) => openSpan(name, options?.attributes),
    startActiveSpan: <T>(name: string, options: { attributes?: Attributes }, parentOrBody: Context | ((current: Span) => T), parentedBody?: (current: Span) => T): T => {
        const body = parentedBody ?? (parentOrBody as (current: Span) => T);
        const current = openSpan(name, options.attributes);
        return context.with(trace.setSpan(context.active(), current), () => body(current));
    },
};

// Without a context manager the API's `context.with` is a no-op, so a span never becomes the active
// one and the access line loses its ids. NodeSDK registers the same thing on start; tests never start it.
const store = new AsyncLocalStorage<Context>();

const contextManager = {
    active: () => store.getStore() ?? ROOT_CONTEXT,
    with: <T>(ctx: Context, body: () => T) => store.run(ctx, body),
    bind: <T>(target: T) => target,
    enable: () => contextManager,
    disable: () => contextManager,
} as unknown as ContextManager;

/** A tracer that mints span ids and keeps the name the route gave it; paired with the ALS context manager. */
export function captureSpans(): SpanCapture {
    if (!tracerInstalled) {
        tracerInstalled = true;
        context.setGlobalContextManager(contextManager);
        trace.setGlobalTracerProvider({ getTracer: () => tracer } as unknown as TracerProvider);
    }
    return { spans, reset: () => spans.splice(0) };
}
