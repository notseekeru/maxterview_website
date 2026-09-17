---
name: paymongo-operator
description: >-
  Operates the real (test-mode) Clerk and PayMongo accounts for maxterview so the user never has to
  open the Clerk or PayMongo dashboards to configure, inspect, seed, or reset the auth/billing
  sandbox. Lets an agent (pi or similar), or a human, read/create real test state, mint a Clerk
  testing session so a browser authenticates as a throwaway user, take a real one-time payment
  (the shipping period-mode rail), deliver signed (or simulated) webhook events, and prove the
  entitlement flip in the backend (chat quotas / premium tier). Also holds the verdict on PayMongo's
  MCP server (there isn't a usable one — this skill IS the agent surface) and on Subscriptions
  (blocked by an account-level capability). Load when the user wants to set up, debug, or reset
  Clerk+PayMongo test state for maxterview, or to run the real pay -> webhook -> tier journey
  without visiting paymongo.com or clerk.com.
---

# Clerk + PayMongo operator (maxterview)

Full administrative read/write over the **test-mode** Clerk and PayMongo accounts behind the
maxterview monorepo, through their APIs and env vars. Purpose: let an AI (and the repo owner)
configure, inspect, seed, and tear down sandbox state **without opening a dashboard**, and prove the
real subscription lifecycle end-to-end.

> **Security is load-bearing.** This skill reaches a live Clerk `sk_test_` and a live PayMongo
> `sk_test_` + webhook secret. They are real accounts. Never echo them, never commit them, never log
> them, never send them anywhere. See [Zero-touch + guardrails](#zero-touch--guardrails).

---

## 1. What actually works right now (read this before promising anything)

| Keys present | You can do | You cannot do |
| --- | --- | --- |
| none (`backend/.env` empty) | Full dev proof: `/api/billing/webhook/simulate` (dev/test only) drives `subscriptions` → `resolve_tier` → `/api/usage`. Works offline, no tunnel, no keys. | Touch PayMongo at all. |
| `PAYMONGO_SECRET_KEY` (test) | **Everything the launch mode needs**: Customer, one-time Payment Intent, Maya redirect, webhooks, refunds — `payments.sh`. | Take real money (live keys need a Fully Verified account). **Subscriptions** — the account-level `Subscriptions` capability is off, so `POST /v1/subscriptions` and even `POST /v1/subscriptions/plans` return **403 `merchant_invalid_state`** ("no subscription payment methods are configured for this organization"). |
| live keys | Real ₱499 billing. | — |

**Two PayMongo account-level features are NOT self-service**: **Subscriptions** and **Card Vaulting** —
both need `support@paymongo.com`, and "All subscription activations are manually requested — no
self-service flow is available" (docs: Account capabilities). This is why the product ships
`BILLING_MODE=period` (one-time payment → 30 days of premium) and not provider-managed recurring.
The 403 above is the gate, not a code bug — do not debug the client first.

Live-mode reach is also narrower than it looks: on an **individual** account only **Maya, GrabPay and
ShopeePay** can be requested; **Cards need a registered business type**. Period mode therefore assumes
Maya (`PERIOD_METHODS`), which is exactly the rail `payments.sh --create-period` attaches.

---

## 2. Where keys and state live

- `backend/.env` (git-ignored) is the runtime source: `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`,
  `FRONTEND_BASE_URL`, `BILLING_MODE`, `PREMIUM_PRICE_CENTAVOS`, `PREMIUM_PERIOD_DAYS`, plus `CLERK_*`
  and quotas. `PAYMONGO_PLAN_ID` is **subscription mode only**.
- The scripts load it via `scripts/_env.sh`, which exports **names only** — it never prints a value.
  Process env wins over the file, matching compose semantics.
- Entitlement state is the `subscriptions` row (owner_id → provider ids, `plan`, `status`,
  `current_period_end`). `billing.resolve_tier` is the only reader; `payments.py` is the only writer.
- `status` is the entitlement lever: `active`/`cancelled` are entitled **only until
  `current_period_end`**; `past_due`/`unpaid` are not entitled at all (MONETIZATION §6: a failed
  renewal revokes immediately, a cancellation keeps the already-paid period).

---

## 3. Key liveness (never prints values)

```bash
./.pi/skills/paymongo-operator/scripts/need-keys.sh
```

Reports set / missing / present-but-LIVE for every var, and prints a paste-me template for the gaps.
Live keys are refused by every script in this skill.

---

## 4. The dev proof (no keys, no tunnel, always available)

PayMongo has **no CLI equivalent to `stripe listen`**, and requiring a tunnel for local webhooks is
friction we skip. `POST /api/billing/webhook/simulate` (404s unless `APP_ENV` is `development`/`test`)
runs the exact handler the signed endpoint runs:

```bash
# premium flip
curl -sS -X POST localhost:8000/api/billing/webhook/simulate -H 'Content-Type: application/json' -d '{
  "data":{"type":"subscription.activated","livemode":false,"data":{"id":"subs_demo","type":"subscription",
  "attributes":{"id":"subs_demo","customer_id":"cus_demo","plan_id":"plan_demo","status":"active",
  "next_billing_schedule":"2026-10-14"}}}}'

./.pi/skills/paymongo-operator/scripts/debug-state.sh   # → plan/status/current_period_end
```

A subscription event only lands when the owner can be resolved, so seed the row first
(`INSERT INTO subscriptions (owner_id, provider_customer_id) VALUES ('dev-user','cus_demo')`) — that
is exactly the state `start_subscription` leaves behind before the redirect.

To exercise the **real** HMAC path (`Paymongo-Signature`, not the simulate shortcut):

```bash
./.pi/skills/paymongo-operator/scripts/webhook-driver.sh --event=subscription.activated --customer=cus_demo
```

---

## 5. Correct ordering of the real billing journey (needs test keys)

### Period mode — the shipping rail (`BILLING_MODE=period`, the default)

1. **App-side start** — `POST /api/billing/checkout` as the signed-in user. It creates the Customer
   (note: `POST /v1/customers` now **requires `default_device`**, `"email"` here), a one-time
   Payment Intent for `PREMIUM_PRICE_CENTAVOS`, then attaches a `paymaya` PaymentMethod and returns
   the Maya URL. The `subscriptions` row is written as `premium/incomplete` **before** the redirect,
   holding the intent id in `provider_subscription_id` (no migration; that is the column the webhook
   resolves an owner from).
   A **409** here means a paid period is live or a first payment is pending in the 24h window —
   deliberate (a second payment is a second charge). Don't clear the row to "fix" it.
2. **Pay on Maya**, then the browser returns to `/app?upgrade=pending` (`UpgradePendingNotice`
   polls `/api/usage`; in no-Clerk dev mode it can never flip because `resolve_tier` short-circuits
   to `dev` — assert on the row instead).
3. **Webhook** — `payment.paid` (or `payment_intent.succeeded`; register both) sets
   `plan=premium, status=active, current_period_end = now() + PREMIUM_PERIOD_DAYS`. It is a
   **compare-and-set on `provider_subscription_id = <intent id> AND status = 'incomplete'`**, so a
   replay, the sibling event type, or a PayMongo retry cannot buy a second period
   (`paymongo.webhook.payment_not_credited` in the logs is this guard firing).
4. **Assert** — `debug-state.sh`, or check the row: `status=active` plus ~30 days of
   `current_period_end`. `billing.resolve_tier` then reads `premium` wherever Clerk is on.
5. **No cancel to offer** — nothing is scheduled provider-side, so `/api/billing/cancel` only marks
   the row `cancelled` (the paid time still serves) and the UI shows the expiry instead of a button.

Agent shortcut for the provider half: `payments.sh --create-period` does step 1 straight at PayMongo
and prints the Maya URL, then `webhook-driver.sh --event=payment.paid --intent=pi_x` does step 3.

### Subscription mode — blocked until support enables it

1. **Plan** — once per price. `POST /v1/subscriptions/plans` with
   `{name, amount: 49900, currency: "PHP", interval: "month", interval_count: 1}` → `plan_…` →
   put it in `PAYMONGO_PLAN_ID`. (`scripts/paymongo-stub.sh --create-plan`)
2. **App-side start** — `POST /api/billing/checkout` with `BILLING_MODE=subscription`. Creates the
   Customer, the Subscription (`incomplete`), then attaches a `paymaya` PaymentMethod to the
   **first invoice's** Payment Intent and returns the Maya URL (Maya is the only redirect-capable
   method for subscriptions; cards would need card vaulting + a PCI-scoped form). Same **409** guard
   as period mode.
3. **Pay within 24h** — the customer completes Maya. PayMongo then charges every later cycle itself.
   Unpaid after 24h → `incomplete_cancelled`.
4. **Webhooks** — `payment_token.activation`/`payment_session.completed` are ignored;
   `subscription.activated` flips the row to `premium/active`; `invoice.paid` recovers a `past_due`;
   `invoice.payment_failed` → `past_due`; `subscription.updated{status:cancelled}` → `free/cancelled`.
5. **Assert** — `debug-state.sh`, or `GET /api/usage` as that user (`tier: premium`).
6. **Cancel** — `POST /api/billing/cancel` (PayMongo has no billing portal); the paid period keeps
   serving until `current_period_end`.

Full guided run, including the browser leg: `references/maya-browser-checkout.md`.

---

## 6. Webhook signature (what the endpoint enforces)

`Paymongo-Signature: t=<unix>,te=<hmac>,li=<hmac>`, where the HMAC is **SHA-256 over `"{t}.{raw_body}"`
keyed by the endpoint's secret**. `te` is the test-mode slot, `li` the live one; an endpoint
registered in test mode leaves `li` empty, and the handler accepts **either** populated slot. The
handler also rejects a timestamp older than `PAYMONGO_SIGNATURE_TOLERANCE_S` (default **300 s**; raise
it if `paymongo.webhook_signature.stale` shows up in the logs — that means a real delivery is being
dropped) and fails closed when `PAYMONGO_WEBHOOK_SECRET` is unset. Sign by hand:

```bash
t=$(date +%s); sig=$(printf '%s.' "$t" | cat - body.json | openssl dgst -sha256 -hmac "$PAYMONGO_WEBHOOK_SECRET" | awk '{print $NF}')
curl -sS -X POST localhost:8000/api/billing/webhook -H "Paymongo-Signature: t=$t,te=$sig" \
  -H 'Content-Type: application/json' --data-binary @body.json
```

### Registering an endpoint (learned the hard way, 2026-09-17)

- **Live and test registrations are separate lists.** `GET /v1/webhooks` only ever shows the mode of the
  key you present, so a test-key `--list-webhooks` returning nothing says nothing about live (and vice
  versa). Registering live means a raw `POST /v1/webhooks` with the `sk_live_` key (this skill's scripts
  refuse live keys on purpose) or the dashboard.
- **Event types are account-scoped.** `payment_intent.succeeded` is rejected in live mode with
  `parameter_invalid: … is an invalid event type`; register `payment.paid` (the event period mode emits).
- **The signing secret is `whsk_…` (29 chars) and exact.** `--register-webhook` deliberately never prints
  it; when you script the registration, store the byte-exact value — a trailing newline from a heredoc or
  `jq -r > file` silently breaks every signature (`paymongo.webhook_signature` mismatches, money credited
  nowhere). `jq -r` plus a shell capture (`printf '%s' "$(…)"`) or `jq -j` avoids it.
- **The endpoint URL is the app's real origin**, e.g. `https://maxterview.seekeru.tech/api/billing/webhook`
  — the `/api` prefix is part of the route, and PayMongo must be able to reach it from the internet.
- **A secret change needs a pod restart.** The Deployment injects `maxterview-secrets` with `envFrom`, so
  a rotated `PAYMONGO_WEBHOOK_SECRET` only reaches the app on the next container start (new image tag or
  `kubectl rollout restart`).

---

## 7. Scripts

| Script | Purpose |
| --- | --- |
| `need-keys.sh` | Key liveness; paste-me template; refuses live keys. |
| `clerk-mint.sh` | Mint/refresh a Clerk user + testing session so a browser can sign in headlessly. |
| `paymongo-stub.sh` | Read/create a throwaway plan or customer on the real test account (`--create-plan`, `--create-customer`); `--drop` needs `--admin-destroy`. |
| `payments.sh` | The one-time (period-mode) rail: `--list-payments`, `--create-period` (real intent + Maya URL), `--refund --payment-id=pay_x --admin-destroy`, `--list-webhooks`, `--register-webhook --url=https://…`. Never echoes the webhook secret. |
| `webhook-driver.sh` | Craft a PayMongo event and deliver it: `--simulate` (dev endpoint) or signed to `/api/billing/webhook`. Handles `subscription.*`, `subscription.invoice.*`, `payment.*` (`--intent=pi_x`) and `payment_intent.succeeded`. Destructive types need `--admin-destroy`. |
| `debug-state.sh` | Read-only state dump: `/api/health`, `/api/usage`, newest `subscriptions` rows. |

## 8. Zero-touch + guardrails

- **Never print, cat, or echo a key.** Only `set`/`missing`/`live` status.
- **Refuse live keys** (`*_live_*`) in every script; `debug-state.sh` never runs destructive SQL.
- **`--admin-destroy` gate** on anything that drops provider state or ends a subscription.
- Ask before mutating persistent sandbox state unless the user asked for exactly that.
- Report a paymongo.com support dependency plainly instead of pretending a 400 is a code bug.

## 9. There is no PayMongo MCP to wire (checked 2026-09-15 — don't re-research)

`https://mcp.paymongo.com` is documented but **does not resolve** (NXDOMAIN on Cloudflare and Google
DoH, no crt.sh cert, absent from the MCP registry) while `api.paymongo.com` answers normally. Its
documented tools cover payments/intents/refunds/disputes/payouts/webhooks/events — none of them
subscriptions or plans, i.e. not the parts this app writes; the community `@theyahia/paymongo-mcp`
has zero subscription tools either.

The scripts here are the agent surface on purpose: they carry the live-key refusal, the
`--admin-destroy` gate and the never-print-a-secret rule, none of which survive translation into an
MCP tool list (which would also add every tool schema to every prompt). Revisit only if PayMongo
ships the endpoint **and** exposes subscriptions through it.

---

## 10. References

- `references/operator-manifest.md` — endpoint + read/write/guard catalog (Clerk + PayMongo).
- `references/maya-browser-checkout.md` — the browser leg that completes the real Maya payment.
