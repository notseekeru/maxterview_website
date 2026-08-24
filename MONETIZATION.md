# MONETIZATION — Payment & Billing

> **Simple two-tier model: Free / Premium.** This file is the billing spec for **M10**.
> **Backend quota enforcement is built (2026-08-24).** Billing provider (Stripe) integration
> and the frontend upsell UX are **deferred**.
> **Source of truth for decisions:** PLAN.md D10 (and D4 for owner-scoping).

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
  `daily_interviews_unlimited`, and the tier's `chat_turns` limit. Frontend shows a badge/notice
  (e.g. "1 free interview left today"). Lands with M10.

## 4. Billing provider (deferred)

Preferred: **Stripe** via **Clerk's billing integration** (`clerk-billing` / Clerk ↔ Stripe).

- Clerk manages checkout/subscription/billing-portal UX and stamps `tier` (+ plan) into the JWT.
- **Monthly only** (one premium plan at $9.99/mo; no annual, no tiers).
- **Multi-currency:** $9.99 reference; Stripe handles local pricing (per-currency price config at setup).
- **Tax:** Stripe calculates, we remit. No merchant-of-record.
- Requires Stripe account + Clerk billing plan + keys in prod Secret (zero-touch on credentials).
- **Deferred:** wired when Stripe test keys are provided. Until then, `subscriptions` rows can be
  created directly (e.g. for testing/promo) and `resolve_tier` honors them.

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
| `app/billing.py` — tiers, quotas, `resolve_tier` | Stripe/Clerk-billing integration + keys |
| Daily interview cap (atomic) + chat-turn cap | Frontend upsell / lock UX + usage badge |
| `GET /usage` endpoint | `require_tier` on the LLM/token path (n/a — no token metering) |
| `subscriptions` + `chat_turns` migration | JWT template that stamps `tier`; real provider config |
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
