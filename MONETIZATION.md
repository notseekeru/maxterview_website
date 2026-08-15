# MONETIZATION — Payment & Billing Plan (phase 2)

> **Simple two-tier model: Free / Premium.** This file is the detailed design for **M10** — a
> phase-2 milestone, **NOT part of the MVP**. The MVP ships only the forward-compat seam:
> `ClerkUser.tier` (default `"free"`). Everything here is designed-for, built later.
> **Source of truth for decisions:** PLAN.md D10 (and D4 for owner-scoping).

## 0. Budget numbers (placeholders — REVISE after M6 LLM cost data)

These are **placeholder defaults** chosen 2026-08-16 so the plan has concrete values. **Revisit and
retune once the M6 LLM layer lets us measure real per-interview cost.** Actual values live as env/config
at M10, not hardcoded.

| Metric | Free | Premium |
|---|---|---|
| Daily interview cap | 1 | unlimited |
| Daily LLM token budget | **20,000** (tight) | **100,000** (generous) |
| Per-interview ceiling | **5,000** | **50,000** |

- **Meter unit = total tokens (input + output)** across all LLM calls for an interview (incl. regens).
- If LLM cost confirms these are off (e.g. an average premium interview routinely exceeds 50k), adjust
  the numbers before enabling billing.

## 1. Model: Free vs. Premium

| | Free | Premium |
|---|---|---|
| Interviews | **1 per day** (daily count, resets at UTC midnight) | **unlimited** |
| **LLM token budget** | **tight** (small daily token cap) | **generous** (high cap — interviews unlimited, still token-bounded) |
| Price | $0 | **$9.99 / month** (monthly billing only) |
| Free trial | **none** | — |

- Two tiers only. Gated resources: **1 interview/day** on free AND a per-tier **LLM token budget**.
- **Feedback is NOT feature-gated by tier** — both tiers get the same feedback quality, but both are
  bounded by their token budget to prevent LLM cost abuse (free = tight, premium = generous but not
  truly unlimited). Token limit is the cost-control lever on BOTH tiers; premium is just less constraining.
- Billing: **monthly only** (no annual). Single-user only (no teams/orgs — D4 owner-scoping).
- No invoice/tax features in scope (Stripe handles tax; no merchant-of-record requirement).
- **Decided 2026-08-11.**

## 2. The `tier` claim & its source of truth (entitlement vs. consumption)

- **Entitlement (`tier`) in the JWT** — `ClerkUser.tier` ∈ `{"free", "premium"}`, stamped into the
  Clerk JWT (`app/models.py`). Changes rarely (on payment), so it's safe to cache in the token.
  **Source:** Clerk's billing integration stamps custom metadata, or a custom claim via a Clerk JWT
  template. Mechanism settled at M10.
- **Consumption (token spend) is NOT in the JWT.** A JWT is a stale snapshot and cannot track a live
  spend counter. **Token spend is metered server-side in a DB `usage` table**, looked up per request
  (per owner, per day). This is mandatory for reliable metering (D10: server-side usage counter).
  Requires a `usage` migration at M10 — a real schema need, not optional.

## 3. Enforcement (backend-authoritative; frontend is UX only)

- **Backend (authoritative):** a `require_tier`/quota dependency, checked on `POST /interviews` *before*
  creating an interview.
  - **Free cap:** 1 interview in the current UTC day → else `402 Payment Required (or 403)`.
    - **Counts CREATED interviews** (any started interview consumes the daily slot; abandoned ones count).
  - **Premium:** unlimited interview creation.
  - **Atomicity (2026-08-11, races):** the cap check must be **atomic**, not read-then-write — two
    concurrent requests must not both pass. Enforce via a **conditional INSERT**:
    `INSERT ... WHERE NOT EXISTS (SELECT 1 FROM interviews WHERE owner_id=$1 AND created_at::date=CURRENT_DATE)`.
    Postgres row-level atomicity guarantees at most one succeeds.
  - **Token metering idempotent (2026-08-11, retries):** a failed/timeout LLM call that is **retried**
    must NOT double-bill. Meter increments must be **idempotent** — scope the meter write to
    **`messages.id`** (each generation writes exactly one `messages` row, which already has a unique
    `id`) so a retried generation records spend once. No new idempotency column is needed.
  - **Per-tier LLM token budget (BOTH tiers):** metered in a server-side `usage` table (not the JWT).
    - **Per-interview ceiling** (cumulative across ALL LLM calls for that interview, **including
      regens/retries**) PLUS **daily budget** (cumulative per UTC day; free tight, premium generous).
    - **Token count = INPUT + OUTPUT tokens** (the real LLM cost — input is the expensive re-sent
      context, so it must be counted, not just output).
    - **Atomic meter increment (5th audit):** use an **UPSERT**, not a bare `UPDATE` — a bare `UPDATE`
      matches zero rows on a user's first call of the day and silently skips metering. Correct pattern:
      `INSERT INTO usage (owner_id, day, tokens_used) VALUES ($1, CURRENT_DATE, $n)
       ON CONFLICT (owner_id, day) DO UPDATE SET tokens_used = usage.tokens_used + EXCLUDED.tokens_used
       RETURNING tokens_used`;
      reject if the result exceeds the budget. (`RETURNING` → use `db.fetchrow`.) Atomic upsert prevents
      concurrent over-spend AND covers the first-entry-of-the-day case.
    - **Pre-start floor:** before starting an interview, check the remaining daily budget is non-trivial
      (a cheap guard only). **The AUTHORITATIVE gate is at each LLM call**, where actual input+output
      spend is known — check remaining budget per generation and cap the context sent. Input cost is
      unknowable pre-start (it grows with the transcript), so pre-start alone cannot protect the budget.
    - Per-interview ceiling is stored as **`tokens_used` on the `interviews` row** (§5); the daily total
      in `usage`. Both are consulted at each LLM call.
    - Meter is looked up at each interview/LLM call. (Metering finalized at M10 with LLM layer, M6.)
- **Feature set (2026-08-11):** roles/topics/features are **IDENTICAL across tiers** — tier only changes
  the interview daily count and the token budget. No per-tier feature gating.
- **Cache decision (2026-08-11):** No cache-aside for metering at MVP scale — the counter lookups
  are per-user, low-frequency, and indexed; caching them would risk losing spend on crash (billing
  accuracy > latency here). `tier` is already cached in the JWT (entitlement). JWKS already cached
  in `auth.py`. **If metering ever becomes a real bottleneck, add cache-aside (Redis) — but use a
  WRITE-THROUGH counter so spend is never lost. Deferred unless a load test justifies it.**
- **Ops safeguard (5th audit):** add a **global spend kill-switch / hard cap** at M10 (a ceiling on
  total LLM spend across all users, and a manual off-switch) in case of a runaway feature, bug, or
  abuse spike. Non-structural, cheap — recommended for ops safety.
- **Overage → lockout:** on hitting the cap, **block new interview creation only**. **Never delete,
  truncate, or hide existing user data** — reads stay fully available. This is a hard rule.
- **No free trial.** Upgrade is a hard gate from day one.
- **Counter source:** count `interviews` where `owner_id` (D4) and `created_at::date = CURRENT_DATE`.
  Uses existing columns. The token budget needs a NEW `usage` table at M10 (§5).
- **Frontend (UX only):** show a "lock"/upsell on premium. Never the actual gate.
- **Usage status (2026-08-16):** expose a cheap **`GET /usage`** endpoint returning remaining daily
  interviews + remaining tokens for the current user (scoped by `owner_id`, D4). Frontend shows a
  small badge/notice (e.g. "2 of 3 free interviews left today"). Prevents silent lockout. Lands with
  M10 (no quota/entitlement distinction to display during the dev-fallback MVP).
- **MVP scope (Nit 3, 2026-08-11):** during MVP (M5–M9) the backend runs on the dev-fallback
  `DEV_USER`, so there's no real free/premium distinction and **no premium upsell/lock UX is built
  in the MVP**. Upsell UI lands with M10 billing.
- **MVP stub:** M5 routes carry `ClerkUser.tier` but the gate is **stubbed** (no enforcement) until M10.

## 4. Billing provider (M10)

Preferred: **Stripe** via **Clerk's billing integration** (`clerk-billing` / Clerk ↔ Stripe).

- Clerk manages the subscription/checkout/billing-portal UX and stamps `tier` (+ plan) into the JWT —
  no custom Stripe webhook plumbing on our side for entitlement.
- **Monthly billing only** (one premium plan at $9.99/mo; no annual, no tiers of premium products).
- **Currency (2026-08-11): MULTI-CURRENCY.** $9.99 is the reference price; Stripe handles conversion/
  local pricing. Adds per-currency price config at M10 (not a blocker — settled at billing setup).
- **Tax (2026-08-16):** Stripe **calculates** tax, but **we remit** it (our legal responsibility).
  No merchant-of-record (Lemon Squeezy/Paddle) at MVP scale.
- **No invoice/tax/product features in scope** — Stripe's built-in tax handling is sufficient; no
  merchant-of-record (Lemon Squeezy/Paddle) needed at MVP scale.
- Requires: Stripe account, a Clerk plan with the billing integration enabled, publishable/secret
  keys in prod Secret. URL/keys are the user's ops concern (zero-touch on credentials).

## 5. Phase-2 schema (M10 migration, not MVP)

Additive migrations when billing ships (NOT in `0001_init.sql`).

**Per-interview token spend:** a new column on the existing `interviews` table (used with the daily
`usage` counter to enforce the per-interview ceiling at each LLM call):

```sql
-- NEW (M10) — per-interview cumulative token spend (for the per-interview ceiling)
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS tokens_used BIGINT NOT NULL DEFAULT 0;
```

New tables:

```sql
-- NEW (M10) — subscriptions / entitlement
CREATE TABLE IF NOT EXISTS subscriptions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id      TEXT NOT NULL UNIQUE,        -- Clerk sub (D4)
    stripe_id     TEXT NOT NULL,
    plan          TEXT NOT NULL,               -- 'free' | 'premium'
    status        TEXT NOT NULL,               -- active | past_due | canceled
    current_period_end TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- NEW (M10) — token usage counter (server-side meter, per owner per day)
CREATE TABLE IF NOT EXISTS usage (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_id      TEXT NOT NULL,               -- Clerk sub (D4)
    day           DATE NOT NULL DEFAULT CURRENT_DATE,
    tokens_used   BIGINT NOT NULL DEFAULT 0,
    UNIQUE (owner_id, day)
);

-- NEW (M10) — cancellation: access till end of paid period; no refunds.
-- Implemented via status/cancel date on subscriptions; lockout enforced at next period.
```

> **Note (2026-08-11):** the daily interview count (`interviews.created_at::date`) and the daily token
> meter (`usage.day`) are two separate counters that can drift across a UTC-midnight boundary
> (e.g. an interview at 23:59 lands tokens on the next day's `usage` row). Acceptable at MVP scale;
> keep them in mind if strict day-alignment matters later.
>
> **Note (2026-08-11):** `usage` grows one row per user per day indefinitely. Prune old rows (e.g.
> > 90 days) periodically. Trivial at MVP scale; noted to avoid unbounded growth.

(Exact shapes finalized at M10. Not created now — YAGNI until the engine is real.)

## 6. MVP → M10 handoff (what we leave ready)

| Already done (MVP) | Deferred (M10) |
|---|---|
| `ClerkUser.tier` (default `"free"`) | Stripe/Clerk-billing integration + keys (monthly $9.99) |
| M5 routes carry `tier` (no enforcement) | `require_tier` daily-cap check on `POST /interviews` + per-interview/daily token budget |
| Interviews table already scoped to `owner_id` | `subscriptions` + `usage` migrations |
| `MONETIZATION.md` as the frozen spec | JWT template that stamps `tier`; real provider config |

## 7. Cancellation & billing terms (M10)

- **Cancellation → access till end of the current paid period, no refunds.** (Cancel honors the paid
  period — the user keeps premium access + token budget until `current_period_end`.)
- **Refund (2026-08-16): 3-day refund policy.** A customer can request a voluntary refund within
  3 days of purchase. After 3 days, no voluntary refunds (cancel still honors remaining paid period).
- **Chargebacks/disputes (2026-08-16):** separate from refunds — a chargeback goes through the
  customer's bank, not us. On a chargeback/dispute: **downgrade the user to free immediately** and
  respond via Stripe's dispute flow (evidence = subscription started + access granted). A "no refunds"
  or "3-day refund" policy does NOT stop chargebacks — it only governs *our* voluntary refunds.
- **Failed renewal / card declined (2026-08-11): IMMEDIATE downgrade — no grace period.** On failed
  payment, premium access (and its token budget) is revoked; account drops to free and daily-cap
  lockout applies at once. **Why the contrast:** a *cancel* has a paid period to honor; a *failed
  renewal* has none — there is no paid time remaining, so access ends immediately. (Deliberate:
  simpler than a grace/retry window; multi-currency adds no special handling here.)
- Enforced by `status`/cancel-date on `subscriptions`: premium access (and its token budget) continues
  until `current_period_end`; after that the account drops to free and daily-cap lockout applies.
- Closing the stale-JWT revenue holes: at period end, the JWT `tier` must no longer grant premium access.
  Because the JWT is cached, M10 must either (a) refresh/stamp the JWT on downgrade, or (b) consult the
  server-side `subscriptions`/`usage` state for the *consumption* path (recommended — the usage meter
  is already a DB lookup, so entitlement can ride the same check).
- **Upgrade mirror hole:** on upgrade, Clerk billing MUST force a JWT refresh (or we accept a short
  window where a newly-premium user is still `free` and locked at 1/day). State this explicitly so
  "I paid and it didn't unlock" doesn't become a support ticket.
