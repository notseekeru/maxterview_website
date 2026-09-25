"""Structured logging + per-request context (M13 tier 1).

Two producers reach stdout: structlog (our calls) and stdlib `logging` (uvicorn, libraries, and every
unhandled traceback). `configure_logging()` routes both through one chain — without that bridge prod
is a mix of JSON and plain text, and the plain-text lines are the ones that matter most.

Logs stay the only signal for content: every number the dashboard derives from a log line is a LogQL
aggregate, which is an approximation over whatever lines survive 14 days of retention. Duration moved
to `telemetry.py`, which is what makes a percentile real (M13 tier 3).
"""

import logging
import os
import sys
import time
import uuid

import structlog
from starlette.datastructures import MutableHeaders

from app import API_PREFIX, telemetry

APP_ENV = os.getenv("APP_ENV", "development")
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

# The probe path answers every 10s forever and no question a human asks. Skipping it here is the
# whole of "log shaping": cheaper than a Collector rule and it never reaches the free-tier stream cap.
SKIP_PATH = f"{API_PREFIX}/health"

# Shared by the structlog chain and the foreign (stdlib) pre-chain: one shape for every record.
_SHARED_PROCESSORS = [
    structlog.contextvars.merge_contextvars,
    structlog.stdlib.add_log_level,
    structlog.processors.TimeStamper(fmt="iso", utc=True),
    structlog.processors.format_exc_info,
]

# No space after `:` or `,`. The `grafanacloud-logs` datasource's traceID derived field is a regex over
# the raw line (`[tT]race_?[iI][dD]"?[:=]"?(\w+)`) with no room for whitespace, and that field is
# shared by every project on the stack, so the shape of our JSON is its contract. Compact also trims
# a byte or two per line off every log the cluster ships.
COMPACT_JSON = {"separators": (",", ":")}


def configure_logging() -> None:
    """Call once at import of the app module, before anything logs."""
    renderer = structlog.dev.ConsoleRenderer() if APP_ENV in ("development", "test") else structlog.processors.JSONRenderer(**COMPACT_JSON)
    structlog.configure(
        processors=[*_SHARED_PROCESSORS, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        structlog.stdlib.ProcessorFormatter(
            processors=[structlog.stdlib.ProcessorFormatter.remove_processors_meta, renderer],
            foreign_pre_chain=_SHARED_PROCESSORS,
        )
    )
    logging.basicConfig(level=LOG_LEVEL, handlers=[handler], force=True)
    # uvicorn configures its own handlers before importing the app; take them over so nothing escapes
    # unformatted, and drop its access log — the middleware below is the access log now. Silencing at
    # the logger (not via the `--no-access-log` flag) keeps dev, tests and prod identical.
    for name in ("uvicorn", "uvicorn.error"):
        logger = logging.getLogger(name)
        logger.handlers, logger.propagate = [handler], False
    logging.getLogger("uvicorn.access").disabled = True


log = structlog.get_logger(__name__)


class RequestContextMiddleware:
    """One structured access line per request, plus `X-Request-ID` on every response.

    Pure ASGI rather than `BaseHTTPMiddleware`: no task boundary, so the response is never buffered
    (SSE keeps streaming) and `duration_ms` covers the whole body — for a chat turn that is the turn.
    The root OTLP span wraps the same region, so the metric, the log line and the trace are one
    measurement of one thing.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = uuid.uuid4().hex
        # Cleared at entry, never at exit: an unhandled exception is logged by uvicorn *above* this
        # frame right after we return, and that traceback is worth more with the id attached.
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(request_id=request_id)
        status = 500  # a request that never started a response failed; it did not succeed
        started = time.perf_counter()

        async def send_with_id(message):
            nonlocal status
            if message["type"] == "http.response.start":
                status = message["status"]
                MutableHeaders(scope=message)["X-Request-ID"] = request_id
            await send(message)

        # The probe path gets no line, no sample and no span: all three would be measurements of the
        # kubelet asking whether the pod is alive.
        with telemetry.span("http.server", record=scope["path"] != SKIP_PATH, **{"http.request.method": scope["method"]}) as current:
            context = current.get_span_context()
            if context.is_valid:
                # On the log line as well as the span: the Loki datasource's derived field turns a
                # `trace_id` in the JSON into the link, and the access line is where a human starts.
                structlog.contextvars.bind_contextvars(trace_id=format(context.trace_id, "032x"), span_id=format(context.span_id, "016x"))
            try:
                await self.app(scope, receive, send_with_id)
            finally:
                elapsed = time.perf_counter() - started
                route = self._route(scope)
                current.update_name(f"{scope['method']} {route}")
                current.set_attribute("http.route", route)
                current.set_attribute("http.response.status_code", status)
                if scope["path"] != SKIP_PATH:
                    telemetry.record("http.server.request.duration", elapsed, **{"http.request.method": scope["method"], "http.route": route, "http.response.status_code": status})
                    # Auth and routing run inside the route, so identity and the path params are read off
                    # the shared scope after the fact: contextvars cannot carry them back up here, since
                    # the rate limiter is a BaseHTTPMiddleware and blocks upward propagation.
                    log.info(
                        "http.request",
                        method=scope["method"],
                        path=scope["path"],
                        status=status,
                        duration_ms=round(elapsed * 1000, 1),
                        user=scope.get("state", {}).get("user_sub"),
                        interview_id=(scope.get("path_params") or {}).get("interview_id"),
                    )

    @staticmethod
    def _route(scope) -> str:
        # FastAPI sets `scope["route"]` on a match only. An unmatched path is a scanner, and a metric
        # label per random path is a cardinality bill: one bucket set per URL ever probed.
        return getattr(scope.get("route"), "path", "unmatched")
