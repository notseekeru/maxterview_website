"""M10 billing provider — PayMongo (MONETIZATION.md §3).

Two rails into the SAME entitlement (a paid period on the `subscriptions` row); `BILLING_MODE` picks
one and `billing.resolve_tier` is identical for both:

- `period` (default) — one-time Payment Intent → Maya redirect → `payment.paid` extends
  `current_period_end`. Needs no account capability, so this is the mode that ships (MONETIZATION §7).
- `subscription` — provider-managed recurring; needs Subscriptions + Card Vaulting enabled by support.

Env lives in `backend/.env.example`. Without `PAYMONGO_WEBHOOK_SECRET` the webhook fails closed, so a
real deployment has no entitlement path until an endpoint is registered.

Raw httpx on purpose: seven endpoints; an SDK would only add a dependency to rotate.

Provider seam (D10): this module plus the `subscriptions.provider*` columns are the whole
provider-specific surface. `billing.resolve_tier` is provider-blind, so adding a second provider
(e.g. a merchant-of-record for global/USD) is one module plus one migration.
"""

import hashlib
import hmac
import os
import time
from datetime import UTC, date, datetime, timedelta

import httpx
import structlog
from fastapi import HTTPException, status

from app.db import fetchrow
from app.models import ClerkUser

log = structlog.get_logger(__name__)

API_BASE = "https://api.paymongo.com"
SECRET_KEY = os.getenv("PAYMONGO_SECRET_KEY", "")
WEBHOOK_SECRET = os.getenv("PAYMONGO_WEBHOOK_SECRET", "")
PLAN_ID = os.getenv("PAYMONGO_PLAN_ID", "")
FRONTEND_BASE_URL = os.getenv("FRONTEND_BASE_URL", "http://localhost:5173")
PROVIDER = "paymongo"

# `period` = one-time payment buys PREMIUM_PERIOD_DAYS; `subscription` = provider-managed recurring.
BILLING_MODE = os.getenv("BILLING_MODE", "period")
PREMIUM_PRICE_CENTAVOS = int(os.getenv("PREMIUM_PRICE_CENTAVOS", "49900"))  # ₱499
PREMIUM_PERIOD_DAYS = int(os.getenv("PREMIUM_PERIOD_DAYS", "30"))
# Maya alone works on an individual account (Cards need a registered business type); card stays
# listed for business accounts.
PERIOD_METHODS = ("paymaya", "card")

# Replay window for `Paymongo-Signature` (docs call this optional; it is cheap on a money endpoint).
# Env-overridable because a rejected fresh-or-not judgement call here means a paying customer is left
# locked out until the next retry — every rejection is logged so it is diagnosable, not silent.
SIGNATURE_TOLERANCE_S = int(os.getenv("PAYMONGO_SIGNATURE_TOLERANCE_S", "300"))

# Provider statuses that mean "no more money is coming" -> the row stops being premium. The other
# statuses stay `premium` so `past_due`/`unpaid` can recover on a later invoice.paid.
TERMINAL_STATUSES = ("cancelled", "incomplete_cancelled")

# Mirrors PayMongo's own first-payment window: an `incomplete` subscription self-cancels 24h after
# its first invoice, so past that point a fresh subscription is the correct retry.
FIRST_PAYMENT_WINDOW_H = 24


def _resubscribe_block(row: dict | None, now: datetime | None = None) -> str:
    """Why this owner must NOT start another subscription ('' = clear to start).

    PayMongo bills each subscription on a customer independently, so a second
    `POST /v1/subscriptions` is a second charge — and `/billing/checkout` is reachable directly even
    though the UI hides the button once premium.
    """
    if not row:
        return ""
    now = now or datetime.now(UTC)
    if row.get("status") == "incomplete":
        # Checked before the period branch: an incomplete subscription has no period yet, and while
        # the Maya link is alive a second subscription is a second charge for the same first month.
        started = row.get("updated_at")
        if started is None or (now - started).total_seconds() < FIRST_PAYMENT_WINDOW_H * 3600:
            return "A first payment is already pending — finish it, or retry after it expires (24h)"
        return ""
    period_end = row.get("current_period_end")
    if row.get("plan") == "premium" and (period_end is None or period_end > now):
        # active, past_due, or cancelled-with-time-left — all still inside a period they paid for.
        return "Your subscription already covers the current period"
    return ""


def _require_config() -> None:
    if not SECRET_KEY or not PLAN_ID:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Billing is not configured")


def _require_period_config() -> None:
    """Period mode has no plan to hold the price: it lives in PREMIUM_PRICE_CENTAVOS."""
    if not SECRET_KEY:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Billing is not configured")


async def _api(method: str, path: str, **kwargs) -> dict:
    """One PayMongo call. Basic auth = secret key + empty password."""
    async with httpx.AsyncClient(base_url=API_BASE, auth=(SECRET_KEY, ""), timeout=20) as client:
        res = await client.request(method, path, **kwargs)
    if res.status_code >= 400:
        # Log the provider body (it explains 400s that would otherwise be opaque); never return it
        # to the client — it can echo request metadata.
        log.warning("paymongo.request_failed", method=method, path=path, status=res.status_code, body=res.text[:500])
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Payment provider error")
    return res.json()


async def _try_variants(variants: list, attempt) -> dict:
    """Run `attempt` on each variant, returning the first accepted response.

    AI HERE: hedges two documented-but-unguaranteed PayMongo shapes that could not be exercised
    before launch (no activated account) — the invoice-list path prefix and whether a server-side
    attach tolerates `client_key`. Each retry logs `paymongo.variant_retry`; collapse this to the
    winning variant once a sandbox run proves which one it is.
    """
    for i, variant in enumerate(variants):
        try:
            return await attempt(variant)
        except HTTPException:
            if i == len(variants) - 1:
                raise
            log.warning("paymongo.variant_retry", variant_index=i)
    raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Payment provider error")


async def start_subscription(user: ClerkUser) -> str:
    """Create the subscription and return the Maya URL for its first payment.

    PayMongo has no hosted "subscribe" page: the first invoice's Payment Intent must be attached
    to a PaymentMethod. Maya is the only redirect-capable method PayMongo supports for
    subscriptions, so the first payment is a redirect and every later cycle is charged by PayMongo.
    """
    _require_config()
    # PayMongo keys customers by a unique email; the Clerk `sub` claim is not an email.
    if "@" not in (user.email or ""):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Add an email to your account before upgrading")
    existing = await fetchrow("SELECT plan, status, current_period_end, updated_at FROM subscriptions WHERE owner_id = $1", user.sub)
    block = _resubscribe_block(existing)
    if block:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=block)

    customer_id = await _ensure_customer(user)
    sub = await _api(
        "POST",
        "/v1/subscriptions",
        json={"data": {"attributes": {"plan_id": PLAN_ID, "customer_id": customer_id}}},
    )
    subs_id = sub["data"]["id"]
    # Record the ids *before* the redirect: the customer may never come back from Maya, and the
    # webhook that follows needs a row to resolve the owner from.
    await _upsert(user.sub, customer_id, subs_id, PLAN_ID, "premium", "incomplete", None)

    return await _redirect_for_intent(await _first_invoice_intent(subs_id))


async def _redirect_for_intent(intent_id: str) -> str:
    """Attach a Maya PaymentMethod and return the hosted redirect URL (no redirect exists before
    the attach — PayMongo has no "pay this" page for an unattached intent)."""
    method = await _api("POST", "/v1/payment_methods", json={"data": {"attributes": {"type": "paymaya"}}})
    # AI HERE: one extra GET for `client_key` so the attach body satisfies both the secret-key and
    # the public-key flow. Drop it once a sandbox attach proves the key is unnecessary.
    intent = await _api("GET", f"/v1/payment_intents/{intent_id}")
    body = {"payment_method": method["data"]["id"], "return_url": f"{FRONTEND_BASE_URL}/app?upgrade=pending"}
    attach = await _try_variants(
        # `client_key` is documented for the public-key attach and is a browser-safe token, so send it
        # first (matching the only documented shape) and fall back to a secret-key-only body.
        [{**body, "client_key": intent["data"]["attributes"]["client_key"]}, body],
        lambda attrs: _api("POST", f"/v1/payment_intents/{intent_id}/attach", json={"data": {"attributes": attrs}}),
    )
    url = ((attach.get("data", {}).get("attributes", {}).get("next_action") or {}).get("redirect") or {}).get("url")
    if not url:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Payment provider returned no redirect URL")
    return url


async def start_period_purchase(user: ClerkUser) -> str:
    """One-time ₱499 buys PREMIUM_PERIOD_DAYS of premium; returns the Maya redirect URL.

    The row is written BEFORE the redirect (the customer may never come back, and the webhook needs a
    row to resolve an owner from).
    """
    _require_period_config()
    if "@" not in (user.email or ""):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Add an email to your account before upgrading")
    existing = await fetchrow("SELECT plan, status, current_period_end, updated_at FROM subscriptions WHERE owner_id = $1", user.sub)
    block = _resubscribe_block(existing)
    if block:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=block)

    customer_id = await _ensure_customer(user)
    intent = await _api(
        "POST",
        "/v1/payment_intents",
        json={
            "data": {
                "attributes": {
                    "amount": PREMIUM_PRICE_CENTAVOS,
                    "currency": "PHP",
                    "payment_method_allowed": list(PERIOD_METHODS),
                    "capture_type": "automatic",
                    "description": f"Maxterview Premium ({PREMIUM_PERIOD_DAYS} days)",
                    "metadata": {"owner_id": user.sub},
                }
            }
        },
    )
    intent_id = intent["data"]["id"]
    # `provider_subscription_id` holds the intent id: that is the column `_owner_for` resolves from
    # (PayMongo's `payment.paid` carries `payment_intent_id`), so period mode needs no migration.
    # AI HERE: one handle per owner, one period per payment; stacked renewals or refunds would want a
    # ledger keyed by provider id.
    await _upsert(user.sub, customer_id, intent_id, "", "premium", "incomplete", None)
    return await _redirect_for_intent(intent_id)


async def start_upgrade(user: ClerkUser) -> str:
    """Upgrade URL for the configured mode — the routes stay mode-blind."""
    if BILLING_MODE == "subscription":
        return await start_subscription(user)
    return await start_period_purchase(user)


async def cancel_upgrade(user: ClerkUser) -> None:
    if BILLING_MODE == "subscription":
        await cancel_subscription(user)
        return
    # Nothing is scheduled provider-side, so this only records "do not renew": the paid time keeps
    # serving (billing.ENTITLED_STATUSES). No live period -> nothing to cancel.
    row = await fetchrow("SELECT current_period_end FROM subscriptions WHERE owner_id = $1", user.sub)
    period_end = (row or {}).get("current_period_end")
    if not period_end or period_end <= datetime.now(UTC):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No active period to cancel")
    await fetchrow(
        "UPDATE subscriptions SET plan = 'premium', status = 'cancelled', updated_at = now() WHERE owner_id = $1 RETURNING id",
        user.sub,
    )


async def cancel_subscription(user: ClerkUser) -> None:
    """Stop billing immediately; the paid-for period keeps serving (see ENTITLED_STATUSES).

    PayMongo has no billing portal, so this is our own cancel path. Open invoices stay collectible.
    """
    row = await fetchrow("SELECT provider_subscription_id FROM subscriptions WHERE owner_id = $1", user.sub)
    subs_id = (row or {}).get("provider_subscription_id") or ""
    if not subs_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No subscription found")
    _require_config()
    await _api("DELETE", f"/v1/subscriptions/{subs_id}")
    await fetchrow(
        "UPDATE subscriptions SET plan = 'premium', status = 'cancelled', updated_at = now() WHERE owner_id = $1 RETURNING id",
        user.sub,
    )


async def _ensure_customer(user: ClerkUser) -> str:
    """Reuse the owner's PayMongo customer, creating it on first upgrade."""
    row = await fetchrow("SELECT provider, provider_customer_id FROM subscriptions WHERE owner_id = $1", user.sub)
    existing = (row or {}).get("provider_customer_id") or ""
    # Only trust an id this provider issued: 0008 renamed Stripe's `stripe_id` into
    # `provider_customer_id`, so a pre-swap row still carries a `cus_…` PayMongo never saw.
    if existing and (row or {}).get("provider") == PROVIDER:
        return existing
    name = (user.name or "").strip().split(" ", 1)
    customer = await _api(
        "POST",
        "/v1/customers",
        json={
            "data": {
                "attributes": {
                    "first_name": name[0] or "Maxterview",
                    "last_name": name[1] if len(name) > 1 else "Member",
                    "email": user.email,
                    # Required by PayMongo; the upgrade path already refuses to start without an
                    # email, so `email` is the only honest value.
                    "default_device": "email",
                }
            }
        },
    )
    return customer["data"]["id"]


async def _first_invoice_intent(subs_id: str) -> str:
    """PayMongo generates the first invoice with the subscription; its Payment Intent goes to Maya."""
    params = {"resource_id": subs_id, "limit": 1, "order": "desc"}
    # The docs list the collection endpoint both with and without the `/v1` prefix, so try both.
    invoices = await _try_variants(["/v1/subscriptions/invoices", "/subscriptions/invoices"], lambda path: _api("GET", path, params=params))
    rows = invoices.get("data") or []
    intent = ((rows[0] if rows else {}).get("attributes") or {}).get("payment_intent") or {}
    if not intent.get("id"):
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Payment provider returned no first invoice")
    return intent["id"]


# --- webhooks ---


def verify_signature(raw_body: bytes, header: str) -> bool:
    """`Paymongo-Signature: t=<unix>,te=<hmac>,li=<hmac>` over f"{t}.{raw_body}".

    `te`/`li` are computed with this endpoint's secret for test- and live-mode deliveries; an
    endpoint registered in test mode leaves the other empty, so accept whichever is populated.
    """
    if not WEBHOOK_SECRET or not header:
        return False
    parts = dict(part.split("=", 1) for part in header.split(",") if "=" in part)
    stamp = parts.get("t", "")
    given = [v for key in ("te", "li") if (v := parts.get(key, ""))]
    if not stamp or not given:
        log.warning("paymongo.webhook_signature.malformed", header=header[:80])
        return False
    try:
        age = abs(time.time() - int(stamp))
        if age > SIGNATURE_TOLERANCE_S:
            # Worth a loud log: a genuine event rejected here (provider retries reusing an old `t`)
            # would leave a paying user un-entitled until the next delivery.
            log.warning("paymongo.webhook_signature.stale", age_s=int(age), tolerance_s=SIGNATURE_TOLERANCE_S)
            return False
    except ValueError:
        return False
    expected = hmac.new(WEBHOOK_SECRET.encode(), f"{stamp}.".encode() + raw_body, hashlib.sha256).hexdigest()
    if any(hmac.compare_digest(expected, candidate) for candidate in given):
        return True
    log.warning("paymongo.webhook_signature.mismatch", livemode_slot=bool(parts.get("li")))
    return False


def _envelope(event: dict) -> tuple[str, dict, bool]:
    """PayMongo has shipped two webhook envelopes; both carry {type, livemode, data}.

    1. {"data": {"attributes": {"type": …, "livemode": …, "data": {resource}}}}  (events reference)
    2. {"data": {"type": …, "livemode": …, "data": {resource}}}                  (checkout docs)
    """
    outer = event.get("data") or {}
    attrs = outer.get("attributes") if isinstance(outer.get("attributes"), dict) else outer
    return attrs.get("type", ""), (attrs.get("data") or {}), bool(attrs.get("livemode"))


async def handle_webhook_event(event: dict) -> None:
    etype, resource, _livemode = _envelope(event)
    attrs = resource.get("attributes") or {}
    if resource.get("type") == "subscription":
        await _on_subscription(attrs)
    elif resource.get("type") == "invoice":
        await _on_invoice(etype, attrs)
    elif resource.get("type") in ("payment", "payment_intent"):
        await _on_payment(etype, resource, attrs)
    # invoice.created/finalized/updated are draft/open churn: no entitlement change, no write.


async def _on_payment(etype: str, resource: dict, attrs: dict) -> None:
    """Period mode: a paid one-time payment extends the owner's premium period.

    Both `payment.paid` and `payment_intent.succeeded` are accepted — either may be the only one a
    method emits, and the write below is a compare-and-set so receiving both costs nothing.
    """
    if etype not in ("payment.paid", "payment_intent.succeeded"):
        return
    # `payment` carries the intent it was charged against; a `payment_intent` event IS the intent.
    intent_id = attrs.get("payment_intent_id") or (resource.get("id") if resource.get("type") == "payment_intent" else "")
    if not intent_id:
        log.warning("paymongo.webhook.payment_without_intent", event_type=etype)
        return
    owner = await _owner_for(subscription_id=intent_id)
    if not owner:
        # An intent we never issued: ack it, write nothing.
        log.info("paymongo.webhook.unknown_payment_intent", payment_intent_id=intent_id, event_type=etype)
        return
    # Compare-and-set on the pending row: a replayed or duplicated delivery must not buy two periods.
    row = await fetchrow(
        """
        UPDATE subscriptions SET plan = 'premium', status = 'active', current_period_end = $3, updated_at = now()
        WHERE owner_id = $1 AND provider_subscription_id = $2 AND status = 'incomplete'
        RETURNING id
        """,
        owner,
        intent_id,
        datetime.now(UTC) + timedelta(days=PREMIUM_PERIOD_DAYS),
    )
    if not row:
        # Already credited (replay), or the row moved on to a newer intent.
        log.info("paymongo.webhook.payment_not_credited", payment_intent_id=intent_id, event_type=etype)


async def _on_subscription(attrs: dict) -> None:
    subs_id = attrs.get("id") or ""
    # Strict on purpose: only the subscription id currently stored on the row may resolve an owner.
    # Falling back to `customer_id` here would let a STALE event (out-of-order delivery is documented
    # by PayMongo: a late `cancelled` for a subscription the user already replaced) overwrite the live
    # row — downgrading a paying customer and pointing their row at a dead subscription.
    owner = await _owner_for(subscription_id=subs_id)
    if not owner:
        if subs_id:
            log.info("paymongo.webhook.unknown_subscription", subscription_id=subs_id, status=attrs.get("status"))
            return
        owner = await _owner_for(customer_id=attrs.get("customer_id") or "")
    if not owner:
        return
    status_str = attrs.get("status") or ""
    await _upsert(
        owner,
        attrs.get("customer_id") or "",
        subs_id,
        attrs.get("plan_id") or "",
        "free" if status_str in TERMINAL_STATUSES else "premium",
        status_str,
        _period_end(attrs.get("next_billing_schedule")),
    )


async def _on_invoice(etype: str, attrs: dict) -> None:
    owner = await _owner_for(subscription_id=attrs.get("resource_id") or "")
    if not owner:
        return
    if etype == "subscription.invoice.paid":
        # The strongest "money arrived" signal — it recovers a lapsed-but-live subscription. It does
        # NOT resurrect a cancelled or 24h-expired one: those are deliberate end states, and a
        # cancelled subscription can still have collectible open invoices (PayMongo keeps them).
        # `current_period_end` is left to the subscription events, which carry next_billing_schedule.
        await fetchrow(
            """
            UPDATE subscriptions SET plan = 'premium', status = 'active', updated_at = now()
            WHERE owner_id = $1 AND status IN ('past_due', 'unpaid', 'incomplete')
            RETURNING id
            """,
            owner,
        )
    elif etype == "subscription.invoice.payment_failed":
        await fetchrow(
            "UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE owner_id = $1 RETURNING id",
            owner,
        )


async def _owner_for(*, subscription_id: str = "", customer_id: str = "") -> str | None:
    """Resolve the Clerk owner from PayMongo ids — invoice events carry only the subscription id."""
    if subscription_id:
        row = await fetchrow("SELECT owner_id FROM subscriptions WHERE provider_subscription_id = $1 LIMIT 1", subscription_id)
        if row:
            return row["owner_id"]
    if customer_id:
        row = await fetchrow("SELECT owner_id FROM subscriptions WHERE provider_customer_id = $1 LIMIT 1", customer_id)
        if row:
            return row["owner_id"]
    return None


async def _upsert(owner_id: str, customer_id: str, subs_id: str, plan_id: str, plan: str, status_str: str, period_end) -> None:
    await fetchrow(
        """
        INSERT INTO subscriptions (owner_id, provider, provider_customer_id, provider_subscription_id, provider_plan_id, plan, status, current_period_end)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (owner_id) DO UPDATE SET
            provider = EXCLUDED.provider,
            provider_customer_id = EXCLUDED.provider_customer_id,
            provider_subscription_id = EXCLUDED.provider_subscription_id,
            provider_plan_id = EXCLUDED.provider_plan_id,
            plan = EXCLUDED.plan,
            status = EXCLUDED.status,
            current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
            updated_at = now()
        RETURNING id
        """,
        owner_id,
        PROVIDER,
        customer_id,
        subs_id,
        plan_id,
        plan,
        status_str,
        period_end,
    )


def _period_end(value) -> datetime | None:
    """`next_billing_schedule` is a YYYY-MM-DD date; asyncpg needs tz-aware for timestamptz."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=UTC)
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=UTC)
    try:
        return datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=UTC)
    except (TypeError, ValueError):
        return None
