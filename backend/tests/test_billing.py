"""M10 billing/quota unit tests.

Pure-logic tests; DB-backed paths are monkeypatched so this file needs no live pool.
The live daily-interview / chat-turn cap behavior is exercised by the HTTP integration
tests (`test_api.py`), which create real interviews through the `client` fixture.
"""

import pytest

from app import billing
from app.billing import _quota, require_tier, resolve_tier


class _User:
    def __init__(self, sub="user_x", tier="free"):
        self.sub = sub
        self.tier = tier


async def _async_none(*_args, **_kwargs):
    return None


def test_quota_defaults():
    # MONETIZATION.md §0 placeholders by default.
    assert _quota("free", "daily_interviews") == 1
    assert _quota("free", "chat_turns") == 8
    assert _quota("premium", "daily_interviews") == float("inf")


async def test_resolve_tier_premium_subscription_elevates(monkeypatch):
    async def _fake(_, _sub):
        return {"plan": "premium"}  # returned by fetchrow -> found

    monkeypatch.setattr(billing, "fetchrow", _fake)
    assert await resolve_tier(_User("elevated-user", "free")) == "premium"


async def test_resolve_tier_free_when_no_subscription(monkeypatch):
    monkeypatch.setattr(billing, "fetchrow", _async_none)
    assert await resolve_tier(_User("plain-user", "free")) == "free"


async def test_resolve_tier_jwt_premium_wins(monkeypatch):
    # A JWT that already says premium is honored without DB lookups.
    monkeypatch.setattr(billing, "fetchrow", _async_none)
    assert await resolve_tier(_User("p-user", "premium")) == "premium"


def test_require_tier_rejects_free_for_premium():
    with pytest.raises(Exception) as exc:
        require_tier("free", required="premium")
    assert exc.type.__name__ == "HTTPException"
    assert exc.value.status_code == 403


def test_require_tier_allows_free_on_free():
    require_tier("free", required="free")  # no raise


def test_invalid_quota_key_raises_500():
    with pytest.raises(Exception) as exc:
        _quota("free", "nonexistent")
    assert exc.type.__name__ == "HTTPException"
    assert exc.value.status_code == 500


# --- Stripe webhook -> subscriptions upsert (M10 raw Stripe) ---


async def test_webhook_checkout_completed_writes_subscription(monkeypatch):
    """checkout.session.completed upserts a premium subscriptions row."""
    from app import payments

    calls = []  # (query, args)

    async def fake_fetchrow(q, *a, **k):
        calls.append((q, a))
        return {"id": "row"}

    monkeypatch.setattr("app.db.fetchrow", fake_fetchrow)
    event = {
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": "cs_123",
                "customer": "cus_123",
                "status": "complete",
                "metadata": {"owner_id": "paying-user"},
            }
        },
    }
    await payments.handle_webhook_event(event)
    assert calls, "expected an upsert call"
    q, args = calls[0]
    assert "INSERT INTO subscriptions" in q
    assert args[0] == "paying-user"  # owner_id
    assert args[1] == "cus_123"  # stripe_id / customer
    assert args[2] == "active"  # normalized status (complete -> active)


async def test_webhook_subscription_deleted_downgrades(monkeypatch):
    """customer.subscription.deleted drops premium (owner set free)."""
    from app import payments

    calls = []

    async def fake_fetchrow(q, *a, **k):
        calls.append((q, a))
        return {"id": "row"}

    monkeypatch.setattr("app.db.fetchrow", fake_fetchrow)
    event = {
        "type": "customer.subscription.deleted",
        "data": {
            "object": {
                "id": "sub_123",
                "metadata": {"owner_id": "cancelling-user"},
            }
        },
    }
    await payments.handle_webhook_event(event)
    assert calls, "expected a downgrade call"
    q, args = calls[0]
    assert "plan='free'" in q and "status='canceled'" in q
    assert args[0] == "cancelling-user"


async def test_webhook_unknown_type_is_ignored(monkeypatch):
    from app import payments

    calls = []

    async def fake_fetchrow(q, *a, **k):
        calls.append((q, a))
        return {"id": "row"}

    monkeypatch.setattr("app.db.fetchrow", fake_fetchrow)
    await payments.handle_webhook_event({"type": "invoice.paid", "data": {"object": {}}})
    assert calls == []  # no DB write for unrelated events
