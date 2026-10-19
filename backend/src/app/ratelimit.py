# AI HERE: `MemoryStorage` is per-process — N replicas grant N× the budget. Upgrade path when the
# app stops being a single pod: hand `limits.storage.RedisStorage(<url>)` to the limiter.

import os
from functools import lru_cache

from limits import parse
from limits.aio.storage import MemoryStorage
from limits.aio.strategies import FixedWindowRateLimiter
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from app import API_PREFIX

# Per client per minute. Generous on purpose: a real UI burst (dashboard, create, stream a turn)
# is a handful of requests, and M10's turn caps already bound what a well-behaved client spends.
DEFAULT = "120/minute"
_storage = MemoryStorage()
_limiter = FixedWindowRateLimiter(_storage)

_EXEMPT = frozenset({f"{API_PREFIX}/health", f"{API_PREFIX}/billing/webhook"})


@lru_cache(maxsize=8)
def _item(spec: str):
    return parse(spec)


def spec() -> str:
    return os.getenv("RATE_LIMIT", DEFAULT).strip()


def enabled() -> bool:
    return bool(spec()) and spec().lower() != "off"


if enabled():
    _item(spec())  # fail at boot on a typo, rather than 500 on the first request


def client_key(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.rsplit(",", 1)[-1].strip()
    return request.client.host if request.client else "unknown"


class ClientRateLimitMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if enabled() and request.url.path not in _EXEMPT and not await _limiter.hit(_item(spec()), client_key(request)):
            return JSONResponse(
                {"detail": "Too many requests. Slow down and retry in a moment."},
                status_code=429,
                headers={"Retry-After": "60"},
            )
        return await call_next(request)
