"""M10 billing/quota unit tests.

Pure-logic tests; DB-backed paths are monkeypatched so this file needs no live pool.
The live daily-interview / chat-turn cap behavior is exercised by the HTTP integration
tests (`test_api.py`), which create real interviews through the `client` fixture.
"""

import pytest

from app import billing
from app.billing import _quota, resolve_tier


class _User:
    def __init__(self, sub="user_x", tier="free"):
        self.sub = sub
        self.tier = tier


async def _async_none(*_args, **_kwargs):
    return None


def test_quota_defaults():
    # MONETIZATION.md §0 placeholders by default. No per-interview or daily-interview quota:
    # the daily GLOBAL chat-turn allowance is the only gate.
    assert _quota("free", "chat_turns") == 10
    assert _quota("premium", "chat_turns") == 250
    assert _quota("dev", "chat_turns") == 500


async def test_resolve_tier_dev_fallback_when_no_clerk(monkeypatch):
    # CLERK_ENABLED=false => the dev-fallback identity (DEV_USER) => dev tier, no DB read.
    monkeypatch.setattr(billing, "CLERK_ENABLED", False)
    monkeypatch.setattr(billing, "fetchrow", _async_none)
    assert await resolve_tier(_User("dev-session", "free")) == "dev"


async def test_resolve_tier_premium_subscription_elevates(monkeypatch):
    async def _fake(_, _sub):
        return {"plan": "premium"}  # returned by fetchrow -> found

    monkeypatch.setattr(billing, "CLERK_ENABLED", True)
    monkeypatch.setattr(billing, "fetchrow", _fake)
    assert await resolve_tier(_User("elevated-user", "free")) == "premium"


async def test_resolve_tier_free_when_no_subscription(monkeypatch):
    monkeypatch.setattr(billing, "CLERK_ENABLED", True)
    monkeypatch.setattr(billing, "fetchrow", _async_none)
    assert await resolve_tier(_User("plain-user", "free")) == "free"


# --- GLOBAL daily chat-turn accounting (turn_usage per owner per UTC day) ---


async def test_chat_turns_used_defaults_zero_when_no_row(monkeypatch):
    monkeypatch.setattr(billing, "fetchrow", _async_none)
    assert await billing.chat_turns_used("some-owner") == 0


async def test_chat_turn_remaining_uses_global_counter(monkeypatch):
    # Used 7 across all interviews today -> free(10) has 3 left; premium(250) has 243.
    async def _fake(q, owner, day):
        return {"turns": 7}

    monkeypatch.setattr(billing, "fetchrow", _fake)
    assert await billing.chat_turn_remaining("free", "o") == 3
    assert await billing.chat_turn_remaining("premium", "o") == 243
    assert await billing.chat_turn_remaining("dev", "o") == 493


async def test_chat_turn_remaining_floor_at_zero(monkeypatch):
    async def _fake(q, owner, day):
        return {"turns": 30}

    monkeypatch.setattr(billing, "fetchrow", _fake)
    assert await billing.chat_turn_remaining("free", "o") == 0


async def test_bump_upserts_global_row(monkeypatch):
    calls = []

    async def _fake(q, *a, **k):
        calls.append((q, a))
        return {"id": "r"}

    monkeypatch.setattr(billing, "fetchrow", _fake)
    await billing.bump_chat_turn("owner-1")
    assert calls and "turn_usage" in calls[0][0]
    # owner_id + the current UTC day are passed, and the row is keyed by owner+day.
    assert calls[0][1][0] == "owner-1"


def test_utc_day_is_date_object():
    # Reset bucket is the current UTC calendar day as a bound-able `date` for asyncpg.
    from datetime import date

    assert isinstance(billing._utc_day(), date)


async def test_resolve_tier_jwt_premium_wins(monkeypatch):
    # A JWT that already says premium is honored without DB lookups.
    monkeypatch.setattr(billing, "CLERK_ENABLED", True)
    monkeypatch.setattr(billing, "fetchrow", _async_none)
    assert await resolve_tier(_User("p-user", "premium")) == "premium"


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


async def test_webhook_subscription_created_upserts_datetime_period(monkeypatch):
    """customer.subscription.created/updated passes a tz-aware datetime (not Stripe's
    raw epoch int) so asyncpg accepts it for the timestamptz column.
    Regression: _period_end returned the int seconds -> asyncpg DataError 500 on the
    subscription events that actually set the tier."""
    from datetime import UTC, datetime

    from app import payments

    calls = []

    async def fake_fetchrow(q, *a, **k):
        calls.append((q, a))
        # owner lookup for the customer returns no prior row -> fall back to metadata.
        if "SELECT owner_id FROM subscriptions" in q:
            return None
        return {"id": "row"}

    monkeypatch.setattr("app.db.fetchrow", fake_fetchrow)
    event = {
        "type": "customer.subscription.created",
        "data": {
            "object": {
                "id": "sub_123",
                "customer": "cus_123",
                "status": "active",
                "current_period_end": 1788678469,  # Stripe epoch seconds (int)
                "metadata": {"owner_id": "paying-user"},
            }
        },
    }
    await payments.handle_webhook_event(event)
    assert calls, "expected an upsert call"
    upsert = next((a for q, a in calls if "INSERT INTO subscriptions" in q), None)
    assert upsert is not None
    # args: owner_id, stripe_id, status, period_end
    assert upsert[0] == "paying-user"
    assert upsert[1] == "cus_123"
    assert upsert[2] == "active"
    assert isinstance(upsert[3], datetime)  # NOT the int that crashed asyncpg
    assert upsert[3].year == datetime.fromtimestamp(1788678469, tz=UTC).year
    assert upsert[3].tzinfo is not None


async def test_webhook_subscription_deleted_downgrades(monkeypatch):
    """customer.subscription.deleted drops premium (owner set free)."""
    from app import payments

    calls = []

    async def fake_fetchrow(q, *a, **k):
        calls.append((q, a))
        # The owner-lookup query returns the row for the customer.
        if "SELECT owner_id FROM subscriptions" in q:
            return {"owner_id": "cancelling-user"}
        return {"id": "row"}

    monkeypatch.setattr("app.db.fetchrow", fake_fetchrow)
    event = {
        "type": "customer.subscription.deleted",
        "data": {
            "object": {
                "id": "sub_123",
                "customer": "cus_999",
            }
        },
    }
    await payments.handle_webhook_event(event)
    assert calls, "expected a downgrade call"
    q, args = calls[-1]  # the downgrade UPDATE follows the owner lookup
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
