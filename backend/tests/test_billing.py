"""M10 billing/quota unit tests.

Pure-logic tests; DB-backed paths are monkeypatched so this file needs no live pool.
The live daily-interview / chat-turn cap behavior is exercised by the HTTP integration
tests (`test_api.py`), which create real interviews through the `client` fixture.
"""

import hashlib
import hmac
import time
from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi import HTTPException

from app import billing, payments
from app.billing import _quota, resolve_tier
from app.models import ClerkUser


class _User:
    def __init__(self, sub="user_x", tier="free"):
        self.sub = sub
        self.tier = tier


async def _async_none(*_args, **_kwargs):
    return None


def test_quota_defaults():
    assert _quota("free", "chat_turns") == 30
    assert _quota("premium", "chat_turns") == 100
    assert _quota("dev", "chat_turns") == 500


def test_byok_ceiling_swaps_the_tier_cap_in():
    # BYOK (tier=None) is never uncapped: the tier's dial is replaced, not removed. It must stay
    # ABOVE premium's, or bringing a key would read as a downgrade.
    assert billing.chat_turn_limit(None) == billing.BYOK_CHAT_TURNS
    assert billing.chat_turn_limit("free") == billing.FREE_CHAT_TURNS
    assert billing.BYOK_CHAT_TURNS > billing.PREMIUM_CHAT_TURNS


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
    # Used 7 across all interviews today -> free(30) has 23 left; premium(100) has 93.
    async def _fake(q, owner, day):
        return {"turns": 7}

    monkeypatch.setattr(billing, "fetchrow", _fake)
    assert await billing.chat_turn_remaining("free", "o") == 23
    assert await billing.chat_turn_remaining("premium", "o") == 93
    assert await billing.chat_turn_remaining("dev", "o") == 493
    assert await billing.chat_turn_remaining(None, "o") == billing.BYOK_CHAT_TURNS - 7  # BYOK ceiling


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
                    "amount": 9900,
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
    """MONETIZATION §5: a failed renewal downgrades immediately, no grace."""
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


async def test_pending_qr_resumes_instead_of_refusing(monkeypatch):
    """The row holds the one live intent, so a second Upgrade press must hand back the SAME QR: closing
    the popup (or reloading) used to strand the buyer behind a 409 until the code died.

    `_period_configure` matters here: without a key on the box this 503s at the config guard before it
    ever reaches the resume path (CI caught exactly that).
    """
    _period_configure(monkeypatch)
    qr = {"qr": {"image_url": "data:image/png;base64,AAAA", "expires_at": (datetime.now(UTC) + timedelta(minutes=20)).isoformat()}}
    calls: list[str] = []

    async def fake_fetchrow(_q, *_a, **_k):
        return _row(owner_id="u", status="incomplete", current_period_end=None, provider_subscription_id="pi_x")

    async def _api(method, path, **_kw):
        calls.append(f"{method} {path}")
        attributes = {"status": "awaiting_next_action", "next_action": {"type": "consume_qr", "code": qr["qr"]}}
        return {"data": {"attributes": attributes}}

    monkeypatch.setattr(payments, "fetchrow", fake_fetchrow)
    monkeypatch.setattr(payments, "_api", _api)
    user = ClerkUser(sub="u", email="a@b.co", name="A B")
    assert await payments.start_period_purchase(user) == qr
    # Exactly one READ: no customer, no payment method, no new intent, so no second charge.
    assert calls == ["GET /v1/payment_intents/pi_x"]


async def test_pending_qr_is_judged_by_its_own_deadline(monkeypatch):
    """A QR Ph code dies 30 min after it is drawn, so the subscription rule (24h) would outlive the
    thing it waits on and lock an abandoner out for a day."""
    row = _row(owner_id="u", status="incomplete", current_period_end=None, provider_subscription_id="pi_x")

    async def _intent(status, expires_at=None, code=None):
        async def _api(_method, _path, **_kw):
            return {"data": {"attributes": {"status": status, "next_action": {"code": {"expires_at": expires_at, **(code or {})}}}}}

        monkeypatch.setattr(payments, "_api", _api)

    await _intent("awaiting_next_action", (datetime.now(UTC) + timedelta(minutes=12)).isoformat())
    assert "min left" in (await payments._resume_or_block(row))[1]  # no artifact -> nothing to re-show

    await _intent("awaiting_next_action", (datetime.now(UTC) - timedelta(minutes=1)).isoformat())
    assert (await payments._resume_or_block(row)) == ({}, "")  # unscannable -> the retry is not held

    await _intent("processing", (datetime.now(UTC) + timedelta(minutes=10)).isoformat())
    assert "processed" in (await payments._resume_or_block(row))[1]  # mid-payment: no second scan

    # PayMongo leaves an abandoned intent `awaiting_next_action` forever (measured on an 11-day-old
    # one), so a status-only gate would lock the owner out permanently: the fallback ceiling is what
    # frees a row whose intent reports no deadline of its own.
    await _intent("awaiting_next_action", None)
    fresh = _row(owner_id="u", status="incomplete", provider_subscription_id="pi_x", updated_at=datetime.now(UTC))
    assert "min left" in (await payments._resume_or_block(fresh))[1]
    stale = _row(owner_id="u", status="incomplete", provider_subscription_id="pi_x", updated_at=datetime.now(UTC) - timedelta(hours=2))
    assert (await payments._resume_or_block(stale)) == ({}, "")

    credited: list[tuple] = []

    async def fake_fetchrow(_q, *args, **_kw):
        credited.append(args)
        return {"id": "row"}

    monkeypatch.setattr(payments, "fetchrow", fake_fetchrow)
    await _intent("succeeded")  # paid, webhook never arrived: credit it, do not sell a second period
    assert "already received" in (await payments._resume_or_block(row))[1]
    assert credited


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
    user = ClerkUser(sub="u1", email="a@b.co", name="A B")
    seen = {}

    async def _api(method, path, **kwargs):
        seen["path"] = path
        return {"data": {"id": "cus_new"}}

    monkeypatch.setattr(payments, "_api", _api)

    async def _stale(_q, _sub):
        return {"provider": "stripe", "provider_customer_id": "cus_from_stripe"}

    monkeypatch.setattr(payments, "fetchrow", _stale)
    assert await payments._ensure_customer(user, "a@b.co") == "cus_new"
    assert seen["path"] == "/v1/customers"

    async def _mine(_q, _sub):
        return {"provider": "paymongo", "provider_customer_id": "cus_pm"}

    monkeypatch.setattr(payments, "fetchrow", _mine)
    assert await payments._ensure_customer(user, "a@b.co") == "cus_pm"


async def test_customer_conflict_reuses_the_one_paymongo_already_holds(monkeypatch):
    """The row is the only place the customer id lives, so a lost row turns the next checkout into
    PayMongo's 422 "A customer with this email already exists". Re-raising would wedge that address
    on checkout for good; the email is the key PayMongo holds, so reuse it."""
    calls = []

    async def fake_fetchrow(_q, *_a, **_k):
        return None  # row gone: nothing to reuse

    async def _api(method, path, **kwargs):
        calls.append((method, path, kwargs.get("params")))
        if method == "POST":
            raise HTTPException(status_code=502, detail="Payment provider error")
        return {"data": [{"id": "cus_old", "attributes": {"email": "payer@example.com"}}]}

    monkeypatch.setattr(payments, "fetchrow", fake_fetchrow)
    monkeypatch.setattr(payments, "_api", _api)
    user = ClerkUser(sub="u1", email="payer@example.com", name="A B")
    assert await payments._ensure_customer(user, "payer@example.com") == "cus_old"
    assert calls[1] == ("GET", "/v1/customers", {"email": "payer@example.com", "limit": 100})

    # A lookup that finds nothing must not invent an id: the original failure stands.
    async def _empty(method, _p, **_k):
        if method == "POST":
            raise HTTPException(status_code=502, detail="Payment provider error")
        return {"data": []}

    monkeypatch.setattr(payments, "_api", _empty)
    with pytest.raises(HTTPException):
        await payments._ensure_customer(user, "payer@example.com")


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
    await payments.handle_webhook_event({"data": {"type": "payout.deposited", "livemode": False, "data": {"id": "po_1", "type": "payout", "attributes": {}}}})
    assert calls == []


# --- period mode: one paid Payment Intent buys PREMIUM_PERIOD_DAYS of premium ---


def _payment_event(*, etype: str = "payment.paid", intent_id: str = "pi_1") -> dict:
    """`payment.paid` carries the intent it charged; a `payment_intent` event IS the intent."""
    if etype.startswith("payment_intent"):
        resource = {"id": intent_id, "type": "payment_intent", "attributes": {"id": intent_id, "amount": 9900, "status": "succeeded"}}
    else:
        resource = {
            "id": "pay_1",
            "type": "payment",
            "attributes": {"id": "pay_1", "amount": 9900, "status": "paid", "payment_intent_id": intent_id},
        }
    return {"data": {"type": etype, "livemode": False, "data": resource}}


async def test_payment_paid_credits_the_pending_row(monkeypatch):
    """Money in -> `active` + one period. Same row and same reader as a subscription."""
    calls = _capture(monkeypatch)
    before = datetime.now(UTC)
    await payments.handle_webhook_event(_payment_event())

    update, args = next((q, a) for q, a in calls if "UPDATE subscriptions" in q)
    owner, intent_id, period_end = args
    assert (owner, intent_id) == ("paying-user", "pi_1")
    assert "plan = 'premium'" in update and "status = 'active'" in update
    # The compare-and-set is what makes two registered event types + provider retries safe.
    assert "provider_subscription_id = $2 AND status = 'incomplete'" in update
    days = (period_end - before).total_seconds() / 86400
    assert payments.PREMIUM_PERIOD_DAYS <= days < payments.PREMIUM_PERIOD_DAYS + 0.01


async def test_payment_intent_succeeded_credits_too(monkeypatch):
    """The sibling event must credit as well: either type may be the only one a method emits."""
    calls = _capture(monkeypatch)
    await payments.handle_webhook_event(_payment_event(etype="payment_intent.succeeded", intent_id="pi_2"))
    _, args = next((q, a) for q, a in calls if "UPDATE subscriptions" in q)
    assert args[1] == "pi_2"


async def test_a_second_delivery_matches_nothing_and_grants_no_extra_time(monkeypatch):
    """Both event types are registered, so every payment CAN arrive twice: the guard is the write.

    Once the row is `active` the compare-and-set matches no row, so a replay cannot buy a period.
    """
    attempted: list[tuple] = []

    async def fake_fetchrow(q, *a, **k):
        if "SELECT owner_id FROM subscriptions" in q:
            return {"owner_id": "paying-user"}
        if "UPDATE subscriptions" in q:
            attempted.append(a)
            return None  # already credited
        return {"id": "row"}

    monkeypatch.setattr(payments, "fetchrow", fake_fetchrow)
    await payments.handle_webhook_event(_payment_event())
    await payments.handle_webhook_event(_payment_event(etype="payment_intent.succeeded"))
    assert [a[1] for a in attempted] == ["pi_1", "pi_1"]  # both tried, neither wrote


async def test_payment_events_that_cannot_credit_write_nothing(monkeypatch):
    """Three ways to be a no-op: not a paid event, no intent id, and an intent we never issued."""
    calls = _capture(monkeypatch, owner=None)
    await payments.handle_webhook_event(_payment_event(etype="payment.failed"))
    await payments.handle_webhook_event(_payment_event(intent_id="pi_from_another_key"))
    no_reference = {"data": {"type": "payment.paid", "livemode": False, "data": {"id": "pay_9", "type": "payment", "attributes": {"status": "paid"}}}}
    await payments.handle_webhook_event(no_reference)
    assert not any("UPDATE subscriptions" in q for q, _ in calls)


# --- a refunded payment loses premium now (MONETIZATION §5) ---
#
# `payment.refunded` / `payment.refund.updated` are the only refund events this account will register
# (measured 2026-09-27: `refund.succeeded` is `invalid event type`, `GET /v1/disputes` is
# `access_denied`, and `POST /v1/refunds` refuses a QR Ph payment outright, so a dashboard refund is
# the only refund there is). PayMongo's own docs show the thin payload, so the payload shape is
# unverified and both shapes are pinned here.


def _refunded_payment_event(intent_id: str = "pi_1") -> dict:
    """`payment.refunded` embedding the payment, the shape `payment.paid` already arrives in."""
    resource = {"id": "pay_1", "type": "payment", "attributes": {"id": "pay_1", "status": "refunded", "payment_intent_id": intent_id}}
    return {"data": {"type": "payment.refunded", "livemode": False, "data": resource}}


def _refund_resource_event(etype: str = "payment.refunded", **attrs) -> dict:
    resource = {"id": "ref_1", "type": "refund", "attributes": {"id": "ref_1", **attrs}}
    return {"data": {"type": etype, "livemode": False, "data": resource}}


async def test_payment_refunded_revokes_the_paid_period(monkeypatch):
    calls = _capture(monkeypatch)
    await payments.handle_webhook_event(_refunded_payment_event())

    update, args = next((q, a) for q, a in calls if "UPDATE subscriptions" in q)
    assert args == ("paying-user", "refunded")
    assert "plan = 'free'" in update
    assert "refunded" not in billing.ENTITLED_STATUSES  # what makes the read downgrade


async def test_thin_refund_event_resolves_through_the_provider(monkeypatch):
    """The refund may name only itself, so the chain is refund -> payment -> intent (the only id the
    `subscriptions` row holds)."""
    calls = _capture(monkeypatch)
    seen: list[str] = []

    async def _api(_method, path, **_kw):
        seen.append(path)
        if path.startswith("/v1/refunds/"):
            return {"data": {"attributes": {"status": "succeeded", "payment_id": "pay_1"}}}
        return {"data": {"attributes": {"payment_intent_id": "pi_1"}}}

    monkeypatch.setattr(payments, "_api", _api)
    await payments.handle_webhook_event(_refund_resource_event())
    assert seen == ["/v1/refunds/ref_1", "/v1/payments/pay_1"]
    assert any("UPDATE subscriptions" in q for q, _ in calls)
    # The docs' newer name for the same settled refund (unregistrable here today) must revoke too:
    # dispatch keys on the refund RESOURCE, not only on the two names this account accepts.
    await payments.handle_webhook_event(_refund_resource_event("refund.succeeded", status="succeeded", payment_id="pay_1"))
    assert seen[-1] == "/v1/payments/pay_1"


async def test_unsettled_refund_writes_nothing(monkeypatch):
    """`updated` is status churn and PayMongo HOLDS a refund while the balance is short: revoking on
    either takes the period from someone whose money we still have."""
    calls = _capture(monkeypatch)

    async def _api(_method, _path, **_kw):
        return {"data": {"attributes": {"status": "pending"}}}

    monkeypatch.setattr(payments, "_api", _api)
    await payments.handle_webhook_event(_refund_resource_event("payment.refund.updated", status="pending"))
    await payments.handle_webhook_event(_refund_resource_event("payment.refund.updated"))  # read back: pending
    # A payment resource's own `status` is `paid`/`refunded`, never the refund's state.
    await payments.handle_webhook_event({"data": {"type": "payment.refund.updated", "livemode": False, "data": {"id": "pay_1", "type": "payment", "attributes": {"status": "paid", "payment_intent_id": "pi_1"}}}})
    assert not any("UPDATE subscriptions" in q for q, _ in calls)


async def test_unattributable_refund_writes_nothing(monkeypatch):
    """Settled, but no id that reaches an owner: logged, never guessed — a refund applied to the
    wrong owner downgrades a paying customer."""
    calls = _capture(monkeypatch, owner=None)

    async def _api(_method, _path, **_kw):
        return {"data": {"attributes": {"status": "succeeded"}}}

    monkeypatch.setattr(payments, "_api", _api)
    await payments.handle_webhook_event(_refund_resource_event(status="succeeded"))
    await payments.handle_webhook_event(_refund_resource_event(status="succeeded", payment_id="pay_unknown"))
    assert not any("UPDATE subscriptions" in q for q, _ in calls)


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


# --- documented-but-unexercised PayMongo shapes (see payments._try_variants) ---


def _configure(monkeypatch):
    monkeypatch.setattr(payments, "SECRET_KEY", "sk_test_x")
    monkeypatch.setattr(payments, "PLAN_ID", "plan_x")


async def test_try_variants_returns_the_first_accepted_variant():
    calls = []

    async def attempt(variant):
        calls.append(variant)
        return {"ok": variant}

    assert await payments._try_variants(["a", "b"], attempt) == {"ok": "a"}
    assert calls == ["a"]  # no speculative second call


async def test_try_variants_falls_back_then_reraises_the_last_failure():
    async def second_works(variant):
        if variant == "a":
            raise HTTPException(status_code=502, detail="no")
        return {"ok": variant}

    assert await payments._try_variants(["a", "b"], second_works) == {"ok": "b"}

    async def never(_variant):
        raise HTTPException(status_code=502, detail="no")

    with pytest.raises(HTTPException):
        await payments._try_variants(["a", "b"], never)


async def test_first_invoice_intent_falls_back_to_the_unversioned_path(monkeypatch):
    """The docs list the invoice collection both with and without `/v1`."""
    seen = []

    async def _api(method, path, **kwargs):
        seen.append(path)
        if path.startswith("/v1"):
            raise HTTPException(status_code=502, detail="404")
        return {"data": [{"attributes": {"payment_intent": {"id": "pi_1"}}}]}

    monkeypatch.setattr(payments, "_api", _api)
    assert await payments._first_invoice_intent("subs_1") == "pi_1"
    assert seen == ["/v1/subscriptions/invoices", "/subscriptions/invoices"]


async def test_first_invoice_intent_without_an_intent_is_a_502(monkeypatch):
    async def _api(*_a, **_k):
        return {"data": []}

    monkeypatch.setattr(payments, "_api", _api)
    with pytest.raises(HTTPException) as exc:
        await payments._first_invoice_intent("subs_1")
    assert exc.value.status_code == 502


async def test_start_subscription_needs_an_email_and_a_free_slot(monkeypatch):
    _configure(monkeypatch)
    with pytest.raises(HTTPException) as no_email:
        await payments.start_subscription(ClerkUser(sub="u", email=None, name="A"))
    assert no_email.value.status_code == 409

    async def _covered(_q, _sub):
        return _row(current_period_end=datetime(2027, 1, 1, tzinfo=UTC))

    monkeypatch.setattr(payments, "fetchrow", _covered)
    with pytest.raises(HTTPException) as covered:
        await payments.start_subscription(ClerkUser(sub="u", email="a@b.co", name="A B"))
    assert covered.value.status_code == 409


async def test_start_subscription_refuses_without_config(monkeypatch):
    monkeypatch.setattr(payments, "SECRET_KEY", "")
    monkeypatch.setattr(payments, "PLAN_ID", "")
    with pytest.raises(HTTPException) as exc:
        await payments.start_subscription(ClerkUser(sub="u", email="a@b.co"))
    assert exc.value.status_code == 503


# --- period-mode purchase (the launch mode: no account capability required) ---


def _period_configure(monkeypatch):
    monkeypatch.setattr(payments, "SECRET_KEY", "sk_test_x")
    monkeypatch.setattr(payments, "BILLING_MODE", "period")


def _buyer() -> ClerkUser:
    return ClerkUser(sub="u", email="a@b.co", name="A B")


async def test_period_mode_needs_a_secret_key_but_no_plan_id(monkeypatch):
    """`PAYMONGO_PLAN_ID` is unset on this account and must not gate the launch mode."""
    monkeypatch.setattr(payments, "SECRET_KEY", "sk_test_x")
    monkeypatch.setattr(payments, "PLAN_ID", "")
    payments._require_period_config()  # no raise: the price lives in PREMIUM_PRICE_CENTAVOS
    with pytest.raises(HTTPException):
        payments._require_config()

    monkeypatch.setattr(payments, "SECRET_KEY", "")
    with pytest.raises(HTTPException) as exc:
        await payments.start_period_purchase(_buyer())
    assert exc.value.status_code == 503


async def test_start_upgrade_dispatches_on_mode(monkeypatch):
    seen: list[str] = []

    async def _sub(_user):
        seen.append("subscription")
        return "url"

    async def _period(_user):
        seen.append("period")
        return "url"

    monkeypatch.setattr(payments, "start_subscription", _sub)
    monkeypatch.setattr(payments, "start_period_purchase", _period)
    monkeypatch.setattr(payments, "BILLING_MODE", "period")
    await payments.start_upgrade(_buyer())
    monkeypatch.setattr(payments, "BILLING_MODE", "subscription")
    await payments.start_upgrade(_buyer())
    assert seen == ["period", "subscription"]


async def test_start_period_purchase_records_the_intent_once_a_link_exists(monkeypatch):
    """The row must exist before the browser can show the QR (the webhook resolves the owner from it)
    but only once the provider produced a PAYABLE artifact: live mode refuses whole method types, and
    a row for an unpayable intent blocks the owner's retry."""
    _period_configure(monkeypatch)
    order: list[tuple] = []

    async def fake_fetchrow(q, *a, **k):
        if "INSERT INTO subscriptions" in q or "UPDATE subscriptions" in q:
            order.append(("db", q, a))
            return {"id": "row"}
        return None  # no stored row, no stored customer

    async def _api(method, path, **kwargs):
        order.append(("api", method, path))
        if path == "/v1/customers":
            return {"data": {"id": "cus_1"}}
        if path == "/v1/payment_intents":
            attrs = kwargs["json"]["data"]["attributes"]
            assert (attrs["amount"], attrs["currency"], attrs["capture_type"]) == (payments.PREMIUM_PRICE_CENTAVOS, "PHP", "automatic")
            assert attrs["payment_method_allowed"] == list(payments.PERIOD_METHODS)
            assert attrs["metadata"] == {"owner_id": "u"}
            assert "plan" not in attrs  # a one-time payment is not a subscription
            return {"data": {"id": "pi_new"}}
        if path == "/v1/payment_methods":
            return {"data": {"id": "pm_1"}}
        if path == "/v1/payment_intents/pi_new":
            return {"data": {"attributes": {"client_key": "pi_new_client_x"}}}
        if path == "/v1/payment_intents/pi_new/attach":
            return {"data": {"attributes": {"next_action": {"redirect": {"url": "https://paymaya.test/x"}}}}}
        raise AssertionError(path)

    monkeypatch.setattr(payments, "fetchrow", fake_fetchrow)
    monkeypatch.setattr(payments, "_api", _api)
    assert await payments.start_period_purchase(_buyer()) == {"url": "https://paymaya.test/x"}

    insert = next(i for i, e in enumerate(order) if e[0] == "db" and "INSERT INTO subscriptions" in e[1])
    attach = next(i for i, e in enumerate(order) if e[0] == "api" and str(e[2]).endswith("/attach"))
    assert attach < insert, "no row until the link is payable; still written before the browser sees it"
    row_args = order[insert][2]
    assert row_args[3] == "pi_new"  # provider_subscription_id holds the intent id in period mode
    assert row_args[5:7] == ("premium", "incomplete")


async def test_checkout_uses_the_clerk_lookup_when_the_token_has_no_email(monkeypatch):
    """The session token carries no `email` claim (auth.user_email), so the Backend API lookup is
    the only source for the address PayMongo keys a customer by."""
    _period_configure(monkeypatch)
    looked_up: list[str] = []

    async def fake_user_email(user):
        looked_up.append(user.sub)
        return "payer@example.com"

    async def fake_fetchrow(_q, *_a, **_k):
        return None  # no stored row, no stored customer

    async def _api(method, path, **kwargs):
        if path == "/v1/customers":
            assert kwargs["json"]["data"]["attributes"]["email"] == "payer@example.com"
            return {"data": {"id": "cus_1"}}
        if path == "/v1/payment_intents":
            return {"data": {"id": "pi_1"}}
        if path == "/v1/payment_methods":
            return {"data": {"id": "pm_1"}}
        if path == "/v1/payment_intents/pi_1":
            return {"data": {"attributes": {"client_key": "pi_1_client"}}}
        if path == "/v1/payment_intents/pi_1/attach":
            return {"data": {"attributes": {"next_action": {"redirect": {"url": "https://paymaya.test/x"}}}}}
        raise AssertionError(path)

    monkeypatch.setattr(payments.auth, "user_email", fake_user_email)
    monkeypatch.setattr(payments, "fetchrow", fake_fetchrow)
    monkeypatch.setattr(payments, "_api", _api)
    assert await payments.start_period_purchase(ClerkUser(sub="u", email=None, name="A")) == {"url": "https://paymaya.test/x"}
    assert looked_up == ["u"]


async def test_start_period_purchase_hands_back_the_qr_the_rail_uses(monkeypatch):
    """QR Ph answers the attach with `consume_qr` and NO redirect, so a redirect-only client 502s on
    the one rail this account can take money on."""
    _period_configure(monkeypatch)

    async def fake_fetchrow(_q, *_a, **_k):
        return None  # no stored row, no stored customer

    async def _api(_method, path, **kwargs):
        if path == "/v1/customers":
            return {"data": {"id": "cus_1"}}
        if path == "/v1/payment_intents":
            return {"data": {"id": "pi_qr"}}
        if path == "/v1/payment_methods":
            assert kwargs["json"]["data"]["attributes"]["type"] == "qrph"
            return {"data": {"id": "pm_1"}}
        if path == "/v1/payment_intents/pi_qr":
            return {"data": {"attributes": {"client_key": "pi_qr_client"}}}
        if path == "/v1/payment_intents/pi_qr/attach":
            code = {"image_url": "data:image/png;base64,AAAA", "expires_at": "2026-09-26T04:03:57.145658523Z"}
            return {"data": {"attributes": {"next_action": {"type": "consume_qr", "code": code}}}}
        raise AssertionError(path)

    monkeypatch.setattr(payments, "fetchrow", fake_fetchrow)
    monkeypatch.setattr(payments, "_api", _api)
    payable = await payments.start_period_purchase(_buyer())
    assert payable["qr"]["image_url"].startswith("data:image/png;base64,")


async def test_start_period_purchase_needs_an_email_and_a_free_slot(monkeypatch):
    _period_configure(monkeypatch)
    with pytest.raises(HTTPException) as no_email:
        await payments.start_period_purchase(ClerkUser(sub="u", email=None, name="A"))
    assert no_email.value.status_code == 409

    async def _covered(_q, _sub):
        return _row(current_period_end=datetime(2027, 1, 1, tzinfo=UTC))

    monkeypatch.setattr(payments, "fetchrow", _covered)
    with pytest.raises(HTTPException) as covered:
        await payments.start_period_purchase(_buyer())
    assert covered.value.status_code == 409


async def test_cancel_period_keeps_the_paid_time_and_calls_no_provider(monkeypatch):
    calls: list[tuple] = []

    async def fake_fetchrow(q, *a, **k):
        calls.append((q, a))
        if "SELECT current_period_end" in q:
            return {"current_period_end": datetime(2027, 1, 1, tzinfo=UTC)}
        return {"id": "row"}

    async def _api(*_a, **_k):
        raise AssertionError("period mode has nothing scheduled provider-side to cancel")

    monkeypatch.setattr(payments, "fetchrow", fake_fetchrow)
    monkeypatch.setattr(payments, "_api", _api)
    monkeypatch.setattr(payments, "BILLING_MODE", "period")
    await payments.cancel_upgrade(_buyer())
    update = next(q for q, _ in calls if "UPDATE subscriptions" in q)
    assert "status = 'cancelled'" in update and "plan = 'premium'" in update
    assert "cancelled" in billing.ENTITLED_STATUSES  # ...so the paid time still serves


async def test_cancel_period_without_a_live_period_is_404(monkeypatch):
    async def fake_fetchrow(_q, *_a, **_k):
        return {"current_period_end": None}

    monkeypatch.setattr(payments, "fetchrow", fake_fetchrow)
    monkeypatch.setattr(payments, "BILLING_MODE", "period")
    with pytest.raises(HTTPException) as exc:
        await payments.cancel_upgrade(_buyer())
    assert exc.value.status_code == 404
