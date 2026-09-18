# MONETIZATION — payment & billing

**Shipped (M10).** Quota backend + **PayMongo** (PHP-only, ₱499, Maya first payment), replacing the
raw-Stripe implementation on 2026-09-12. **The shipping rail is `BILLING_MODE=period`** — one payment
buys 30 days — because PayMongo enables Subscriptions only by hand (§4); provider-managed recurring
stays implemented and dormant behind that one env var. Decisions: PLAN D10 (and D4 for owner-scoping).

## 0. Limits & model (env-configurable, not hardcoded)

|                                           | Free                       | Premium                              | dev                        |
| ----------------------------------------- | -------------------------- | ------------------------------------ | -------------------------- |
| Interviews (creation)                     | **unlimited**              | **unlimited**                        | **unlimited**              |
| Resumes kept                              | **1** (`FREE_RESUMES`)     | **5** (`PREMIUM_RESUMES`)            | **5** (`DEV_RESUMES`)      |
| Price                                     | ₱0                         | **₱499 / 30 days** (one payment)     | ₱0                         |
| Chat turns / day (GLOBAL, all interviews) | **30** (`FREE_CHAT_TURNS`) | **250** (`PREMIUM_CHAT_TURNS`)       | **500** (`DEV_CHAT_TURNS`) |

- The gate is a **global daily credit per owner** spanning ALL their interviews in one UTC day, reset
  at 00:00 UTC. No per-interview cap, no daily-interview cap, no free trial. Count **turns, not
  tokens** (2026-08-23 decision) — token tables were deliberately dropped.
- The resume cap is **storage, not a meter**: importing one spends nothing (parsing is local CPU), so
  it is counted at INSERT and never decremented. At the cap a free owner gets `402` and a paid one
  `409`, which is the difference between an upsell and a wall.
- Limits are env-overridable (`backend/.env.example`). The **`dev` tier** is for developers only and
  never persists in `subscriptions`; it is what the no-Clerk fallback identity resolves to.
- **Feedback is not feature-gated** — same quality across tiers. The turn cap is the cost lever.
- Billing is **one payment at a time**, single-user (D4): period mode sells 30 days and does not
  auto-renew. PayMongo bills in PHP only; we handle tax (no merchant-of-record).

## 1. The `tier` claim & its source of truth

- **Entitlement** ∈ `{"free", "premium"}` (+ `"dev"` for the no-Clerk fallback). Runtime source of
  truth is `ClerkUser.tier` (JWT claim) **merged with an active `premium` row in `subscriptions`**,
  so billing can elevate even when the JWT is stale — `billing.py::resolve_tier`.
- **Consumption is NOT in the JWT**: the daily global turn counter is read from `turn_usage`,
  server-side per `(owner_id, UTC day)`.

## 2. Enforcement (`billing.py` + `main.py`)

- **No per-interview or daily-interview cap**: `POST /interviews` is a plain INSERT.
- **Daily global chat-turn cap** on `POST /interviews/{id}/chat/stream`: check
  `turns_used(today) < limit` against `turn_usage`, then upsert +1. Over → **`402`**, which may
  happen mid-interview once the owner burns today's credits across ALL their interviews.
- **BYOK swaps the cap, it does not waive it** (2026-09-14): with a saved provider key the turns run
  on the owner's account, so the tier cap is replaced by the flat `BYOK_CHAT_TURNS` ceiling
  (default 1000/day) and the turn is still metered. Both halves are load-bearing: `byok` is
  self-asserted, so an unmetered waiver is a free ride on whoever's GPU the `base_url` names.
  `GET /usage` returns `byok: true`; the tier label is unchanged — BYOK is not an upgrade, it is a
  different payer.
- **Overage → lockout:** block new turns only. **Never delete, truncate, or hide existing user
  data** — reads stay fully available. Hard rule.
- **No cache-aside** for the counters (DB-backed, per-user, low-frequency). `tier` is cached in the
  JWT; JWKS in `auth.py`.
- **`GET /usage`** returns `tier`, the EFFECTIVE cap (`chat_turns_per_day_<tier>`, or the BYOK
  ceiling when the caller brings a key), `chat_turns_used_today` / `chat_turns_remaining_today`,
  `byok`, plus `billing_mode` and `premium_until` (period mode has no renewal for the UI to infer an
  expiry from, so the server states it). The frontend header shows the tier via `UsageBadge`.

## 3. Provider — PayMongo (period top-up shipped; subscriptions dormant)

Implementation is **raw httpx against PayMongo** (`app/payments.py`, chosen over Xendit — see §4).
Both modes write the **same** `subscriptions` row and are read by the same `billing.resolve_tier`, so
the mode is a payment rail, not an entitlement model. Paths below are relative to the app's `/api`
prefix (`curl localhost:8000/api/billing/checkout`).

- **`POST /billing/checkout`** — **mode-blind**: `payments.start_upgrade` dispatches on `BILLING_MODE`.
  - **`period` (default, launch)** — creates a Customer (PayMongo now **requires `default_device`**;
    we send `email`), a one-time Payment Intent for `PREMIUM_PRICE_CENTAVOS`, attaches a `paymaya`
    PaymentMethod, and returns the Maya URL. The row is written `premium/incomplete` **before** the
    redirect, holding the intent id in `provider_subscription_id` — the column the webhook resolves
    an owner from, so **no migration**. Needs no account capability; nothing renews, so the user
    buys again.
  - **`subscription` (dormant)** — subscription + first-invoice Payment Intent → Maya; later cycles
    are charged by PayMongo from the vaulted method.
  - **409s instead of a second charge** while a paid period is live, or while a first payment is
    pending inside PayMongo's 24h window (`payments._resubscribe_block`).
- **`POST /billing/cancel`** — PayMongo has **no billing portal**, so cancelling is ours: in
  subscription mode `DELETE` the subscription; in period mode there is nothing scheduled to stop.
  Either way the row goes `cancelled` and the paid period keeps serving (§5).
- **`POST /billing/webhook`** — verifies `Paymongo-Signature` (HMAC-SHA256 of `"{t}.{raw_body}"` with
  the endpoint's secret, **fail-closed**) then upserts `subscriptions`. Timestamps outside
  `PAYMONGO_SIGNATURE_TOLERANCE_S` (default 300 s) are rejected as replays — that rejection is
  **logged** (`paymongo.webhook_signature.stale`), because a genuine dropped event leaves a paying
  user un-entitled, so the window must be tunable without a code change.
- **`POST /billing/webhook/simulate`** — **dev/test only** (404s in prod). PayMongo has no CLI, and
  requiring a tunnel for local webhooks is friction we skip.
- **Rate limiting:** `/billing/webhook` is exempt (`app/ratelimit.py`) — a retry storm from the
  provider's IPs shares one client key, and a 429 there would silently drop entitlement.
- **Env:** `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`, `FRONTEND_BASE_URL`, `BILLING_MODE`,
  `PREMIUM_PRICE_CENTAVOS`, `PREMIUM_PERIOD_DAYS`; `PAYMONGO_PLAN_ID` in subscription mode only
  (optional: `PAYMONGO_SIGNATURE_TOLERANCE_S`).

**Register the prod webhook** (the endpoint is not self-service):

```bash
scripts/payments.sh --register-webhook --url=https://maxterview.seekeru.tech/api/billing/webhook
# then set its secret + the API key in Infisical (TF_VAR_MAXTERVIEW_PAYMONGO_*), then apply
```

**Event → entitlement map.** Period mode: `payment.paid` / `payment_intent.succeeded` set
`plan=premium, status=active, current_period_end = now() + PREMIUM_PERIOD_DAYS` as a
**compare-and-set** on `provider_subscription_id = <intent id> AND status = 'incomplete'`, so a
replay, the sibling event type (both are registered — either may be the only one a method emits) or a
PayMongo retry cannot buy a second period; a refused write logs
`paymongo.webhook.payment_not_credited`. `payment.failed` writes nothing. Subscription mode:
`subscription.activated|updated` upserts `plan`/`status`/`current_period_end`
(`cancelled`/`incomplete_cancelled` → `free`); `invoice.paid` sets `active` but only from
`past_due`/`unpaid`/`incomplete` — it deliberately does **not** resurrect a cancelled or 24h-expired
subscription; `invoice.payment_failed` sets `past_due`; draft/open invoice churn is ignored.
Duplicates are safe: every write is an idempotent `ON CONFLICT (owner_id)` upsert.

**Ordering.** Subscription events resolve the owner **only** by `provider_subscription_id`;
`provider_customer_id` is a fallback for id-less events only. PayMongo documents out-of-order
delivery, so a late `cancelled` for a subscription the user already replaced must not match the
customer and overwrite the live row (logged as `paymongo.webhook.unknown_subscription`).

## 4. Provider decision record (2026-09-12)

**Xendit — rejected.** Its PH rate card adds a ₱11 Processing Fee per transaction **attempt** (failed
charges and refunds included) on top of method fees, plus a **USD 50/month minimum** whenever the
monthly invoice is under USD 50. At ₱499/cycle the per-cycle fee is ~₱28, so the floor only stops
biting near ~100 paying subscribers — but at 20 subs it would take roughly a quarter of revenue. It
also requires a registered entity and authenticates webhooks with a static `x-callback-token`
instead of an HMAC over the raw body.

**PayMongo — chosen.** No setup fee, no monthly minimum, cards 3.125% + ₱13.39, Maya 1.79%, GCash
2.23%, QR Ph 1.34%, and correctly signed webhooks. Accepted trade-offs: Subscriptions + Card Vaulting
are enabled by support (not self-service), recurring covers cards and Maya only, and there is no
billing portal — we own cancel.

**Period mode is the launch rail (2026-09-15).** Every subscription-path call 403s with
`merchant_invalid_state: no subscription payment methods are configured for this organization` —
including `POST /v1/subscriptions/plans`, so even plan creation is blocked. A one-time Payment Intent
needs no account capability, so `BILLING_MODE=period` turns money into the **same** entitlement
(`current_period_end`) with zero changes to `billing.py`, the quota model, `/usage`, the schema or the
DB. Accepted: no auto-renew (the billing page states the expiry; `PAYMONGO_PLAN_ID` is no longer
needed to launch), and live card acceptance still needs a registered business type — **Maya works on
an individual account**. Revisit if support ever enables Subscriptions: `BILLING_MODE=subscription`,
nothing else. (Support email: support@paymongo.com; Fully Verified needs DTI + BIR 2303 for a PH sole
proprietorship.)

**Global/USD later.** PayMongo is PHP-only and PH-rail-only, so USD pricing needs a merchant-of-record
(Paddle / Lemon Squeezy / Polar: they remit VAT and pay out to an unregistered PH individual — the only
option before DTI/BIR exists). The seam is `payments.py` plus the `subscriptions.provider*` columns:
a second module, not a rewrite.

## 5. Cancellation & billing terms

- **Cancellation → access till end of the current paid period, no refunds.**
- **Refund: 3-day voluntary window** (2026-08-16); after 3 days, none voluntarily.
- **Period mode has no renewal, so nothing "fails":** the period lapses at `current_period_end` and
  `resolve_tier` downgrades on the next read. `/billing/cancel` only marks the row `cancelled`, keeping
  the paid time.
- **Chargebacks/disputes still apply to one-time payments:** on a dispute, downgrade immediately and
  respond via PayMongo's dispute flow.
- **Failed renewal / card declined: immediate downgrade, no grace.**
- **Stale-JWT holes:** on downgrade, consult the server-side `subscriptions` row (recommended —
  `resolve_tier` already does). On upgrade, Clerk must force a JWT refresh so "I paid and it didn't
  unlock" doesn't become a support ticket.

## 6. Frontend

Header tier label (`UsageBadge`), lockout/upsell notice (`UpgradeNotice` on 402), and a
billing/plan page (`/app/settings/billing`) with Free vs Premium cards, current-plan summary, an
Upgrade CTA, and in-app **Cancel**. The Maya return URL lands on `/app?upgrade=pending`, which
`UpgradePendingNotice` turns into a poll → confirm → hard-navigate flow, because the return URL alone
is not proof of payment.
