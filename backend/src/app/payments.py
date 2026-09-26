"""M10 billing provider — PayMongo (MONETIZATION.md §3).

Two rails into the SAME entitlement (a paid period on the `subscriptions` row); `BILLING_MODE` picks
one and `billing.resolve_tier` is identical for both:

- `period` (default) — one-time Payment Intent → **QR Ph** (`qrph`) → `payment.paid` extends
  `current_period_end`. Needs no account capability, so this is the mode that ships (MONETIZATION §4).
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

from app import auth
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
PREMIUM_PRICE_CENTAVOS = int(os.getenv("PREMIUM_PRICE_CENTAVOS", "9900"))  # ₱99
PREMIUM_PERIOD_DAYS = int(os.getenv("PREMIUM_PERIOD_DAYS", "30"))
# QR Ph is the only rail this account can take money on. Measured against the LIVE account
# 2026-09-26: `POST /v1/payment_methods` refuses paymaya/gcash/grab_pay/billease with
# `payment_method_not_allowed`, `shopee_pay` is "not configured yet", and `card` is enabled but is a
# PCI-scoped card form plus KYB (business name, TIN, address) we do not have. QR Ph is active on an
# Individual account and every PH wallet and bank app scans it. Test mode allows the others, so a
# test-mode pass proves nothing: probe the live key before changing this.
PERIOD_METHODS = ("qrph",)

# Replay window for `Paymongo-Signature` (docs call this optional; it is cheap on a money endpoint).
# Env-overridable because a rejected fresh-or-not judgement call here means a paying customer is left
# locked out until the next retry — every rejection is logged so it is diagnosable, not silent.
SIGNATURE_TOLERANCE_S = int(os.getenv("PAYMONGO_SIGNATURE_TOLERANCE_S", "300"))

# Provider statuses that mean "no more money is coming" -> the row stops being premium. The other
# statuses stay `premium` so `past_due`/`unpaid` can recover on a later invoice.paid.
TERMINAL_STATUSES = ("cancelled", "incomplete_cancelled")

# SUBSCRIPTION mode only: mirrors PayMongo's own first-payment window (an `incomplete` subscription
# self-cancels 24h after its first invoice). Period mode cannot use it — a QR Ph code lives 30
# minutes, so a 24h lock would outlive the thing it is waiting on (`_pending_block`).
FIRST_PAYMENT_WINDOW_H = 24

# Intent statuses that mean "no money can arrive on this one". Anything else fails CLOSED: the cost
# of blocking is minutes (the QR expires on its own), the cost of selling a second purchase is a
# second charge.
DEAD_INTENT_STATUSES = ("expired", "canceled", "cancelled", "failed")

# Fallback deadline, used only when the intent carries none of its own. Measured 2026-09-26: PayMongo
# never ages an abandoned intent out — an 11-day-old one still reads `awaiting_next_action` — so the
# window has to come from the artifact, and a QR Ph code dies 30 minutes after it is drawn
# (`next_action.code.expires_at`). A redirect method would need its own number here.
QR_TTL_MIN = 30


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
        # the first-payment link is alive a second subscription is a second charge for the same
        # first month. Subscription mode only — period mode goes through `_pending_block`.
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
    Dormant: this account's capability 403s, and Maya itself is not enabled for it.
    """
    _require_config()
    email = await _require_email(user)
    existing = await fetchrow("SELECT plan, status, current_period_end, updated_at FROM subscriptions WHERE owner_id = $1", user.sub)
    block = _resubscribe_block(existing)
    if block:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=block)

    customer_id = await _ensure_customer(user, email)
    sub = await _api(
        "POST",
        "/v1/subscriptions",
        json={"data": {"attributes": {"plan_id": PLAN_ID, "customer_id": customer_id}}},
    )
    subs_id = sub["data"]["id"]
    # Record the ids *before* the redirect: the customer may never come back from Maya, and the
    # webhook that follows needs a row to resolve the owner from.
    await _upsert(user.sub, customer_id, subs_id, PLAN_ID, "premium", "incomplete", None)

    return (await _payable_intent(await _first_invoice_intent(subs_id), "paymaya"))["url"]


async def _payable_intent(intent_id: str, method_type: str) -> dict:
    """Attach a PaymentMethod and return what the BROWSER needs to pay this intent.

    Nothing is payable before the attach (PayMongo has no "pay this" page for an unattached intent),
    and what comes back is decided by the method: `{"url": …}` for a redirect method, `{"qr": …}`
    for a QR one, whose only hand-off is the image itself.
    """
    method = await _api("POST", "/v1/payment_methods", json={"data": {"attributes": {"type": method_type}}})
    # AI HERE: one extra GET for `client_key` so the attach body satisfies both the secret-key and
    # the public-key flow. Drop it once a sandbox attach proves the key is unnecessary.
    intent = await _api("GET", f"/v1/payment_intents/{intent_id}")
    body = {"payment_method": method["data"]["id"], "return_url": f"{FRONTEND_BASE_URL}/dashboard?upgrade=pending"}
    attach = await _try_variants(
        # `client_key` is documented for the public-key attach and is a browser-safe token, so send it
        # first (matching the only documented shape) and fall back to a secret-key-only body.
        [{**body, "client_key": intent["data"]["attributes"]["client_key"]}, body],
        lambda attrs: _api("POST", f"/v1/payment_intents/{intent_id}/attach", json={"data": {"attributes": attrs}}),
    )
    action = ((attach.get("data") or {}).get("attributes") or {}).get("next_action") or {}
    artifact = _artifact(action)
    if not artifact:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Payment provider returned nothing payable")
    return artifact


def _artifact(action: dict) -> dict:
    """`next_action` -> what the browser needs to pay: `{"url": …}` for a redirect method, or
    `{"qr": …}` for a QR one, whose only hand-off is the image itself (`consume_qr`; the code carries
    the amount, is single-use, and `expires_at` is the provider's own deadline). {} if nothing yet."""
    url = (action.get("redirect") or {}).get("url")
    if url:
        return {"url": url}
    code = action.get("code") or {}
    if code.get("image_url"):
        return {"qr": {"image_url": code["image_url"], "expires_at": code.get("expires_at") or ""}}
    return {}


async def start_period_purchase(user: ClerkUser) -> dict:
    """One-time ₱99 buys PREMIUM_PERIOD_DAYS of premium; returns the QR the browser must render.

    The row is written once a PAYABLE artifact exists and before it reaches the browser (the webhook
    needs a row to resolve an owner from, and the page may be closed without paying).
    """
    _require_period_config()
    email = await _require_email(user)
    existing = await fetchrow("SELECT owner_id, plan, status, current_period_end, updated_at, provider_subscription_id FROM subscriptions WHERE owner_id = $1", user.sub)
    if (existing or {}).get("status") == "incomplete":
        # A pending row is judged by the provider, and a code that is STILL payable is handed back as
        # it is: closing the popup, reloading, or coming back later must not strand the payment.
        resumed, block = await _resume_or_block(existing)
        if resumed:
            return resumed
    else:
        block = _resubscribe_block(existing)
    if block:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=block)

    customer_id = await _ensure_customer(user, email)
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
    # Row AFTER the payable artifact, still before the browser can show it. A method the account
    # refuses (`payment_method_not_allowed`) would leave an intent nobody can pay, and a row for it
    # would block the owner's retry.
    payable = await _payable_intent(intent_id, PERIOD_METHODS[0])
    await _upsert(user.sub, customer_id, intent_id, "", "premium", "incomplete", None)
    return payable


async def start_upgrade(user: ClerkUser) -> dict:
    """What `POST /billing/checkout` answers with: `{"url": …}` (follow it) or `{"qr": …}` (render
    it). The routes stay mode-blind."""
    if BILLING_MODE == "subscription":
        return {"url": await start_subscription(user)}
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


async def _require_email(user: ClerkUser) -> str:
    """The address PayMongo keys a customer by. The session token has no `email` claim, so this is
    usually a Backend API lookup — see auth.user_email. No address means no customer, hence 409."""
    email = await auth.user_email(user)
    if "@" not in (email or ""):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Add an email to your account before upgrading")
    return email


async def _ensure_customer(user: ClerkUser, email: str) -> str:
    """Reuse the owner's PayMongo customer, creating it on first upgrade."""
    row = await fetchrow("SELECT provider, provider_customer_id FROM subscriptions WHERE owner_id = $1", user.sub)
    existing = (row or {}).get("provider_customer_id") or ""
    # Only trust an id this provider issued: 0008 renamed Stripe's `stripe_id` into
    # `provider_customer_id`, so a pre-swap row still carries a `cus_…` PayMongo never saw.
    if existing and (row or {}).get("provider") == PROVIDER:
        return existing
    name = (user.name or "").strip().split(" ", 1)
    try:
        customer = await _api(
            "POST",
            "/v1/customers",
            json={
                "data": {
                    "attributes": {
                        "first_name": name[0] or "Maxterview",
                        "last_name": name[1] if len(name) > 1 else "Member",
                        "email": email,
                        # Required by PayMongo; the upgrade path already refuses to start without an
                        # email, so `email` is the only honest value.
                        "default_device": "email",
                    }
                }
            },
        )
    except HTTPException:
        # PayMongo refuses a second customer for one email (measured: 422 "A customer with this email
        # already exists"), which is reachable whenever the row holding the first id is gone — a
        # restore, a cleanup, a swapped provider. Reuse it: the email IS the key PayMongo holds, so
        # re-raising would wedge that address on checkout for good. Its list endpoint REQUIRES an
        # email or phone filter (400 without one), so this is an exact lookup, not a scan.
        found = (await _api("GET", "/v1/customers", params={"email": email, "limit": 100})).get("data") or []
        match = next((c["id"] for c in found if ((c.get("attributes") or {}).get("email") or "").lower() == email.lower()), "")
        if not match:
            raise
        log.info("paymongo.customer_reused", owner_id=user.sub)
        return match
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
    if not await _credit_period(owner, intent_id):
        # Already credited (replay), or the row moved on to a newer intent.
        log.info("paymongo.webhook.payment_not_credited", payment_intent_id=intent_id, event_type=etype)


async def _credit_period(owner_id: str, intent_id: str) -> bool:
    """Extend the paid period if this intent is STILL the owner's pending one — compare-and-set, so a
    replayed webhook delivery and the checkout retry path cannot buy two periods for one payment.
    """
    row = await fetchrow(
        """
        UPDATE subscriptions SET plan = 'premium', status = 'active', current_period_end = $3, updated_at = now()
        WHERE owner_id = $1 AND provider_subscription_id = $2 AND status = 'incomplete'
        RETURNING id
        """,
        owner_id,
        intent_id,
        datetime.now(UTC) + timedelta(days=PREMIUM_PERIOD_DAYS),
    )
    return bool(row)


async def _resume_or_block(row: dict) -> tuple[dict, str]:
    """What a still-`incomplete` period-mode row means for a new checkout.

    Three outcomes: `(artifact, "")` when the SAME payment is still payable (the popup was closed, the
    page reloaded, the buyer came back), `({}, message)` when it must not be started again, and
    `({}, "")` when the code is dead and a fresh intent is correct.

    Handing the artifact back beats refusing on purpose: the row holds the one live intent for this
    owner, so a refusal would lock the buyer out for the code's whole life after a stray click. The
    intent's own `expires_at` is the deadline, and the fallback ceiling exists because a status alone
    would never free the row (PayMongo leaves abandoned intents `awaiting_next_action` forever).
    """
    intent_id = row.get("provider_subscription_id") or ""
    intent_status, expires_at, artifact = await _intent_view(intent_id)
    if intent_status == "succeeded":
        # Money arrived but no delivery credited it. Credit it here through the same compare-and-set
        # the webhook uses (a late delivery then no-ops) instead of selling a second period.
        await _credit_period(row["owner_id"], intent_id)
        return {}, "Payment already received — refresh to see your premium"
    now = datetime.now(UTC)
    deadline = expires_at or (row.get("updated_at") or now) + timedelta(minutes=QR_TTL_MIN)
    if intent_status in DEAD_INTENT_STATUSES or deadline <= now:
        return {}, ""
    if intent_status == "processing":
        # The wallet is mid-payment. Re-showing the code here would invite a second scan.
        return {}, "Your payment is being processed — one moment"
    if artifact:
        return artifact, ""
    left = max(1, int((deadline - now).total_seconds() // 60))
    return {}, f"A payment is already pending — {left} min left"


async def _intent_view(intent_id: str) -> tuple[str, datetime | None, dict]:
    """(status, deadline, payable artifact) from the provider. `("", None, {})` when it cannot be
    read, which callers treat as still alive: minutes of friction beat an uncredited second charge."""
    if not intent_id:
        return "", None, {}
    try:
        data = (await _api("GET", f"/v1/payment_intents/{intent_id}")).get("data") or {}
    except HTTPException:
        return "", None, {}
    attrs = data.get("attributes") or {}
    return attrs.get("status") or "", _period_end(((attrs.get("next_action") or {}).get("code") or {}).get("expires_at")), _artifact(attrs.get("next_action") or {})


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


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=UTC)


def _period_end(value) -> datetime | None:
    """`next_billing_schedule` is a YYYY-MM-DD date and `next_action.code.expires_at` a full ISO
    stamp; both land in a timestamptz column, so asyncpg needs them tz-aware."""
    if not value:
        return None
    if isinstance(value, datetime):
        return _aware(value)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=UTC)
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=UTC)
    for parse in (datetime.fromisoformat, lambda v: datetime.strptime(v, "%Y-%m-%d")):
        try:
            return _aware(parse(value))
        except (TypeError, ValueError):
            pass
    return None
