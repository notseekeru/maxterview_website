# MONETIZATION — Payment & Billing

> **Model: Free / Premium + dev-only.** This file is the billing spec for **M10**.
> **Backend quota enforcement + raw Stripe shipped (2026-08-24).** **No daily-interview cap +
> `dev` tier backend wiring shipped 2026-08-25:** interviews are unlimited at creation; the only gate
> is the per-interview chat-turn cap; `dev` (500 turns) applies only to the no-Clerk dev-fallback
> identity. Frontend M10 UX (usage badge + lockout/upsell notices) shipped 2026-08-24 (UI).
> **Dedicated billing/plan page deferred** until Stripe keys / live Clerk are verified.
> **Source of truth for decisions:** PLAN.md D10 (and D4 for owner-scoping).

## 0. Limits & model (env-configurable, not hardcoded)

| | Free | Premium | dev |
|---|---|---|---|
| Interviews (creation) | **unlimited** | **unlimited** | **unlimited** |
| Chat turns / interview | **8** (`FREE_CHAT_TURNS`) | **100** (`PREMIUM_CHAT_TURNS`) | **500** (`DEV_CHAT_TURNS`) |
| Price | $0 | **$9.99/mo** (monthly only) | $0 |
| Free trial | none | — | — |

- **No daily-interview cap** (removed 2026-08-25): creation is unlimited; the per-interview chat-turn
  cap is the only gate. No token counting (2026-08-23 decision) — count turns, not tokens.
- Limits are env-overridable (`.env.example`). **`dev` tier** (only for developers, never prod): the
  no-Clerk dev-fallback identity (`CLERK_ENABLED=false`) resolves to `dev` with caps above premium;
  confines to dev/test and never persists in `subscriptions` (details in PLAN D10).
- **Feedback not feature-gated** — same quality across tiers. Turn cap is the cost-control lever.
- Billing **monthly only**, single-user (D4). Stripe handles tax (no merchant-of-record).

## 1. The `tier` claim & its source of truth (entitlement)

- **Entitlement (`tier`)** ∈ `{"free", "premium"}` (+ `"dev"` for the no-Clerk dev-fallback
  identity, see §0). Source of truth at runtime is `ClerkUser.tier` (JWT claim), **merged with an
  active `premium` row in the `subscriptions` table** so billing can elevate even when the JWT is
  stale. Implemented in `app/billing.py::resolve_tier`.
- **Consumption (the per-interview turn counter) is NOT in the JWT** — it's counted from
  `interviews.chat_turns`, server-side per owner (D4).

## 2. Enforcement (backend-authoritative; frontend is UX only)

Implemented in `app/billing.py` + `app/main.py`.

- **No daily-interview cap** (removed 2026-08-25): `POST /interviews` does a plain INSERT — every
  owner can create unlimited interviews. Overage lockout applies to chat turns only.
- **Per-interview chat-turn cap** on `POST /interviews/{id}/chat/stream`: checks
  `interviews.chat_turns < limit`, then `bump_chat_turn`. Over → **`402 Payment Required`**.
  Caps: free 8, premium 100, dev 500.
- **Overage → lockout:** block new turns only. **Never delete, truncate, or hide existing
  user data** — reads stay fully available. Hard rule.
- **No free trial.** Upgrade is a hard gate.
- **Cache decision:** no cache-aside for the counters (DB-backed, per-user, low-frequency). `tier`
  cached in the JWT; JWKS cached in `auth.py`.
- **Usage status (`GET /usage`):** returns `tier` and the tier's `chat_turns` limit
  (`chat_turns_per_interview_<tier>`). The frontend `/app` header shows a **Free / Premium / DEV
  tier label** (`UsageBadge`). `dev` is returned by the no-Clerk dev-fallback identity (see §0).


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

**Frontend M10 UX (shipped 2026-08-24, UI only):** the header tier labels (`UsageBadge` → **Free / Premium** + **`DEV`** when no Clerk key; `GET /usage`) and the lockout/upsell notice (`UpgradeNotice` on 402 — links to `POST /billing/checkout` and `POST /billing/portal`) are in the SPA. They are wired and correct, but **end-to-end payment cannot be exercised until the Stripe keys + live Clerk path exist.**

**Deferred (needs Stripe keys / live Clerk):** a **dedicated billing/plan page** and real payment testing (Stripe CLI `listen` for local webhooks → subscribe → webhook → `resolve_tier` → tier flip → cancel/downgrade). Building the page before those are verified is speculative UI against an unverifiable contract (YAGNI) — the existing upsell/usage UX is enough until then. Until live, `subscriptions` rows can be created directly for testing/promo and `resolve_tier` honors them.
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

-- per-interview chat-turn counter (free-tier cap; no token metering)
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS chat_turns INTEGER NOT NULL DEFAULT 0;
```

> **No `usage` / `tokens_used` tables** — token metering was intentionally dropped for the turn-based
> model (decision 2026-08-23). Reintroduce only if LLM cost accounting is required later.

## 5. M10 handoff

| Shipped (2026-08-24) | Deferred |
|---|---|
| `app/billing.py` — tiers, quotas, `resolve_tier` | Stripe keys / Stripe CLI local webhook testing |
| Chat-turn cap (free/premium/dev) — **`dev` tier + no-daily-cap shipped 2026-08-25** | Dedicated billing/plan page |
| `GET /usage` (tier + chat turns; no daily fields) — **shipped 2026-08-25** | Live Clerk billing (`CLERK_ENABLED=true`) + JWT `tier` template |

| Frontend upsell/lock UX + usage badge (`UsageBadge`/`UpgradeNotice`) — **shipped 2026-08-24** | — |
| `app/payments.py` — raw Stripe checkout / portal / webhook | Real payment testing (needs `sk_test_`/`whsec_`) |
| `subscriptions` + `chat_turns` migration | — |
| `ClerkUser.tier` seam + `resolve_tier` | — |

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
