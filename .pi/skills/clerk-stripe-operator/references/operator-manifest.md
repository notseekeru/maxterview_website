# Clerk + Stripe operator — endpoint & guardrail manifest

Audited map of the real Clerk and Stripe (both **test as default**) resources this skill can touch,
with exact HTTP verbs and their idempotence/danger. Keys are read from the environment; this file is
the write-upsheet the model consults before composing any operational call. Everything here is
CRUD-able **only when an `sk_test_`/`sk_secret_test_` is passed**. Live keys (`_live_`) are refused
by convention (see Guardrails / §8 SKILL.md).

Hard rules that apply everywhere:
- **Zero-touch** — never emit a key/value. This reference only names endpoints.
- Destructive verb (`DELETE`, `cancel_at` that ends a standing sub, force-disable, `?active=false`,
  `data[remove]`) ⇒ requires the run-level `--admin-destroy` flag AND prints the exact DELETE + id
  beforehand.
- Prefer small, idempotent, explicit calls over bulk teardown.

---

## A. Clerk (api.clerk.com/v1)

Base: pass header `Authorization: Bearer $CLERK_SECRET_KEY`. All params JSON, host:
`https://api.clerk.com/v1`.

| Resource | Endpoints (safe→destructive) | Notes / guardrail |
|---|---|---|
| Users | `GET /users`, `POST /users` (create), `GET /users/{id}` | Create always allowed; reads allowed. |
| Users (mut) | `PATCH /users/{id}` (email, name, public_metadata), `PATCH /users/{id}/metadata` | Fine to mutate a throwaway test user. |
| Sessions | `GET /users/{id}/sessions`, `POST /sessions` (create a **session token**) | For feeding a real Clerk session to a Playwright `__session`. |
| Dev sessions | `POST /sessions/{sid}/tokens` (dev instance) | Returns a client session token — auths a browser **as that user** w/o credentials. |
| Testing tokens | create via **testing-token template** (see your Clerk template id) — produce a signed token the SDK recognizes | This is the key to browser-auth on dev and **prod** instances alike. Needs the testing-token template id from the dashboard. |
| Sign-in tokens | `POST /sign_in_tokens`, `POST /sign_in_tokens/{id}/revoke` | Magic-link style tokens. |
| Instances | `GET /instances` | Read-only (useful to discover the instance). |
| JWT templates | `GET /jwt_templates` (list claims), create a template that adds you a custom `tier` claim if desired | Note: to honor `owners require it`, your app default uses `ClerkUser.tier`; easiest is storing premium in subscriptions table via Stripe events (this repo already does). |
| Allow lists | `GET /allowlist_identifiers`, `POST`, `DELETE` | not usually needed. |

**Guardrails**
- `DELETE /users/{id}` and `PATCH .../disable` tear down a sign-in-able identity — require
  `--admin-destroy`.
- Building a session/Token for a throwaway identity is a write, but non-destructive: allowed default.
- Prefer the `testing-token` route for browser auth over ad-hoc sessions when possible (no password,
  no 2FA, works on prod instances as of tests, per Clerk docs).

---

## B. Stripe (api.stripe.com/v1)

Base: `https://api.stripe.com/v1`, header `Authorization: Bearer $STRIPE_SECRET_KEY`.
Stripe is form-encoded (`application/x-www-form-urlencoded`).

| Resource | Endpoints | Notes / guardrail |
|---|---|---|
| Prices | `GET /prices`, `POST /prices`, `GET /prices/{id}` | `POST` create a throwaway `price_` when none — fine. To reuse your product param set, prefer your mapped premium `price_` in env. |
| Products | `GET /products`, `POST /products` | only if building a brand new price. |
| Customers | `GET /customers`, `POST /customers` | Create is fine; links `owner_id` to Customer. |
| PaymentMethods | `POST /payment_methods`, `POST /payment_methods/{id}` (attach), `GET /customers/{id}/payment_methods` | attach to a test customer for the billing state machine. |
| Subscriptions | `POST /subscriptions`, `GET /subscriptions/{id}`, `GET /v1/customers/{id}/subscriptions` | To make a `subscription` appear alone (no checkout) — set `customer`, `items`, `cancel_at` etc. |
| Subscriptions (mutate) | `PATCH /subscriptions/{id}` (change `cancel_at`, `items[0][price]`, default_payment_method) | Lifecycle transitions are allowed by default; a true end/`DELETE` needs flag. |
| Checkout/Portal | `POST /checkout/sessions` (returns hosted URL), `GET /sessions/{id}`, `POST /billing_portal/sessions` | For the app, prefer calling your OWN `/api/billing/checkout`+`/api/billing/portal` (they build from your env) rather than Stripe direct — less to keep in sync. |
| Events / logs | `GET /events`, `GET /v1/events?type=customer.subscription.deleted` | read-only, diagnostic. |
| CLI | `stripe trigger <event>`, `stripe listen --forward-to URL`, `stripe tokens` | Emits sandbox events to your webhook (useful w/o live CLI session). |

**Specific events your backend consumes** (see `backend/src/app/payments.py`, `handle_webhook_event`):
`checkout.session.completed` → records `owner_id`(metadata)↦customer; then
`customer.subscription.{created,updated}` → upserts `plan='premium'`, status from event;
`customer.subscription.deleted` → flips row to `plan='free', status='canceled'`.
To **prove entitlement** end-to-end, replay exactly these against your `/api/billing/webhook`, then
`GET /api/usage` and read `tier`.

**Guardrails**
- `DELETE /v1/subscriptions/{id}`, `DELETE /v1/customers/{id}`, `DELETE /v1/prices/{id}` and any
  `?active=false` on a price/product → require `--admin-destroy`.
- `stripe trigger customer.subscription.deleted` deletes a real (test) sub for a customer —
  in this repo it maps to the user row flipping back to free. That is destructive to test state ⇒
  also gate with `--admin-destroy`.
- Stripe hosted checkout is **not** a reliable pure-bot path (anti-bot). Only reach real cards via
  the user-driven browser handoff at the card step; otherwise keep asserts to the webhook/state side.
- Test card is always `4242 4242 4242 4242` (any future exp/CVC), or the extra `4000 0025 0000 3155`
  for SCA challenge if you must exercise it.

---

## C. Read/write/guard summary

| Verb class | Examples | Default policy |
|---|---|---|
| Read | GET lists/details on both | ✅ allowed |
| Create | new user/token/session, price/customer/subscription, checkout/portal session | ✅ allowed |
| Mutate lifecycle | cancel_at, PM attach, tier-relevant status flips | ✅ allowed |
| Destroy | DELETE user/sub/customer/price, trigger `*.deleted` | ❌ `--admin-destroy` |
| Live | any `_live_` key | ❌ never auto |

## D. Extra caution (repo specifics)

- This repo reads Clerk keys as `CLERK_SECRET_KEY`-style only in **operator** scripts; the app
  itself needs `CLERK_DOMAIN`, `CLERK_JWKS_URL`. Do not mistake the operator secret for app config.
- The `subscriptions` table's `owner_id` is the Clerk `sub`. Keep your test users' `sub`; everything
  maps on it.
- Write scripting against the env-produced `STRIPE_PRICE_ID` / `FRONTEND_BASE_URL`; hardcoding a
  `price_` is brittle (prices can be recreated).
