# MONETIZATION — Payment & Billing

> **Model: Free / Premium + dev-only.** Billing spec for **M10**. **Shipped:** quota backend;
> provider-managed recurring on **PayMongo** (PHP-only, ₱499/mo, Maya first payment), which replaced
> the raw-Stripe implementation on 2026-09-12. The webhook → `subscriptions` → `resolve_tier` path is
> proven end-to-end against Postgres (every status transition, fail-closed signature), but **no
> PayMongo sandbox transaction has run yet** — that needs an account with Subscriptions enabled.
> **Source of truth for decisions:** PLAN.md D10 (and D4 for owner-scoping). Planner status in PLAN.md §8.

## 0. Limits & model (env-configurable, not hardcoded)

|                                           | Free                       | Premium                        | dev                        |
| ----------------------------------------- | -------------------------- | ------------------------------ | -------------------------- |
| Interviews (creation)                     | **unlimited**              | **unlimited**                  | **unlimited**              |
| Price                                     | ₱0                         | **₱499/mo** (monthly only)     | ₱0                         |
| Chat turns / day (GLOBAL, all interviews) | **10** (`FREE_CHAT_TURNS`) | **250** (`PREMIUM_CHAT_TURNS`) | **500** (`DEV_CHAT_TURNS`) |
| Free trial                                | none                       | —                              | —                          |

- **Model change (this pass):** the gate moved from a **per-interview** turn cap to a
  **global daily credits per owner** spanning ALL their interviews in one UTC day, reset at
  00:00 UTC. See §2. No per-interview cap and no daily-interview cap (creation stays unlimited).
  No token counting (2026-08-23 decision) — count turns, not tokens.
- Limits are env-overridable (`backend/.env.example`). **`dev` tier** (only for developers, never prod): the
  no-Clerk dev-fallback identity (`CLERK_ENABLED=false`) resolves to `dev` with caps above premium;
  confines to dev/test and never persists in `subscriptions` (details in PLAN D10).
- **Feedback not feature-gated** — same quality across tiers. Turn cap is the cost-control lever.
- Billing **monthly only**, single-user (D4). PayMongo bills in PHP only; we handle tax (no merchant-of-record).

## 1. The `tier` claim & its source of truth (entitlement)

- **Entitlement (`tier`)** ∈ `{"free", "premium"}` (+ `"dev"` for the no-Clerk dev-fallback
  identity, see §0). Source of truth at runtime is `ClerkUser.tier` (JWT claim), **merged with an
  active `premium` row in the `subscriptions` table** so billing can elevate even when the JWT is
  stale. Implemented in `app/billing.py::resolve_tier`.
- **Consumption (the daily GLOBAL turn counter) is NOT in the JWT** — it's counted from
  `turn_usage`, server-side per owner (owner_id, UTC day) (D4).

## 2. Enforcement (backend-authoritative; frontend is UX only)

Implemented in `app/billing.py` + `app/main.py`.

- **No per-interview cap and no daily-interview cap** (removed): `POST /interviews` does a plain
  INSERT — every owner can create unlimited interviews. Over-land lockout applies only to the
  daily GLOBAL chat-turn credits.
- **Daily GLOBAL chat-turn cap** on `POST /interviews/{id}/chat/stream`: for the owner's current
  UTC day, check `turns_used(today) < limit` (reads `turn_usage`), then `bump_chat_turn`
  (upsert +1 on `(owner_id, today)`). Over → **`402 Payment Required`**. May 402 mid-interview
  once the owner burns today's credits across ALL their interviews.
  Caps: free 10/day, premium 250/day, dev 500/day.
- **BYOK bypasses the cap** (2026-09-13): when the owner saves their own provider key
  (`/app/settings/system`, see `BYOK.md`), the turns run on their account, so the check and
  `bump_chat_turn` are skipped and `GET /usage` returns `byok: true`. The tier label stays:
  BYOK is not an upgrade, it is a different payer. Nothing else in the tier model moves.
- **Overage → lockout:** block new turns only. **Never delete, truncate, or hide existing
  user data** — reads stay fully available. Hard rule.
- **No free trial.** Upgrade is a hard gate.
- **Cache decision:** no cache-aside for the counters (DB-backed, per-user, low-frequency). `tier`
  cached in the JWT; JWKS cached in `auth.py`.
- **Usage status (`GET /usage`):** returns `tier`, today's cap
  (`chat_turns_per_day_<tier>`), and `chat_turns_used_today` / `chat_turns_remaining_today`
  (computed from `turn_usage` for the caller) plus `byok` (`true` = own key, cap not enforced).
  The frontend `/app` header shows a
  **Free / Premium / DEV tier label** (`UsageBadge`). `dev` is returned by the no-Clerk
  dev-fallback identity (see §0).

## 3. Billing provider — PayMongo subscriptions (swapped 2026-09-12)

Implementation: **raw httpx against PayMongo** (chosen over Xendit — see §7 — and over an MoR for now).

**Shipped (backend):**

- `app/payments.py` — the provider module: subscription start, cancel, webhook verify + handle.
- `POST /billing/checkout` — creates the PayMongo subscription and returns the **Maya** URL for its
  first payment. PayMongo has no hosted "subscribe" page, so the first invoice's Payment Intent is
  attached to a `paymaya` PaymentMethod and the customer is redirected; every later cycle is charged
  by PayMongo from that vaulted method. **409s instead of creating a second subscription** while the
  current one still covers a paid period, or while a first payment is pending inside PayMongo's 24h
  window (`payments._resubscribe_block`) — PayMongo bills each subscription on a customer
  independently, and this route is reachable even though the UI hides the button. Two documented
  shapes could not be exercised before launch, so they are tried both ways and the winner is logged
  as `paymongo.variant_retry` (`payments._try_variants`): the invoice-list path prefix and whether a
  server-side attach tolerates `client_key`.
- `POST /billing/cancel` — PayMongo has **no billing portal**, so cancelling is ours: `DELETE` the
  subscription and mark the row `cancelled` (the paid period keeps serving, §6).
- `POST /billing/webhook` — verifies `Paymongo-Signature` (HMAC-SHA256 of `"{t}.{raw_body}"` with the
  endpoint's secret, fail-closed) then upserts `subscriptions`. Timestamps outside
  `PAYMONGO_SIGNATURE_TOLERANCE_S` (default 300 s) are rejected as replays — but that rejection is
  **logged** (`paymongo.webhook_signature.stale`) because a genuine event dropped this way would
  leave a paying user un-entitled, so the window must be tunable without a code change.
- Rate limiting: `/billing/webhook` is **exempt** (`app/ratelimit.py`) — a retry storm from the
  provider's IPs shares one client key, and a 429 there would silently drop entitlement.
- `POST /billing/webhook/simulate` — **dev/test only** (404s when `APP_ENV=production`). Replaces
  `stripe listen`: PayMongo has no CLI, and requiring a tunnel for local webhooks is friction we skip.
- Env: `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`, `PAYMONGO_PLAN_ID`, `FRONTEND_BASE_URL`
  (optional: `PAYMONGO_SIGNATURE_TOLERANCE_S`).

**Event → entitlement map:** `subscription.activated|updated` upserts `plan`/`status`/
`current_period_end` (`cancelled`/`incomplete_cancelled` → `free`); `invoice.paid` sets `active` but
only from `past_due`/`unpaid`/`incomplete` — it deliberately does **not** resurrect a cancelled or
24h-expired subscription (PayMongo keeps open invoices collectible after a cancel);
`invoice.payment_failed` sets `past_due`; draft/open invoice churn is ignored.

**Ordering:** subscription events resolve the owner **only** by `provider_subscription_id`;
`provider_customer_id` is a fallback for id-less events only. PayMongo documents out-of-order
delivery, so a late `cancelled` for a subscription the user already replaced must not match the
customer and overwrite the live row (it is logged as `paymongo.webhook.unknown_subscription`).
Duplicates are safe: every write is an idempotent `ON CONFLICT (owner_id)` upsert.

**Before live keys work (both are account-level, not self-service):** email support@paymongo.com to
enable **Subscriptions** and **Card Vaulting**; a Fully Verified account needs DTI + BIR 2303 for a PH
sole proprietorship. Charges are PHP-only and PayMongo collects `first_name`/`last_name`/`email` per
customer (unique email), which Clerk supplies.

**Business rules:** monthly only, ₱499/mo, no annual, no tiers; recurring is limited to **cards and
Maya** (PayMongo does not support GCash recurring, so GCash users cannot subscribe); we remit tax
(no merchant-of-record).

**Verification (2026-09-12):** no sandbox transaction yet. Proven instead against real Postgres
through the simulate endpoint: `activated` → `premium/active` with a tz-aware `current_period_end`,
`past_due` → `premium/past_due` (not entitled), `invoice.paid` → recovered `premium/active`,
`cancelled` → `free/cancelled`; an unsigned delivery to `/billing/webhook` is rejected 400; 130 rapid
webhook deliveries produce zero 429s while `/api/usage` starts 429ing at the 120/min budget; a
stale-subscription event leaves the live row untouched; `/app?upgrade=pending` renders the pending
notice and `/app` renders without it (browser-checked). **Dev caveat:** in no-Clerk dev mode the
notice cannot flip — `resolve_tier` short-circuits to `dev` — so the pending state is only
exercisable end-to-end on a real Clerk identity.

**Frontend (2026-08-24 → 09-12):** header tier labels (`UsageBadge`) + lockout/upsell notice (`UpgradeNotice` on 402) wired to the subscribe flow, and a dedicated **billing/plan page** (`/app/settings/billing`) with Free vs Premium cards, current-plan summary, an Upgrade → `/billing/checkout` CTA, and in-app **Cancel** (no provider portal exists). The Maya return URL lands on `/app?upgrade=pending`, which `UpgradePendingNotice` turns into a poll → confirm → hard-navigate flow, because the return URL alone is not proof of payment. See PLAN §8 M10.

**Stripe-era payment test (2026-09-06, superseded):** the previous provider returned a hosted Checkout Session URL and delivered signature-verified `customer.subscription.*` events into a `premium`/`active` row; that run is what exposed the epoch-vs-`datetime` binding bug, and the same guard is kept in `payments._period_end` for PayMongo's `next_billing_schedule` date. Residual: until `CLERK_ENABLED=true`, dev-mode users resolve to `dev` rather than premium; `subscriptions` rows can be seeded directly and `resolve_tier` honors them (`ENTITLED_STATUSES` + `current_period_end`).

## 4. Phase-2 schema (shipped with M10 backend)

Applied in `backend/migrations/0002_billing.sql`:

```sql
-- subscriptions / entitlement (owner_id unique)
CREATE TABLE IF NOT EXISTS subscriptions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id            TEXT NOT NULL UNIQUE,        -- Clerk sub (D4)
    provider            TEXT NOT NULL DEFAULT 'paymongo',   -- 0008: provider-agnostic (D10)
    provider_customer_id TEXT NOT NULL DEFAULT '',           -- cus_… (renamed from stripe_id)
    provider_subscription_id TEXT NOT NULL DEFAULT '',       -- subs_… (cancel + webhook owner lookup)
    provider_plan_id    TEXT NOT NULL DEFAULT '',            -- plan_…
    plan                TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','premium')),
    status              TEXT NOT NULL DEFAULT 'active',
    current_period_end  TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (this pass) 0004_global_chat_turns.sql: global daily per-owner counter (supersedes the
-- per-interview interviews.chat_turns added in 0002, which is dropped here).
ALTER TABLE interviews DROP COLUMN IF EXISTS chat_turns;

CREATE TABLE IF NOT EXISTS turn_usage (
    owner_id TEXT NOT NULL,
    day      DATE NOT NULL,          -- UTC day (reset at 00:00 UTC)
    turns    INT  NOT NULL DEFAULT 0,
    PRIMARY KEY (owner_id, day)
);
```

> **No token metering** — the `turn_usage` counter counts turns, not tokens (decision
> 2026-08-23). Token/tokens_used tables were deliberately dropped; reintroduce only if LLM cost
> accounting is required later.

## 5. M10 handoff

| Shipped                                                                                                                                                      | Open                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Backend: `billing.py`, `payments.py` (subscribe/cancel/webhook + dev simulate), `0002`/`0008` migrations                                                                     | **Nothing blocking in code.** Production config still owed: `CLERK_ENABLED=true` (live), PayMongo **Subscriptions + Card Vaulting enabled by support**, a real webhook endpoint whose secret lands in `PAYMONGO_WEBHOOK_SECRET`, and a Fully Verified account (DTI + BIR) for live keys |
| Caps: daily GLOBAL chat-turn per owner (free 10 / premium 250 / dev 500, UTC-day reset; `0004_global_chat_turns`); no per-interview / no daily-interview cap | —                                                                                                         |
| Frontend: usage badge, upsell/lockout notices, billing/plan page (`/app/settings/billing`)                                                                   | —                                                                                                         |
| **Postgres-proof (2026-09-12):** activated/past_due/invoice.paid/payment_failed/cancelled transitions + fail-closed signature                                                                  | **PayMongo sandbox proof** (real plan/customer/subscription + Maya first payment) once keys exist                        |

## 6. Cancellation & billing terms (M10, PayMongo)

- **Cancellation → access till end of the current paid period, no refunds.**
- **Refund (2026-08-16): 3-day voluntary refund window**; after 3 days no voluntary refunds.
- **Chargebacks/disputes:** separate from refunds — on a chargeback, downgrade to free immediately and
  respond via PayMongo's dispute flow. A refund policy does not stop chargebacks.
- **Failed renewal / card declined:** **immediate downgrade, no grace**. No paid time remains.
- Enforced via `subscriptions.status` / `current_period_end`; lockout at period end.
- **Stale-JWT holes:** on downgrade, either (a) refresh/stamp the JWT, or (b) consult server-side
  `subscriptions` (recommended — `resolve_tier` already does). On upgrade, Clerk must force a JWT
  refresh so "I paid and it didn't unlock" doesn't become a support ticket.

## 7. Provider decision record (2026-09-12)

**Xendit — rejected.** Its published PH rate card adds a **₱11 Processing Fee per transaction
*attempt*** (failed charges and refunds included) on top of method fees, and — fatal at this stage — a
**USD 50 (~₱2,850)/month Monthly Minimum Fee** whenever the monthly invoice is under USD 50 (effective
2026-09-01 for merchants contracted to Xendit Philippines Inc., 2026-10-01 elsewhere). At ₱499/mo the
per-cycle fee is ~₱28, so the floor only stops biting near **~100 paying subscribers**; at 20 subs it
would take roughly a quarter of revenue. It also requires a registered entity, and authenticates
webhooks with a static `x-callback-token` instead of an HMAC over the raw body.

**PayMongo — chosen.** No setup fee, no monthly minimum, cards 3.125% + ₱13.39, Maya 1.79%, GCash
2.23%, QR Ph 1.34%, and correctly signed webhooks. Accepted trade-offs: Subscriptions + Card Vaulting
are enabled by support (not self-service), recurring covers cards and Maya only, and there is no
billing portal — we own cancel.

**Global/USD later.** PayMongo is PHP-only and PH-rail-only, so USD pricing for non-PH buyers needs a
merchant-of-record (Paddle / Lemon Squeezy / Polar: they remit VAT and pay out to an unregistered PH
individual, which is the only option before DTI/BIR exists). The seam is `payments.py` plus the
`subscriptions.provider*` columns (D10) — a second module, not a rewrite.
