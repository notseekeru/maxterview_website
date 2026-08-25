# MONETIZATION — Payment & Billing

> **Simple two-tier model: Free / Premium.** This file is the billing spec for **M10**.
> **Backend quota enforcement + raw Stripe shipped (2026-08-24).** Frontend M10 UX (usage badge +
> lockout/upsell notices) shipped 2026-08-24 (UI). **Dedicated billing/plan page deferred** until
> Stripe keys / live Clerk are verified. **Source of truth for decisions:** PLAN.md D10 (and D4 for owner-scoping).

## 0. Limits (env-configurable, not hardcoded)

| Limit | Free | Premium |
|---|---|---|
| Daily interview cap | **1** (`FREE_DAILY_INTERVIEW_LIMIT`) | **unlimited** |
| Per-interview chat turns | **8** (`FREE_CHAT_TURNS`) | **100** (`PREMIUM_CHAT_TURNS`) |

- **Meter unit = user chat turns + interviews created.** No token counting (decision 2026-08-23:
  simpler to count turns than to meter LLM tokens; revisit only if LLM cost becomes a concern).
- Limits are env-overridable (see `.env.example`). The daily interview resets at UTC midnight
  (`created_at::date = CURRENT_DATE`).

## 1. Model: Free vs. Premium

| | Free | Premium |
|---|---|---|
| Interviews | **1 per day** (daily count) | **unlimited** |
| Chat turns per interview | **8** | **100** (effectively unlimited) |
| Price | $0 | **$9.99 / month** (monthly billing only) |
| Free trial | **none** | — |

- Two tiers only. Gated resources: **daily interview count + per-interview chat turns**.
- **Planned (dev only): a third `dev` tier with caps above premium**, for development/testing.
  Frontend currently shows a `DEV` label when no Clerk key is set (`CLERK_ENABLED=false`); wiring a
  real `dev` tier into `app/billing.py` `LIMITS` + `resolve_tier` (higher caps than premium) is a
  future backend task — the header label will reflect `dev` once `GET /usage` returns it.
- **Feedback is NOT feature-gated by tier** — both tiers get the same feedback quality. The turn cap is
  the cost-control lever (free is tight, premium generous).
- Billing: **monthly only** (no annual). Single-user only (no teams/orgs — D4 owner-scoping).
- No invoice/tax features in scope (Stripe handles tax; no merchant-of-record requirement).
- **Decided 2026-08-11; metering simplified to turn-based 2026-08-24.**

## 2. The `tier` claim & its source of truth (entitlement)

- **Entitlement (`tier`)** ∈ `{"free", "premium"}`. Source of truth at runtime is `ClerkUser.tier`
  (JWT claim), **merged with an active `premium` row in the `subscriptions` table** so billing can
  elevate even when the JWT is stale. Implemented in `app/billing.py::resolve_tier`.
- **Consumption (the daily interview / turn counters) is NOT in the JWT** — it's counted from the
  `interviews` table (daily created) and `interviews.chat_turns`, both server-side per owner (D4).

## 3. Enforcement (backend-authoritative; frontend is UX only)

Implemented in `app/billing.py` + `app/main.py`.

- **Daily interview cap** on `POST /interviews` (free): atomic **conditional INSERT** so two concurrent
  requests can't both pass — `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM interviews WHERE owner_id=$1
  AND created_at::date=CURRENT_DATE HAVING count(*) >= limit)`. Over cap → **`402 Payment Required`**.
  Counts CREATED interviews (abandoned ones consume the daily slot).
- **Per-interview chat-turn cap** on `POST /interviews/{id}/chat/stream` (free): checks
  `interviews.chat_turns < limit`, then `bump_chat_turn`. Over → **`402 Payment Required`**.
- **Premium:** unlimited interviews (daily cap = ∞) and 100 turns.
- **Overage → lockout:** block new creation / new turns only. **Never delete, truncate, or hide existing
  user data** — reads stay fully available. Hard rule.
- **No free trial.** Upgrade is a hard gate.
- **Cache decision:** no cache-aside for the counters (DB-backed, per-user, low-frequency). `tier`
  cached in the JWT; JWKS cached in `auth.py`.
- **Usage status (`GET /usage`):** returns `tier`, `daily_interviews_remaining`,
  `daily_interviews_unlimited`, and the tier's `chat_turns` limit. The frontend `/app` header shows a
  **Free / Premium tier label** (`UsageBadge`) plus a **`DEV` label** when no Clerk key is set.
  Shipped 2026-08-24 (UI); full `dev` tier wiring deferred (see §1).

## 4. Billing provider — raw Stripe (backend shipped 2026-08-24)

Implementation: **raw Stripe** (chosen over Clerk-billing for ownership, learning, and scale).

**Shipped (backend):**
- `app/payments.py` — Stripe client, hosted Checkout Session, billing portal, and the webhook handler.
- `POST /billing/checkout` — creates a monthly subscription Checkout Session (metadata `owner_id`), returns its URL.
- `POST /billing/portal` — returns the Stripe billing portal URL for the user's customer.
- `POST /billing/webhook` — verifies `stripe-signature`, then idempotently upserts `subscriptions` on
  `checkout.session.completed` / `customer.subscription.created|updated|deleted`.
- Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `FRONTEND_BASE_URL` (no secrets committed).

**Business rules:** monthly only, $9.99/mo, no annual, no tiers; multi-currency via Stripe local pricing;
Stripe calculates tax, we remit; no merchant-of-record. Requires Stripe account + keys in prod Secret
(zero-touch on credentials).

**Frontend M10 UX (shipped 2026-08-24, UI only):** the header tier labels (`UsageBadge` → **Free / Premium** + **`DEV`** when no Clerk key; `GET /usage`) and the lockout/upsell notice (`UpgradeNotice` on 402 — links to `POST /billing/checkout` and `POST /billing/portal`) are in the SPA. They are wired and correct, but **end-to-end payment cannot be exercised until the Stripe keys + live Clerk path exist.**

**Deferred (needs Stripe keys / live Clerk):** a **dedicated billing/plan page** and real payment testing (Stripe CLI `listen` for local webhooks → subscribe → webhook → `resolve_tier` → tier flip → cancel/downgrade). Building the page before those are verified is speculative UI against an unverifiable contract (YAGNI) — the existing upsell/usage UX is enough until then. Until live, `subscriptions` rows can be created directly for testing/promo and `resolve_tier` honors them.
## 5. Phase-2 schema (shipped with M10 backend)

Applied in `backend/migrations/0002_billing.sql`:

```sql
-- subscriptions / entitlement (owner_id unique)
CREATE TABLE IF NOT EXISTS subscriptions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id            TEXT NOT NULL UNIQUE,        -- Clerk sub (D4)
    stripe_id           TEXT NOT NULL DEFAULT '',
    plan                TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','premium')),
    status              TEXT NOT NULL DEFAULT 'active',
    current_period_end  TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- per-interview chat-turn counter (free-tier cap; no token metering)
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS chat_turns INTEGER NOT NULL DEFAULT 0;
```

> **No `usage` / `tokens_used` tables** — token metering was intentionally dropped for the turn-based
> model (decision 2026-08-23). Reintroduce only if LLM cost accounting is required later.

## 6. M10 handoff

| Shipped (2026-08-24) | Deferred |
|---|---|
| `app/billing.py` — tiers, quotas, `resolve_tier` | Stripe keys / Stripe CLI local webhook testing |
| Daily interview cap (atomic) + chat-turn cap | Dedicated billing/plan page |
| `GET /usage` endpoint | Live Clerk billing (`CLERK_ENABLED=true`) + JWT `tier` template |
| Frontend upsell/lock UX + usage badge (`UsageBadge`/`UpgradeNotice`) — **shipped 2026-08-24** | — |
| `app/payments.py` — raw Stripe checkout / portal / webhook | Real payment testing (needs `sk_test_`/`whsec_`) |
| `subscriptions` + `chat_turns` migration | — |
| `ClerkUser.tier` seam + `resolve_tier` | — |

## 7. Cancellation & billing terms (M10, deferred with Stripe)

- **Cancellation → access till end of the current paid period, no refunds.**
- **Refund (2026-08-16): 3-day voluntary refund window**; after 3 days no voluntary refunds.
- **Chargebacks/disputes:** separate from refunds — on a chargeback, downgrade to free immediately and
  respond via Stripe's dispute flow. A refund policy does not stop chargebacks.
- **Failed renewal / card declined:** **immediate downgrade, no grace**. No paid time remains.
- Enforced via `subscriptions.status` / `current_period_end`; lockout at period end.
- **Stale-JWT holes:** on downgrade, either (a) refresh/stamp the JWT, or (b) consult server-side
  `subscriptions` (recommended — `resolve_tier` already does). On upgrade, Clerk must force a JWT
  refresh so "I paid and it didn't unlock" doesn't become a support ticket.
