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

# Answers every 10s forever and no human question. Skipping it here is the whole of "log shaping":
# cheaper than a Collector rule, and it never reaches the free-tier stream cap.
SKIP_PATH = f"{API_PREFIX}/health"


def _stamp_env(_, __, event_dict: dict) -> dict:
    event_dict["env"] = APP_ENV
    return event_dict


# Shared by the structlog chain and the foreign (stdlib) pre-chain: one shape for every record.
_SHARED_PROCESSORS = [
    structlog.contextvars.merge_contextvars,
    structlog.stdlib.add_log_level,
    _stamp_env,
    structlog.processors.TimeStamper(fmt="iso", utc=True),
    structlog.processors.format_exc_info,
]

# No space after `:` or `,`: the Loki datasource's traceID derived field is a regex with no room for
# whitespace, and it is shared by every project on the stack.
COMPACT_JSON = {"separators": (",", ":")}


def configure_logging() -> None:
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
    # uvicorn's own handlers would escape unformatted. Silenced at the logger, so dev/tests/prod match.
    for name in ("uvicorn", "uvicorn.error"):
        logger = logging.getLogger(name)
        logger.handlers, logger.propagate = [handler], False
    logging.getLogger("uvicorn.access").disabled = True


log = structlog.get_logger(__name__)


class RequestContextMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        request_id = uuid.uuid4().hex
        # Cleared at entry, never at exit: uvicorn logs an unhandled exception ABOVE this frame right
        # after we return, and that traceback is worth more with the id attached.
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

        # Probe path gets no line, no sample, no span: all three would measure the kubelet asking
        # whether the pod is alive.
        with telemetry.span("http.server", record=scope["path"] != SKIP_PATH, **{"http.request.method": scope["method"]}) as current:
            context = current.get_span_context()
            if context.is_valid:
                # On the log line and the span: the Loki derived field turns a `trace_id` in the JSON
                # into the link, and the access line is where a human starts.
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
                    # Identity arrives inside the route, so it is read off the shared scope after the
                    # fact: a contextvar cannot cross the BaseHTTPMiddleware rate limiter.
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
        # label per random path is a cardinality bill.
        return getattr(scope.get("route"), "path", "unmatched")
