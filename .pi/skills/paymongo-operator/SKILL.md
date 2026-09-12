---
name: paymongo-operator
description: >-
  Operates the real (test-mode) Clerk and PayMongo accounts for maxterview so the user never has to
  open the Clerk or PayMongo dashboards to configure, inspect, seed, or reset the auth/billing
  sandbox. Lets an agent (pi or similar), or a human, read/create real test state, mint a Clerk
  testing session so a browser authenticates as a throwaway user, create a real ₱499/mo PayMongo
  subscription, drive its Maya first payment, deliver signed (or simulated) webhook events, and
  prove the entitlement flip in the backend (chat quotas / premium tier). Load when the user wants
  to set up, debug, or reset Clerk+PayMongo test state for maxterview, or to run the real
  subscribe->webhook->tier journey without visiting paymongo.com or clerk.com.
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
| `PAYMONGO_SECRET_KEY` (test) | Create plan/customer/subscription, mint the Maya redirect, receive real webhook deliveries (if a public URL exists), replay/craft signed events. | Take real money. Live keys need a Fully Verified account. |
| live keys | Real ₱499/mo billing. | — |

**Two PayMongo account-level features are NOT self-service** and both block the real journey until
enabled: **Subscriptions** and **Card Vaulting** — email `support@paymongo.com`. Verify these before
debugging anything else; a 400 on `POST /v1/subscriptions` with an otherwise valid key usually means
this.

---

## 2. Where keys and state live

- `backend/.env` (git-ignored) is the runtime source: `PAYMONGO_SECRET_KEY`, `PAYMONGO_WEBHOOK_SECRET`,
  `PAYMONGO_PLAN_ID`, `FRONTEND_BASE_URL`, plus `CLERK_*` and quotas.
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

1. **Plan** — once per price. `POST /v1/subscriptions/plans` with
   `{name, amount: 49900, currency: "PHP", interval: "month", interval_count: 1}` → `plan_…` →
   put it in `PAYMONGO_PLAN_ID`. (`scripts/paymongo-stub.sh --create-plan`)
2. **App-side start** — `POST /api/billing/checkout` as the signed-in user. It creates the
   Customer, the Subscription (`incomplete`), then attaches a `paymaya` PaymentMethod to the
   **first invoice's** Payment Intent and returns the Maya URL. Maya is the only redirect-capable
   method PayMongo supports for subscriptions — cards would need card vaulting + a PCI-scoped form.
   A **409** here means the stored subscription still covers a paid period, or a first payment is
   pending inside the 24h window — deliberate (a second `POST /v1/subscriptions` would be a second
   charge), so don't "fix" it by clearing the row.
3. **Pay within 24h** — the customer completes Maya. PayMongo then charges every later cycle itself.
   Unpaid after 24h → `incomplete_cancelled`. The browser returns to `/app?upgrade=pending`, which
   polls `/api/usage` for the flip (`UpgradePendingNotice`) — in no-Clerk dev mode it can never flip,
   because `resolve_tier` short-circuits to `dev`.
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

---

## 7. Scripts

| Script | Purpose |
| --- | --- |
| `need-keys.sh` | Key liveness; paste-me template; refuses live keys. |
| `clerk-mint.sh` | Mint/refresh a Clerk user + testing session so a browser can sign in headlessly. |
| `paymongo-stub.sh` | Read/create a throwaway plan or customer on the real test account (`--create-plan`, `--create-customer`); `--drop` needs `--admin-destroy`. |
| `webhook-driver.sh` | Craft a PayMongo event and deliver it: `--simulate` (dev endpoint) or signed to `/api/billing/webhook`. Destructive types need `--admin-destroy`. |
| `debug-state.sh` | Read-only state dump: `/api/health`, `/api/usage`, newest `subscriptions` rows. |

## 8. Zero-touch + guardrails

- **Never print, cat, or echo a key.** Only `set`/`missing`/`live` status.
- **Refuse live keys** (`*_live_*`) in every script; `debug-state.sh` never runs destructive SQL.
- **`--admin-destroy` gate** on anything that drops provider state or ends a subscription.
- Ask before mutating persistent sandbox state unless the user asked for exactly that.
- Report a paymongo.com support dependency plainly instead of pretending a 400 is a code bug.

## 9. References

- `references/operator-manifest.md` — endpoint + read/write/guard catalog (Clerk + PayMongo).
- `references/maya-browser-checkout.md` — the browser leg that completes the real Maya payment.
