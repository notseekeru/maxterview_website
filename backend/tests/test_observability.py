import asyncio
import json
import logging
import re
import uuid
from contextlib import suppress

import structlog
from fastapi.testclient import TestClient
from opentelemetry import metrics, trace
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from app import telemetry
from app.main import app


def _capture_json() -> tuple[logging.Handler, list[dict], list[str]]:
    lines: list[dict] = []
    raw: list[str] = []

    class _Capture(logging.Handler):
        def emit(self, record):
            text = self.format(record)
            raw.append(text)
            lines.append(json.loads(text))

    handler = _Capture()
    handler.setFormatter(structlog.stdlib.ProcessorFormatter(processors=[structlog.stdlib.ProcessorFormatter.remove_processors_meta, structlog.processors.JSONRenderer(separators=(",", ":"))]))
    return handler, lines, raw


def test_access_log_skips_health():
    handler, lines, _ = _capture_json()
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        with TestClient(app) as client:
            assert client.get("/api/health").status_code == 200
            res = client.get("/api/absent")  # a missing route: no auth, no DB, the middleware alone
    finally:
        root.removeHandler(handler)

    assert res.status_code == 404
    assert res.headers["x-request-id"]

    access = [line for line in lines if line.get("event") == "http.request"]
    assert len(access) == 1  # /api/health emitted none
    assert access[0]["path"] == "/api/absent"
    assert access[0]["status"] == 404
    assert access[0]["request_id"]  # the bound context, not only an argument
    assert "duration_ms" in access[0]


def test_client_error_beacon_is_capped_and_logged():
    handler, lines, _ = _capture_json()
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        with TestClient(app) as client:
            assert client.post("/api/client-errors", json={"message": "boom", "route": "/"}).status_code == 204
            crashed = client.post("/api/client-errors", json={"message": "render", "route": "/dashboard", "component_stack": "at InterviewCard"})
            over = client.post("/api/client-errors", json={"message": "x" * 301, "route": "/"})
            huge = client.post("/api/client-errors", content=b'{"message": "' + b"x" * 8192 + b'", "route": "/"}')
    finally:
        root.removeHandler(handler)

    assert crashed.status_code == 204
    assert over.status_code == 422  # unauthenticated input: the field cap is the size ceiling
    assert huge.status_code == 413  # and the declared length is checked before the body is parsed
    assert [(line["message"], line["route"], line["component_stack"]) for line in lines if line.get("event") == "browser.error"] == [
        ("boom", "/", ""),
        ("render", "/dashboard", "at InterviewCard"),
    ]


def test_throttled_requests_still_reach_the_access_log(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT", "1/minute")
    handler, lines, _ = _capture_json()
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        with TestClient(app) as client:
            assert client.get("/api/absent").status_code == 404
            throttled = client.get("/api/absent")
    finally:
        root.removeHandler(handler)

    assert throttled.status_code == 429
    assert [line["status"] for line in lines if line.get("event") == "http.request"] == [404, 429]


def test_the_access_line_carries_the_trace_id():
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    handler, lines, raw = _capture_json()
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        with TestClient(app) as client:
            assert client.get("/api/health").status_code == 200
            assert client.get("/api/absent").status_code == 404
    finally:
        root.removeHandler(handler)

    access = next(line for line in lines if line.get("event") == "http.request")
    assert len(access["trace_id"]) == 32 and int(access["trace_id"], 16) >= 0
    assert len(access["span_id"]) == 16
    # Copied from the `grafanacloud-logs` datasource's traceID derived field, which is shared by every
    # project on the stack. It has no room for a space after the colon, so the renderer must not emit
    # one: with the default separators the field stops resolving and the link disappears silently.
    derived_field = re.compile(r'[tT]race_?[iI][dD]"?[:=]"?(\w+)')
    line = next(text for text in raw if "http.request" in text)
    match = derived_field.search(line)
    assert match and match.group(1) == access["trace_id"]

    spans = exporter.get_finished_spans()
    assert [s.name for s in spans] == ["GET unmatched"]
    assert spans[0].attributes["http.route"] == "unmatched"
    assert spans[0].attributes["http.response.status_code"] == 404


def test_unmatched_paths_and_the_probe_never_become_a_metric_label():
    reader = InMemoryMetricReader()
    metrics.set_meter_provider(MeterProvider(metric_readers=[reader]))
    telemetry._instruments.clear()
    with TestClient(app) as client:
        assert client.get("/api/absent-" + uuid.uuid4().hex).status_code == 404
        assert client.get("/api/health").status_code == 200

    durations = [point for resource in reader.get_metrics_data().resource_metrics for scope in resource.scope_metrics for metric in scope.metrics for point in metric.data.data_points]
    assert [(point.attributes["http.route"], point.attributes["http.response.status_code"]) for point in durations] == [("unmatched", 404)]


def test_the_heartbeat_records_a_sample_with_no_request(monkeypatch):
    samples = []
    monkeypatch.setattr(telemetry, "gauge", lambda name, value, **attributes: samples.append(name))
    monkeypatch.setattr(telemetry, "HEARTBEAT_INTERVAL_S", 0)

    async def ticks():
        task = asyncio.create_task(telemetry.heartbeat())
        await asyncio.sleep(0.01)
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task

    asyncio.run(ticks())
    assert len(samples) > 1 and set(samples) == {"app.uptime"}
