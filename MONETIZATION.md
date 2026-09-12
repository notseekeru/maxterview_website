# MONETIZATION — Payment & Billing

> **Model: Free / Premium + dev-only.** Billing spec for **M10**. **Shipped:** quota backend + raw
> Stripe (2026-08-24/25); billing/plan page + **real payment test** (2026-09-06) — test-mode
> checkout → webhook → premium `subscriptions` row, signature-verified. **Live Clerk identity
> verified 2026-09-12: real Clerk session → real test subscription → `/usage` reads
> `tier: premium`, and `customer.subscription.deleted` returns it to `free`.
> **Source of truth for decisions:** PLAN.md D10 (and D4 for owner-scoping). Planner status in PLAN.md §8.

## 0. Limits & model (env-configurable, not hardcoded)

|                                           | Free                       | Premium                        | dev                        |
| ----------------------------------------- | -------------------------- | ------------------------------ | -------------------------- |
| Interviews (creation)                     | **unlimited**              | **unlimited**                  | **unlimited**              |
| Price                                     | $0                         | **$9.99/mo** (monthly only)    | $0                         |
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
- Billing **monthly only**, single-user (D4). Stripe handles tax (no merchant-of-record).

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
- **Overage → lockout:** block new turns only. **Never delete, truncate, or hide existing
  user data** — reads stay fully available. Hard rule.
- **No free trial.** Upgrade is a hard gate.
- **Cache decision:** no cache-aside for the counters (DB-backed, per-user, low-frequency). `tier`
  cached in the JWT; JWKS cached in `auth.py`.
- **Usage status (`GET /usage`):** returns `tier`, today's cap
  (`chat_turns_per_day_<tier>`), and `chat_turns_used_today` / `chat_turns_remaining_today`
  (computed from `turn_usage` for the caller). The frontend `/app` header shows a
  **Free / Premium / DEV tier label** (`UsageBadge`). `dev` is returned by the no-Clerk
  dev-fallback identity (see §0).

## 3. Billing provider — raw Stripe (backend shipped 2026-08-24)

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

**Frontend (2026-08-24 → 09-06):** header tier labels (`UsageBadge`) + lockout/upsell notice (`UpgradeNotice` on 402) wired to checkout/portal, and a dedicated **billing/plan page** (`/app/settings/billing`) with Free vs Premium cards, current-plan summary, and an Upgrade → `/billing/checkout` CTA. See PLAN §8 M10.

**Payment test (2026-09-06):** real test-mode Checkout Session URL returned; live `stripe listen` delivered signature-verified `customer.subscription.*` events → a **`premium`/`active` `subscriptions` row** (found+fixed `_period_end` passing Stripe's epoch int where asyncpg needs a `datetime` — it used to 500). Residual: only a live Clerk identity surfaces `premium` in `/usage`; until `CLERK_ENABLED=true`, dev-mode users see `dev`. Until live, `subscriptions` rows can be seeded directly and `resolve_tier` honors them.

## 4. Phase-2 schema (shipped with M10 backend)

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
| Backend: `billing.py`, `payments.py` (checkout/portal/webhook), `0002_billing` migration                                                                     | **Nothing blocking.** Production still needs `CLERK_ENABLED=true` + the prod Clerk domain/JWKS + Stripe live keys (pre-ship config, not code) |
| Caps: daily GLOBAL chat-turn per owner (free 10 / premium 250 / dev 500, UTC-day reset; `0004_global_chat_turns`); no per-interview / no daily-interview cap | —                                                                                                         |
| Frontend: usage badge, upsell/lockout notices, billing/plan page (`/app/settings/billing`)                                                                   | —                                                                                                         |
| Real payment test (2026-09-06) + `_period_end` datetime fix                                                                                                  | —                                                                                                         |
| **Live-Clerk tier proof (2026-09-12):** real Clerk session JWT + real test subscription → `premium` in `/usage`; deleted → `free`                            | —                                                                                                         |

## 6. Cancellation & billing terms (M10, deferred with Stripe)

- **Cancellation → access till end of the current paid period, no refunds.**
- **Refund (2026-08-16): 3-day voluntary refund window**; after 3 days no voluntary refunds.
- **Chargebacks/disputes:** separate from refunds — on a chargeback, downgrade to free immediately and
  respond via Stripe's dispute flow. A refund policy does not stop chargebacks.
- **Failed renewal / card declined:** **immediate downgrade, no grace**. No paid time remains.
- Enforced via `subscriptions.status` / `current_period_end`; lockout at period end.
- **Stale-JWT holes:** on downgrade, either (a) refresh/stamp the JWT, or (b) consult server-side
  `subscriptions` (recommended — `resolve_tier` already does). On upgrade, Clerk must force a JWT
  refresh so "I paid and it didn't unlock" doesn't become a support ticket.
