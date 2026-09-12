"""M11 hardening: the app-level limiter, the CORS allow-list switch, and the input bound.

No DB and no Postgres: every assertion here is decided before a handler touches the pool.
"""

from fastapi.testclient import TestClient

from app import ratelimit
from app.main import CORS_ALLOW_ORIGINS, app, cors_origins


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
