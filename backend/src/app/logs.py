"""Structured logging + per-request context (M13 tier 1).

Two producers reach stdout: structlog (our calls) and stdlib `logging` (uvicorn, libraries, and every
unhandled traceback). `configure_logging()` routes both through one chain — without that bridge prod
is a mix of JSON and plain text, and the plain-text lines are the ones that matter most.

AI HERE: logs are the ONLY telemetry this app ships. Rate, latency, error ratio and turn cost are
LogQL queries over these lines; the upgrade path is an OTLP exporter when a number needs a real
histogram or history past Loki's 14-day retention (PLAN M13).
"""

import logging
import os
import sys
import time
import uuid

import structlog
from starlette.datastructures import MutableHeaders

from app import API_PREFIX

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


def configure_logging() -> None:
    """Call once at import of the app module, before anything logs."""
    renderer = structlog.dev.ConsoleRenderer() if APP_ENV in ("development", "test") else structlog.processors.JSONRenderer()
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

        try:
            await self.app(scope, receive, send_with_id)
        finally:
            if scope["path"] != SKIP_PATH:
                # Auth and routing run inside the route, so identity and the path params are read off
                # the shared scope after the fact: contextvars cannot carry them back up here, since
                # the rate limiter is a BaseHTTPMiddleware and blocks upward propagation.
                log.info(
                    "http.request",
                    method=scope["method"],
                    path=scope["path"],
                    status=status,
                    duration_ms=round((time.perf_counter() - started) * 1000, 1),
                    user=scope.get("state", {}).get("user_sub"),
                    interview_id=(scope.get("path_params") or {}).get("interview_id"),
                )
