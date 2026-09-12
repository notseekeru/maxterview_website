"""M11 hardening: the app-level limiter, the CORS allow-list switch, and the input bound.

No DB and no Postgres: every assertion here is decided before a handler touches the pool.
"""

from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from app import ratelimit
from app.main import CORS_ALLOW_ORIGINS, app, cors_origins
from app.ratelimit import ClientRateLimitMiddleware


class _Req:
    """Duck-typed request: `client_key` only reads `.headers` and `.client.host`."""

    def __init__(self, headers=None, host="peer"):
        self.headers = headers or {}
        self.client = type("C", (), {"host": host})()


def test_health_is_never_throttled(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT", "1/minute")
    with TestClient(app) as c:
        assert [c.get("/health").status_code for _ in range(3)] == [200, 200, 200]


def test_client_is_throttled_past_the_window_budget(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT", "2/minute")
    # raise_server_exceptions=False: with no DB reachable these 500 instead of 200 — irrelevant,
    # the assertion is which ones are NOT throttled and that the third one is.
    with TestClient(app, raise_server_exceptions=False) as c:
        assert 429 not in [c.get("/interviews").status_code for _ in range(2)]
        throttled = c.get("/interviews")
    assert throttled.status_code == 429
    assert throttled.json()["detail"].startswith("Too many requests")
    assert throttled.headers["retry-after"] == "60"


def test_forwarded_for_is_charged_by_its_right_most_hop():
    # The ingress appends the peer it saw, so a client-supplied left entry cannot rotate the key.
    assert ratelimit.client_key(_Req({"x-forwarded-for": "1.2.3.4, 5.6.7.8"})) == "5.6.7.8"
    assert ratelimit.client_key(_Req()) == "peer"


def test_cors_stays_off_until_an_origin_is_listed():
    # Same-origin via the `/api` proxy is the shipping shape (PLAN §7), so the allow-list is empty.
    assert CORS_ALLOW_ORIGINS == []
    assert cors_origins(" https://a.example ,https://b.example, ") == ["https://a.example", "https://b.example"]


def test_chat_turn_length_is_bounded():
    with TestClient(app, raise_server_exceptions=False) as c:
        for bad in ("", "x" * 4001):
            r = c.post("/interviews/x/chat/stream", json={"interview_id": "x", "content": bad})
            assert r.status_code == 422, len(bad) if isinstance(bad, str) else bad


def test_cors_middleware_answers_preflight_only_for_listed_origins(monkeypatch):
    # The switch is read at import, so this test is the one place that reloads the module with the
    # env set: it proves the allow-list reaches the wire, not just the parser above.
    import importlib

    from app import main as main_module

    monkeypatch.setenv("CORS_ALLOW_ORIGINS", "https://app.example,https://other.example")
    try:
        reloaded = importlib.reload(main_module)
        assert reloaded.CORS_ALLOW_ORIGINS == ["https://app.example", "https://other.example"]
        with TestClient(reloaded.app) as c:
            allowed = c.options("/usage", headers={"Origin": "https://app.example", "Access-Control-Request-Method": "GET"})
            assert allowed.headers["access-control-allow-origin"] == "https://app.example"
            assert allowed.headers["access-control-allow-credentials"] == "true"
            denied = c.options("/usage", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "GET"})
            assert "access-control-allow-origin" not in denied.headers
    finally:
        monkeypatch.delenv("CORS_ALLOW_ORIGINS")
        importlib.reload(main_module)


def test_middleware_does_not_buffer_streaming_responses(monkeypatch):
    # SSE chat is the core feature and BaseHTTPMiddleware sits in front of it. Driven at the raw ASGI
    # level: TestClient and httpx's ASGITransport both coalesce the body before yielding it, which
    # hides exactly this failure (verified against a live uvicorn too: 78ms/577ms per frame).
    import asyncio
    import time

    from starlette.middleware.base import BaseHTTPMiddleware
    from starlette.responses import Response

    monkeypatch.setenv("RATE_LIMIT", "off")

    def probe(with_middleware) -> "FastAPI":
        app = FastAPI()

        @app.get("/stream")
        async def stream():
            async def gen():
                yield b"first\n"
                await asyncio.sleep(0.3)
                yield b"second\n"

            return StreamingResponse(gen(), media_type="text/plain")

        app.add_middleware(with_middleware)
        return app

    class _Buffering(BaseHTTPMiddleware):
        """Deliberately wrong: collects the stream, so both chunks land together."""

        async def dispatch(self, request, call_next):
            resp = await call_next(request)
            return Response(b"".join([chunk async for chunk in resp.body_iterator]), status_code=resp.status_code, media_type=resp.media_type)

    def profile(app) -> tuple[bytes, float]:
        """(body, spread between the first and last body chunk) for one GET /stream."""

        async def measure():
            scope = {"type": "http", "method": "GET", "path": "/stream", "raw_path": b"/stream", "query_string": b"", "headers": [], "client": ("t", 1), "server": ("t", 80), "scheme": "http", "http_version": "1.1", "root_path": ""}
            chunks: list[tuple[float, bytes]] = []
            asked = False
            idle = asyncio.Event()  # never disconnects: the app ends when its body task does

            async def receive():
                nonlocal asked
                if not asked:
                    asked = True
                    return {"type": "http.request", "body": b"", "more_body": False}
                await idle.wait()
                return {"type": "http.disconnect"}

            async def send(message):
                if message["type"] == "http.response.body" and message.get("body"):
                    chunks.append((time.monotonic(), message["body"]))

            await app.build_middleware_stack()(scope, receive, send)
            return b"".join(c for _, c in chunks), (chunks[-1][0] - chunks[0][0] if len(chunks) > 1 else 0.0)

        return asyncio.run(measure())

    body, spread = profile(probe(ClientRateLimitMiddleware))
    assert body == b"first\nsecond\n"
    assert spread > 0.2, f"chunks arrived {spread:.3f}s apart — the middleware is buffering the stream"
    # The control proves the probe can SEE buffering: this is what a regression would look like.
    assert profile(probe(_Buffering)) == (b"first\nsecond\n", 0.0)
