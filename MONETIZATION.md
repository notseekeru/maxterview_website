# MONETIZATION — payment & billing

**Shipped (M10).** Quota backend + **PayMongo** (PHP-only, ₱99, one-time payment). **The shipping rail
is `BILLING_MODE=period`** — one payment buys 30 days — because PayMongo enables Subscriptions only by
hand (§4); provider-managed recurring stays implemented and dormant behind that one env var.
Decisions: PLAN D10 (owner-scoping is a hard rule).

## 0. Limits & model (env-configurable, not hardcoded)

|                                           | Free                       | Premium                         | dev                              |
| ----------------------------------------- | -------------------------- | ------------------------------- | -------------------------------- |
| Interviews (creation)                     | **unlimited**              | **unlimited**                   | **unlimited**                    |
| Resumes kept                              | **1** (`FREE_RESUMES`)     | **10** (`PREMIUM_RESUMES`)      | **10** (`DEV_RESUMES`)           |
| Review redos / run                        | **1** (`FREE_REDOS`)       | **10** (`PREMIUM_REDOS`)        | **10** (`DEV_REDOS`)             |
| Price                                     | ₱0                         | **₱99 / 30 days** (one payment) | ₱0                               |
| Chat turns / day (GLOBAL, all interviews) | **30** (`FREE_CHAT_TURNS`) | **300** (`PREMIUM_CHAT_TURNS`)  | **100000000** (`DEV_CHAT_TURNS`) |
| Interview turn model                      | `LLM_MODEL`                | `LLM_PRO_MODEL` (`LLM_PRO_*`)   | `LLM_MODEL`                      |

- The gate is a **global daily credit per owner** spanning ALL their interviews in one UTC day, reset
  at 00:00 UTC. No per-interview cap, no daily-interview cap, no free trial. Count **turns, not
  tokens** (2026-08-23 decision) — token tables were deliberately dropped.
- The resume cap is **storage, not a meter**: importing one spends nothing (parsing is local CPU), so
  it is counted at INSERT and never decremented. At the cap a free owner gets `402` and a paid one
  `409`, which is the difference between an upsell and a wall.
- Review redos are **per RUN, not per day** (`feedback.redos`): the allowance belongs to the run it
  rewrites. `POST /interviews/{id}/feedback/generate` charges one **only when it produced a review**, so
  a model outage never spends it, and the first review (`/finish`) is never a redo.
- Limits are env-overridable (`backend/.env.example`). The **`dev` tier** is for developers only and
  never persists in `subscriptions`; it is what the no-Clerk fallback identity resolves to.
- **One free→premium factor across every metered cap** (turns, resumes, redos). The Pro card on
  `/settings/billing` quotes that factor (`BillingPage`), so a retune that moves one cap alone makes it
  a lie.
- **Feedback is not feature-gated** — same quality across tiers. The turn cap is the cost lever.
  The up-tier is the interview turn only (`LLM_PRO_MODEL`, empty = every tier on `LLM_MODEL`); the
  grader and formatter stay shared, so a review never depends on what the owner paid.
- Billing is **one payment at a time**, single-user: period mode sells 30 days and does not
  auto-renew. PayMongo bills in PHP only; we handle tax (no merchant-of-record).

## 1. The `tier` claim & its source of truth

- **Entitlement** ∈ `{"free", "premium"}` (+ `"dev"` for the no-Clerk fallback). `premium` is the
  internal value only (DB column, JWT claim, PayMongo plan name); user-facing copy calls that tier
  **Pro** (`frontend/src/lib/plans.ts`). Runtime source of
  truth is `ClerkUser.tier` (JWT claim) **merged with an active `premium` row in `subscriptions`**,
  so billing can elevate even when the JWT is stale — `billing.py::resolve_tier`.
- **Consumption is NOT in the JWT**: the daily global turn counter is read from `turn_usage`,
  server-side per `(owner_id, UTC day)`.

## 2. Enforcement (`billing.py` + `main.py`)

- **No per-interview or daily-interview cap**: `POST /interviews` is a plain INSERT.
- **Daily global chat-turn cap, one credit per MODEL turn**: `POST /interviews/{id}/chat/opening`
  (the generated opener), `POST /interviews/{id}/chat/send` (each reply, plus the generated sign-off
  that ends the arc). Both check `turns_used(today) < limit` against `turn_usage` before the call,
  then upsert +1. Over → **`402`**, which may happen mid-interview once the owner burns today's
  credits across ALL their interviews. The review is deliberately NOT metered: `POST /interviews/{id}/finish`
  runs the whole feedback pipeline (grader, formatter, per-turn annotator) without spending a credit.
  Rebuilding it IS metered (`/feedback/generate`, §0 redos).
- **Overage → lockout:** block new turns only. **Never delete, truncate, or hide existing user
  data** — reads stay fully available. Hard rule.
- **No cache-aside** for the counters (DB-backed, per-user, low-frequency). `tier` is cached in the
  JWT; JWKS in `auth.py`.
- **`GET /billing/usage`** returns `tier`, the EFFECTIVE cap (`chat_turns_per_day_<tier>`),
  `chat_turns_used_today` / `chat_turns_remaining_today`, plus `billing_mode` and `premium_until`
  (period mode has no renewal for the UI to infer an
  expiry from, so the server states it). The account menu shows the tier and the day's turns via `UsageBadge`, read when it is opened.

## 3. Provider — PayMongo (period top-up shipped; subscriptions dormant)

Implementation is **raw httpx against PayMongo** (`app/paymongo.py`, chosen over Xendit — see §4).
Both modes write the **same** `subscriptions` row and are read by the same `billing.resolve_tier`, so
the mode is a payment rail, not an entitlement model. Paths below are relative to the app's `/api`
prefix (`curl localhost:8000/api/billing/checkout`).

- **`POST /billing/checkout`** — **mode-blind**: `paymongo.start_checkout` dispatches on `BILLING_MODE`.
  The customer's email comes from `auth.user_email`: the JWT claim if the instance puts one there,
  otherwise Clerk's Backend API (`CLERK_SECRET_KEY`). Clerk's default session token carries **no**
  `email` claim, so without the lookup every checkout is a **409** before any provider call.
  - **`period` (default, launch)** — creates a Customer (PayMongo now **requires `default_device`**;
    we send `email`), a one-time Payment Intent for `PREMIUM_PRICE_CENTAVOS`, attaches a `qrph`
    PaymentMethod and answers **`{"qr": {image_url, expires_at}}`** (a redirect method answers
    `{"url": …}`). The row is written `premium/incomplete` **before** that artifact reaches the
    browser, holding the intent id in `provider_subscription_id` — the column the webhook resolves
    an owner from, so **no migration**. Needs no account capability; nothing renews, so the user
    buys again.
  - **`subscription` (dormant)** — subscription + first-invoice Payment Intent → Maya; later cycles
    are charged by PayMongo from the vaulted method.
  - **A second purchase is never a second charge.** A live paid period is refused outright, and a
    pending payment that is STILL payable is served again instead of refused: period mode asks the
    provider about the stored intent (`paymongo._resume_or_block`), because closing the popup or
    reloading must not strand the buyer for the code's whole life. A dead code frees the row, an
    intent already `succeeded` is credited, and one being processed is refused for that moment.
    Subscription mode keeps PayMongo's 24h first-payment window (`paymongo._resubscribe_block`).
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

**Register the prod webhook** (the endpoint is not self-service). The script subscribes
`payment.paid` plus both refund types, and an endpoint that already exists for that URL is **updated
in place** (`PUT`), which is how a deployment that only had `payment.paid` picks up refund
revocation:

```bash
./.pi/skills/paymongo-operator/scripts/payments.sh --register-webhook --url=https://maxterview.seekeru.tech/api/billing/webhook
# then set its secret + the API key in Infisical (TF_VAR_MAXTERVIEW_PAYMONGO_*), then apply
```

**Event → entitlement map.** Period mode: `payment.paid` (the API accepts `payment_intent.succeeded`
only on accounts that emit it — this one refuses to register it as `parameter_invalid`, so the
handler's second accepted type only ever arrives via `/webhook/simulate`) sets
`plan=premium, status=active, current_period_end = now() + PREMIUM_PERIOD_DAYS` as a
**compare-and-set** on `provider_subscription_id = <intent id> AND status = 'incomplete'`, so a
replay, the sibling event type or a PayMongo retry cannot buy a second period; a refused write logs
`paymongo.webhook.payment_not_credited`. `payment.failed` writes nothing. **Refunds revoke:**
`payment.refunded` (or `payment.refund.updated` once the refund reads `succeeded`) resolves the owner
through whatever the payload carries — intent, or payment read back for it — and flips the row to
`free`/`refunded`; an event it cannot attribute is logged (`paymongo.webhook.unattributable_refund`)
and writes nothing (§5). Subscription mode:
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
monthly invoice is under USD 50. At ₱99/cycle the ₱11 processing fee alone is 11% of revenue, and the
floor needs ~₱2,900/month of billing (≈30 subscribers) to clear. It
also requires a registered entity and authenticates webhooks with a static `x-callback-token`
instead of an HMAC over the raw body.

**PayMongo — chosen.** No setup fee, no monthly minimum, cards 3.125% + ₱13.39, Maya 1.79%, GCash
2.23%, QR Ph 1.34%, and correctly signed webhooks. Accepted trade-offs: Subscriptions + Card Vaulting
are enabled by support (not self-service), recurring covers cards and Maya only, and there is no
billing portal — we own cancel.

**Period mode is the launch rail (2026-09-15).** Every subscription-path call 403s with
`merchant_invalid_state: no subscription payment methods are configured for this organization` —
including `POST /v1/subscriptions/plans`, so even plan creation is blocked, and the same 403 answers
in **live** mode (not just test). Read literally, the detail says the capability is missing because no
payment methods are configured for subscriptions, so it is downstream of the rejected e-wallets below.
A one-time Payment Intent
needs no account capability, so `BILLING_MODE=period` turns money into the **same** entitlement
(`current_period_end`) with zero changes to `billing.py`, the quota model, `/billing/usage`, the schema or the
DB. Accepted: no auto-renew (the billing page states the expiry; `PAYMONGO_PLAN_ID` is no longer
needed to launch). Revisit if support ever enables Subscriptions: `BILLING_MODE=subscription`,
nothing else. (Support email: support@paymongo.com; Fully Verified needs DTI + BIR 2303 for a PH sole
proprietorship.)

**Method availability is per ACCOUNT, and the live account is narrow (measured 2026-09-26).**
`POST /v1/payment_methods` in live mode answers `payment_method_not_allowed` for `paymaya`, `gcash`,
`grab_pay`, `billease` and "not configured yet" for `shopee_pay`; `qrph` succeeds and `card` is
enabled (it only demands card details, i.e. a PCI-scoped form we deliberately do not have). Test mode
allows `paymaya`, which is why every rehearsal passes: **check `PERIOD_METHODS` against the live key
before a release, never in test mode**. The earlier claim that "Maya works on an individual account"
was wrong for live mode.

**The launch rail is QR Ph, drawn in the page (2026-09-26).** Support states the account is an
**Individual with QR Ph already active**, and that Maya needs Settings → Business Information
(business name, TIN, business address, industry), a Payment Methods request and a support request
before Subscriptions does — i.e. a registered entity. So `PERIOD_METHODS = ("qrph",)`: create the
one-time intent, attach it, and answer the browser `{"qr": {image_url, expires_at}}`, which
`QrCheckout.tsx` renders with a countdown to the provider's own deadline (30 min). QR Ph has no
return URL, so the modal polls `/billing/usage` instead. Two knock-ons worth keeping: the pending row is now
released by the **provider's own intent status** rather than the 24h subscription window (an
abandoned code cannot lock the retry out for a day, and an intent already `succeeded` is credited
rather than sold again), and an expired code just means the next checkout creates a fresh intent.
Cards stay out of scope: enabled on the account, but they need both KYB and a PCI-scoped card form.
Rehearsal: `.pi/skills/paymongo-operator/scripts/payments.sh --create-period` — test mode prints the
`test_url` that completes the payment without a wallet.

**Verified live 2026-09-27.** One real ₱99 QR Ph payment on that Individual account, end to end: the
live key accepted `qrph`, the intent was created and attached, prod logged the PayMongo calls as 200,
`POST /api/billing/webhook` answered `200` (a bad signature would be 400), and the tier flipped to
premium for 30 days with `premium_until` set. So no KYB is needed to take money: "live keys need a
Fully Verified account" was wrong for this rail, and DTI + BIR 2303 only unlock the e-wallets, cards
and Subscriptions.

**Global/USD later.** PayMongo is PHP-only and PH-rail-only, so USD pricing needs a merchant-of-record
(Paddle / Lemon Squeezy / Polar: they remit VAT and pay out to an unregistered PH individual — the only
option before DTI/BIR exists). The seam is `paymongo.py` plus the `subscriptions.provider*` columns:
a second module, not a rewrite.

## 5. Cancellation & billing terms

- **Cancellation → access till end of the current paid period, no refunds.**
- **Refund: 3-day voluntary window** (2026-08-16); after 3 days, none voluntarily.
- **A refund revokes immediately.** The app never calls the refunds API — a QR Ph payment cannot be
  refunded through it at all (`Refunds are not allowed for payments with source type qrph`, verified
  2026-09-27), so the merchant refunds from the PayMongo dashboard, which needs a funded balance (a
  refund right after a payment is held while settlement is still scheduled). That refund should arrive
  as `payment.refunded`, and the write ends premium on the spot: status `refunded`, absent from
  `billing.ENTITLED_STATUSES`. `payment.refund.updated` is status churn, so it revokes only once the
  refund reads `succeeded` — a held or failed refund keeps serving. A refund that never produced an
  event is revoked with `revoke.sh`.
  **Unobserved:** no QR Ph payment can be refunded through the API, so no test run can produce this
  event — the name comes from the account's accepted registration list and the payload shape from the
  docs. The handler therefore takes the intent from the payload, or reads the refund/payment back for
  it, and the first real refund shows up as either `paymongo.webhook.revoke` or
  `paymongo.webhook.unattributable_refund` in the logs.
- **Period mode has no renewal, so nothing "fails":** the period lapses at `current_period_end` and
  `resolve_tier` downgrades on the next read. `/billing/cancel` only marks the row `cancelled`, keeping
  the paid time.
- **Chargebacks/disputes apply to one-time payments, and this account has no dispute signal:**
  `dispute.created|resolved` are refused at webhook registration as invalid event types and
  `GET /v1/disputes` answers `access_denied` (2026-09-27), so a dispute is seen in the PayMongo
  dashboard and revoked by hand — `revoke.sh --intent=pi_… --status=disputed --admin-destroy` — then
  answered through PayMongo's dispute flow. Both revocation statuses are dead ends for entitlement,
  not bans: the next purchase overwrites the row.
- **Failed renewal / card declined: immediate downgrade, no grace.**
- **Stale-JWT holes:** on downgrade, consult the server-side `subscriptions` row (recommended —
  `resolve_tier` already does, and no session token carries a `tier` claim today: `auth.verify_jwt`
  never sets one, so a revocation lands on the NEXT request; wiring that claim would reintroduce the
  staleness). On upgrade, Clerk must force a JWT refresh so "I paid and it didn't unlock" doesn't
  become a support ticket.

## 6. Frontend

Account-menu tier and turn count (`UsageBadge`), lockout/upsell notice (`UpgradeNotice` on 402), and a
billing/plan page (`/settings/billing`) with Free vs Pro cards, current-plan summary, an
Upgrade CTA, and in-app **Cancel**. QR Ph has no return URL: `QrCheckout` draws the code beside a
countdown and polls `/billing/usage` until the webhook flips the tier. A redirect rail would land on
`/dashboard?upgrade=pending`, where `UpgradePendingNotice` runs the same poll, because a return URL
alone is not proof of payment.
