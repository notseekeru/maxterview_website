"""M10 billing/quota unit tests.

Pure-logic tests; DB-backed paths are monkeypatched so this file needs no live pool.
The live daily-interview / chat-turn cap behavior is exercised by the HTTP integration
tests (`test_api.py`), which create real interviews through the `client` fixture.
"""

import hashlib
import hmac
import time
from datetime import UTC, date, datetime

import pytest

from app import billing, payments
from app.billing import _quota, resolve_tier


class _User:
    def __init__(self, sub="user_x", tier="free"):
        self.sub = sub
        self.tier = tier


async def _async_none(*_args, **_kwargs):
    return None


def test_quota_defaults():
    assert _quota("free", "chat_turns") == 10
    assert _quota("premium", "chat_turns") == 250
    assert _quota("dev", "chat_turns") == 500


async def test_resolve_tier_dev_fallback_when_no_clerk(monkeypatch):
    monkeypatch.setattr(billing, "CLERK_ENABLED", False)
    monkeypatch.setattr(billing, "fetchrow", _async_none)
    assert await resolve_tier(_User("dev-session", "free")) == "dev"


async def test_resolve_tier_premium_subscription_elevates(monkeypatch):
    async def _fake(_, _sub, _statuses):
        return {"plan": "premium"}

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
    assert calls[0][1][0] == "owner-1"  # owner_id bound; row keyed by owner+day


def test_utc_day_is_date_object():
    from datetime import date

    assert isinstance(billing._utc_day(), date)


async def test_resolve_tier_jwt_premium_wins(monkeypatch):
    monkeypatch.setattr(billing, "CLERK_ENABLED", True)
    monkeypatch.setattr(billing, "fetchrow", _async_none)
    assert await resolve_tier(_User("p-user", "premium")) == "premium"


def test_invalid_quota_key_raises_500():
    with pytest.raises(Exception) as exc:
        _quota("free", "nonexistent")
    assert exc.type.__name__ == "HTTPException"
    assert exc.value.status_code == 500


# --- PayMongo webhook -> subscriptions upsert (M10) ---
#
# PayMongo has shipped two envelope shapes (see payments._envelope); both are exercised below so a
# silent provider-side change is caught by tests instead of by a missing entitlement.


def _subscription_event(etype: str, *, status: str = "active", attrs: dict | None = None, legacy: bool = False) -> dict:
    resource = {
        "id": "subs_123",
        "type": "subscription",
        "attributes": {
            "id": "subs_123",
            "customer_id": "cus_123",
            "plan_id": "plan_123",
            "status": status,
            "next_billing_schedule": "2026-10-14",
            **(attrs or {}),
        },
    }
    body = {"type": etype, "livemode": False, "data": resource}
    return {"data": {"attributes": body} if legacy else body}


def _invoice_event(etype: str, *, status: str = "paid") -> dict:
    return {
        "data": {
            "type": etype,
            "livemode": False,
            "data": {
                "id": "inv_123",
                "type": "invoice",
                "attributes": {
                    "id": "inv_123",
                    "amount": 49900,
                    "currency": "PHP",
                    "resource_id": "subs_123",
                    "status": status,
                    "due_date": "2026-09-14",
                },
            },
        }
    }


def _capture(monkeypatch, *, owner: str | None = "paying-user"):
    """Patch payments' DB access (the module binds `fetchrow` at import, so patch it there)."""
    calls: list[tuple[str, tuple]] = []

    async def fake_fetchrow(q, *a, **k):
        calls.append((q, a))
        if "SELECT owner_id FROM subscriptions" in q:
            return {"owner_id": owner} if owner else None
        return {"id": "row"}

    monkeypatch.setattr(payments, "fetchrow", fake_fetchrow)
    return calls


async def test_subscription_activated_upserts_premium_row(monkeypatch):
    """Recurring entitlement: subscription.activated upserts premium+active and a tz-aware period."""
    calls = _capture(monkeypatch)
    await payments.handle_webhook_event(_subscription_event("subscription.activated"))

    upsert = next(a for q, a in calls if "INSERT INTO subscriptions" in q)
    owner_id, provider, customer_id, subs_id, plan_id, plan, status_str, period_end = upsert
    assert (owner_id, provider, customer_id, subs_id, plan_id) == ("paying-user", "paymongo", "cus_123", "subs_123", "plan_123")
    assert (plan, status_str) == ("premium", "active")
    assert isinstance(period_end, datetime) and period_end.tzinfo is not None
    assert (period_end.year, period_end.month, period_end.day) == (2026, 10, 14)


async def test_subscription_event_legacy_envelope_still_upserts(monkeypatch):
    calls = _capture(monkeypatch)
    await payments.handle_webhook_event(_subscription_event("subscription.updated", legacy=True))
    assert any("INSERT INTO subscriptions" in q for q, _ in calls)


async def test_subscription_past_due_keeps_plan_but_loses_entitlement(monkeypatch):
    """MONETIZATION §6: a failed renewal downgrades immediately, no grace."""
    calls = _capture(monkeypatch)
    await payments.handle_webhook_event(_subscription_event("subscription.past_due", status="past_due"))
    upsert = next(a for q, a in calls if "INSERT INTO subscriptions" in q)
    assert upsert[5] == "premium"  # recoverable on a later invoice.paid
    assert upsert[6] == "past_due"  # ...but resolve_tier only honors billing.ENTITLED_STATUSES
    assert "past_due" not in billing.ENTITLED_STATUSES


async def test_subscription_cancelled_drops_to_free(monkeypatch):
    calls = _capture(monkeypatch)
    await payments.handle_webhook_event(_subscription_event("subscription.updated", status="cancelled"))
    upsert = next(a for q, a in calls if "INSERT INTO subscriptions" in q)
    assert upsert[5] == "free"


async def test_subscription_event_with_unknown_subscription_is_ignored(monkeypatch):
    """A stale/unknown subscription id must NOT fall back to the customer: out-of-order delivery is
    documented by PayMongo, and a late `cancelled` for a replaced subscription would otherwise
    overwrite the live row and downgrade a paying customer."""
    calls = _capture(monkeypatch, owner=None)
    await payments.handle_webhook_event(_subscription_event("subscription.activated"))
    assert not any("INSERT INTO subscriptions" in q for q, _ in calls)
    assert not any("provider_customer_id" in q for q, _ in calls)


# --- duplicate-subscription guard (a second POST /v1/subscriptions is a second charge) ---


def _row(**kw) -> dict:
    return {
        "plan": "premium",
        "status": "active",
        "current_period_end": datetime(2026, 10, 14, tzinfo=UTC),
        "updated_at": datetime(2026, 9, 12, tzinfo=UTC),
        **kw,
    }


NOW = datetime(2026, 9, 12, 12, tzinfo=UTC)


def test_resubscribe_allowed_when_nothing_is_stored():
    assert payments._resubscribe_block(None, NOW) == ""


def test_resubscribe_blocked_inside_a_paid_period():
    # Day 10 of 30: still paying for this period, whatever the status is.
    for status in ("active", "past_due", "unpaid", "cancelled"):
        assert payments._resubscribe_block(_row(status=status), NOW) != "", status


def test_resubscribe_allowed_once_the_period_lapsed():
    lapsed = _row(status="cancelled", current_period_end=datetime(2026, 9, 1, tzinfo=UTC))
    assert payments._resubscribe_block(lapsed, NOW) == ""
    # A lapsed row that was already downgraded to free is clear too.
    assert payments._resubscribe_block(_row(plan="free", status="cancelled", current_period_end=None), NOW) == ""


def test_resubscribe_blocked_while_the_first_payment_is_pending():
    # `incomplete` inside PayMongo's 24h window: the Maya link issued earlier is still live.
    pending = _row(plan="premium", status="incomplete", current_period_end=None, updated_at=NOW)
    assert payments._resubscribe_block(pending, NOW) != ""
    # Past 24h PayMongo has self-cancelled it, so a fresh subscription is the correct retry.
    stale = _row(plan="premium", status="incomplete", current_period_end=None, updated_at=datetime(2026, 9, 11, 6, tzinfo=UTC))
    assert payments._resubscribe_block(stale, NOW) == ""


async def test_invoice_paid_recovers_subscription_via_subscription_id(monkeypatch):
    """Invoice events carry only resource_id (the subscription), not the customer."""
    calls = _capture(monkeypatch)
    await payments.handle_webhook_event(_invoice_event("subscription.invoice.paid"))
    lookup, args = calls[0]
    assert "provider_subscription_id" in lookup and args[0] == "subs_123"
    update = calls[-1]
    assert "status = 'active'" in update[0] and update[1][0] == "paying-user"
    # Guarded recovery: a cancelled or 24h-expired subscription must NOT be resurrected by a late
    # invoice payment (PayMongo keeps open invoices collectible after a cancel).
    assert "status IN ('past_due', 'unpaid', 'incomplete')" in update[0]


async def test_ensure_customer_reuses_only_this_providers_id(monkeypatch):
    """0008 renamed Stripe's `stripe_id` into `provider_customer_id`, so a pre-swap row still holds a
    Stripe `cus_…`; reusing it would send PayMongo a customer it never issued."""
    from app.models import ClerkUser

    user = ClerkUser(sub="u1", email="a@b.co", name="A B")
    seen = {}

    async def _api(method, path, **kwargs):
        seen["path"] = path
        return {"data": {"id": "cus_new"}}

    monkeypatch.setattr(payments, "_api", _api)

    async def _stale(_q, _sub):
        return {"provider": "stripe", "provider_customer_id": "cus_from_stripe"}

    monkeypatch.setattr(payments, "fetchrow", _stale)
    assert await payments._ensure_customer(user) == "cus_new"
    assert seen["path"] == "/v1/customers"

    async def _mine(_q, _sub):
        return {"provider": "paymongo", "provider_customer_id": "cus_pm"}

    monkeypatch.setattr(payments, "fetchrow", _mine)
    assert await payments._ensure_customer(user) == "cus_pm"


async def test_invoice_payment_failed_marks_past_due(monkeypatch):
    calls = _capture(monkeypatch)
    await payments.handle_webhook_event(_invoice_event("subscription.invoice.payment_failed", status="open"))
    assert "status = 'past_due'" in calls[-1][0]


async def test_invoice_draft_churn_writes_nothing(monkeypatch):
    """created/finalized/updated are draft->open noise: no entitlement change, no DB write."""
    calls = _capture(monkeypatch)
    for etype in ("subscription.invoice.created", "subscription.invoice.finalized", "subscription.invoice.updated"):
        await payments.handle_webhook_event(_invoice_event(etype, status="draft"))
    assert [q for q, _ in calls if "UPDATE subscriptions" in q] == []


async def test_unknown_event_type_is_ignored(monkeypatch):
    calls = _capture(monkeypatch)
    await payments.handle_webhook_event({"data": {"type": "payment.paid", "livemode": False, "data": {"id": "pay_1", "type": "payment", "attributes": {}}}})
    assert calls == []


# --- Paymongo-Signature (HMAC-SHA256 of "{t}.{raw_body}") ---

SECRET = "whsec_test"


def _sign(body: bytes, *, stamp: int | None = None, key: str = "te", secret: str = SECRET) -> str:
    t = stamp if stamp is not None else int(time.time())
    mac = hmac.new(secret.encode(), f"{t}.".encode() + body, hashlib.sha256).hexdigest()
    return f"t={t},{key}={mac}"


def test_signature_accepts_test_and_live_slots(monkeypatch):
    monkeypatch.setattr(payments, "WEBHOOK_SECRET", SECRET)
    body = b'{"data":{"type":"subscription.activated"}}'
    assert payments.verify_signature(body, _sign(body, key="te"))
    assert payments.verify_signature(body, _sign(body, key="li"))


def test_signature_rejects_tampering_stale_replay_and_wrong_secret(monkeypatch):
    monkeypatch.setattr(payments, "WEBHOOK_SECRET", SECRET)
    body = b'{"data":{"type":"subscription.activated"}}'
    assert not payments.verify_signature(body + b" ", _sign(body))  # body changed after signing
    assert not payments.verify_signature(body, _sign(body, secret="whsec_other"))  # wrong key
    stale = int(time.time()) - (payments.SIGNATURE_TOLERANCE_S + 60)
    assert not payments.verify_signature(body, _sign(body, stamp=stale))  # replay
    assert not payments.verify_signature(body, "")  # header absent
    assert not payments.verify_signature(body, "t=123,te=")  # no signature slot


def test_signature_fails_closed_without_server_secret(monkeypatch):
    monkeypatch.setattr(payments, "WEBHOOK_SECRET", "")
    body = b"{}"
    assert not payments.verify_signature(body, _sign(body))


def test_period_end_tolerates_provider_date_shapes():
    p = payments
    assert p._period_end("2026-10-14") == datetime(2026, 10, 14, tzinfo=UTC)
    assert p._period_end(date(2026, 10, 14)) == datetime(2026, 10, 14, tzinfo=UTC)
    assert p._period_end(1788678469).year == datetime.fromtimestamp(1788678469, tz=UTC).year
    assert p._period_end("") is None and p._period_end("not-a-date") is None
