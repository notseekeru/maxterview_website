import asyncio
import os
import time
from contextlib import contextmanager

from opentelemetry import metrics, trace
from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.trace import INVALID_SPAN_CONTEXT, NonRecordingSpan

ENDPOINT = os.getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "").rstrip("/")
APP_ENV = os.getenv("APP_ENV", "development")

# The batch processor exports on its own thread and drops on a full queue (2048 spans), so an
# unreachable collector costs the request path nothing. The timeout only bounds shutdown.
EXPORT_TIMEOUT_S = 5.0
METRIC_EXPORT_INTERVAL_MS = 60_000
HEARTBEAT_INTERVAL_S = 30
_STARTED = time.monotonic()

# The SDK's default boundaries are written for milliseconds but applied whatever the unit, so with
# unit="s" every request under the largest one lands in a single bucket. These span the real range.
BUCKET_BOUNDARIES_S = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 40, 60, 120]

_providers: list = []
_instruments: dict = {}


def enabled() -> bool:
    return bool(ENDPOINT)


def _set(values: dict) -> dict:
    return {key: value for key, value in values.items() if value is not None}


@contextmanager
def span(name: str, *, record: bool = True, **attributes):
    if not record:
        with trace.use_span(NonRecordingSpan(INVALID_SPAN_CONTEXT), end_on_exit=False):
            yield NonRecordingSpan(INVALID_SPAN_CONTEXT)
        return
    with trace.get_tracer("maxterview").start_as_current_span(name) as current:
        for key, value in _set(attributes).items():
            current.set_attribute(key, value)
        try:
            yield current
        except BaseException as exc:
            current.set_attribute("error.type", type(exc).__name__)
            raise


def record(name: str, value: float, **attributes) -> None:
    instrument = _instruments.get(name)
    if instrument is None:
        instrument = _instruments[name] = metrics.get_meter("maxterview").create_histogram(name, unit="s", explicit_bucket_boundaries_advisory=BUCKET_BOUNDARIES_S)
    instrument.record(value, _set(attributes))


def gauge(name: str, value: float, **attributes) -> None:
    instrument = _instruments.get(name)
    if instrument is None:
        instrument = _instruments[name] = metrics.get_meter("maxterview").create_gauge(name, unit="1")
    instrument.set(value, _set(attributes))


def configure() -> bool:
    if not ENDPOINT or _providers:
        return False
    resource = Resource.create({"service.name": "maxterview-backend", "deployment.environment": APP_ENV})
    spans = TracerProvider(resource=resource)
    spans.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{ENDPOINT}/v1/traces", timeout=EXPORT_TIMEOUT_S)))
    trace.set_tracer_provider(spans)
    samples = MeterProvider(
        resource=resource,
        metric_readers=[PeriodicExportingMetricReader(OTLPMetricExporter(endpoint=f"{ENDPOINT}/v1/metrics", timeout=EXPORT_TIMEOUT_S), export_interval_millis=METRIC_EXPORT_INTERVAL_MS)],
    )
    metrics.set_meter_provider(samples)
    _providers.extend((spans, samples))
    return True


async def heartbeat() -> None:
    while True:
        gauge("app.uptime", time.monotonic() - _STARTED)
        await asyncio.sleep(HEARTBEAT_INTERVAL_S)


def shutdown() -> None:
    for provider in _providers:
        try:
            provider.shutdown()
        except Exception:
            pass
