"""M13 tier 1: one access line per request, none for the probe path, X-Request-ID on the response."""

import json
import logging

import structlog
from fastapi.testclient import TestClient

from app.main import app


def _capture_json() -> tuple[logging.Handler, list[dict]]:
    """Records as JSON, independent of pytest's stdout capture: the production handler binds
    `sys.stdout` at import time, so `capsys`/`capfd` see nothing of it."""
    lines: list[dict] = []

    class _Capture(logging.Handler):
        def emit(self, record):
            lines.append(json.loads(self.format(record)))

    handler = _Capture()
    handler.setFormatter(structlog.stdlib.ProcessorFormatter(processors=[structlog.stdlib.ProcessorFormatter.remove_processors_meta, structlog.processors.JSONRenderer()]))
    return handler, lines


def test_access_log_skips_health():
    handler, lines = _capture_json()
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        with TestClient(app) as client:
            assert client.get("/api/health").status_code == 200
            res = client.get("/api/absent")  # a missing route: no auth, no DB — the middleware alone
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
