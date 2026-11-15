import { type Attributes, context, type Gauge, type Histogram, metrics, type Span, trace } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { AggregationType, InstrumentType, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
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
