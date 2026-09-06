"""M10 raw Stripe payment flow (MONETIZATION.md §4).

Checkout -> Stripe -> webhook -> subscriptions table -> resolve_tier upgrades the user.

Entitlement is driven by SUBSCRIPTION events (customer.subscription.created/updated/deleted),
which reliably follow checkout. Owner->subscription mapping:
  - checkout.session.completed carries `owner_id` in metadata -> we record customer+owner.
  - customer.subscription.* events are upserted onto the matching row.

Config (env, zero-touch on credentials):
  STRIPE_SECRET_KEY     required for checkout/portal; used only server-side.
  STRIPE_WEBHOOK_SECRET required to verify webhook signatures.
  STRIPE_PRICE_ID       the premium monthly price id (e.g. price_xxx).
  FRONTEND_BASE_URL     success/cancel + portal return URLs.
"""

import os
from datetime import UTC, datetime

import stripe
from fastapi import HTTPException, status

from app.models import ClerkUser

STRIPE_SECRET_KEY = os.getenv("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET", "")
STRIPE_PRICE_ID = os.getenv("STRIPE_PRICE_ID", "")
FRONTEND_BASE_URL = os.getenv("FRONTEND_BASE_URL", "http://localhost:5173")


def _client() -> stripe.StripeClient:
    if not STRIPE_SECRET_KEY:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Billing is not configured")
    return stripe.StripeClient(STRIPE_SECRET_KEY)


def create_checkout_session(user: ClerkUser) -> str:
    """Return a hosted checkout URL for the premium monthly plan."""
    if not STRIPE_PRICE_ID:
        raise HTTPException(status_code=503, detail="Billing price is not configured")
    session = _client().checkout.sessions.create(
        params={
            "mode": "subscription",
            # Only prefill the email when the JWT actually carries one; NEVER fall back to the
            # sub claim (user_xxx is not an email -> Stripe rejects). Stripe collects it at checkout.
            **({"customer_email": user.email} if (user.email or "").__contains__("@") else {}),
            "line_items": [{"price": STRIPE_PRICE_ID, "quantity": 1}],
            "success_url": f"{FRONTEND_BASE_URL}/app?upgrade=success",
            "cancel_url": f"{FRONTEND_BASE_URL}/app?upgrade=cancelled",
            "metadata": {"owner_id": user.sub},
        }
    )
    return session["url"]


async def create_portal_session(user: ClerkUser) -> str:
    """Return a Stripe billing-portal URL for the user's existing subscription."""
    row = await _subscription_row(user.sub)
    if row is None or not row["stripe_id"]:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No subscription found")
    portal = _client().billing_portal.sessions.create(params={"customer": row["stripe_id"], "return_url": f"{FRONTEND_BASE_URL}/app"})
    return portal["url"]


async def _subscription_row(owner_id: str):
    from app.db import fetchrow

    return await fetchrow("SELECT * FROM subscriptions WHERE owner_id = $1", owner_id)


async def _upsert(owner_id: str, stripe_id: str, status_str: str, period_end) -> None:
    """Idempotently upsert a subscription row."""
    from app.db import fetchrow

    await fetchrow(
        """
        INSERT INTO subscriptions (owner_id, stripe_id, plan, status, current_period_end)
        VALUES ($1, $2, 'premium', $3, $4)
        ON CONFLICT (owner_id) DO UPDATE SET
            stripe_id = EXCLUDED.stripe_id,
            plan = EXCLUDED.plan,
            status = EXCLUDED.status,
            current_period_end = EXCLUDED.current_period_end,
            updated_at = now()
        RETURNING id
        """,
        owner_id,
        stripe_id,
        status_str,
        period_end,
    )


async def handle_webhook_event(event: dict) -> None:
    """Apply a verified Stripe event to the subscriptions table (idempotent)."""
    from app.db import fetchrow

    etype = event.get("type", "")
    obj = event.get("data", {}).get("object", {})

    if etype == "checkout.session.completed":
        # Record owner->customer so later subscription events can resolve the owner.
        owner_id = (obj.get("metadata") or {}).get("owner_id")
        customer = obj.get("customer")
        if owner_id and customer:
            await _upsert(owner_id, customer, "active", None)

    elif etype in ("customer.subscription.created", "customer.subscription.updated"):
        # The subscription object: status + periods authoritative.
        customer = obj.get("customer")
        status_str = "active" if obj.get("status") in ("active", "trialing") else obj.get("status", "unknown")
        period_end = _period_end(obj)
        # Resolve owner: prefer the owner already stored with this customer id.
        row = await fetchrow("SELECT owner_id FROM subscriptions WHERE stripe_id = $1 LIMIT 1", customer)
        owner_id = row["owner_id"] if row else (obj.get("metadata") or {}).get("owner_id")
        if owner_id:
            await _upsert(owner_id, customer, status_str, period_end)

    elif etype == "customer.subscription.deleted":
        customer = obj.get("customer")
        row = await fetchrow("SELECT owner_id FROM subscriptions WHERE stripe_id = $1 LIMIT 1", customer)
        if row:
            await fetchrow(
                "UPDATE subscriptions SET plan='free', status='canceled' WHERE owner_id = $1 RETURNING id",
                row["owner_id"],
            )


def _period_end(sub: dict):
    items = sub.get("items", {}).get("data", [])
    pe = sub.get("current_period_end")
    for it in items:
        if it.get("current_period_end"):
            pe = it["current_period_end"]
            break
    # Stripe sends epoch seconds (int); asyncpg needs a tz-aware datetime for
    # the timestamptz column. Guard against already-native datetimes for safety.
    if isinstance(pe, datetime):
        return pe
    return datetime.fromtimestamp(pe, tz=UTC) if pe is not None else None
