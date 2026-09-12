# Clerk + PayMongo operator — endpoint & guardrail manifest

Audited map of the real Clerk and PayMongo (both **test as default**) resources this skill can touch,
with exact HTTP verbs and their idempotence/danger. Keys are read from the environment; this file is
the write-up sheet the model consults before composing any operational call. Everything here is
CRUD-able **only when an `sk_test_` is passed**. Live keys (`_live_`) are refused
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
| JWT templates | `GET /jwt_templates` (list claims), create a template that adds you a custom `tier` claim if desired | Note: to honor `owners require it`, your app default uses `ClerkUser.tier`; easiest is storing premium in subscriptions table via PayMongo webhook events (this repo already does). |
| Allow lists | `GET /allowlist_identifiers`, `POST`, `DELETE` | not usually needed. |

**Guardrails**
- `DELETE /users/{id}` and `PATCH .../disable` tear down a sign-in-able identity — require
  `--admin-destroy`.
- Building a session/Token for a throwaway identity is a write, but non-destructive: allowed default.
- Prefer the `testing-token` route for browser auth over ad-hoc sessions when possible (no password,
  no 2FA, works on prod instances as of tests, per Clerk docs).

---

## B. PayMongo (api.paymongo.com)

Base: `https://api.paymongo.com`, header `Authorization: Basic base64("$PAYMONGO_SECRET_KEY:")`
(note the **empty password**), JSON bodies (`application/json`). Amounts are **centavos**
(49900 = ₱499). PHP is the only subscription currency.

| Resource | Endpoints | Notes / guardrail |
|---|---|---|
| Plans | `POST /v1/subscriptions/plans`, `GET /v1/subscriptions/plans` | Create the ₱499/mo premium plan once (`scripts/paymongo-stub.sh --create-plan`); the id goes in `PAYMONGO_PLAN_ID`. |
| Customers | `POST /v1/customers`, `GET /v1/customers`, `DELETE /v1/customers/{id}` | Email is **unique per customer** — reuse the id stored in `subscriptions.provider_customer_id`; never create a second one for the same owner. |
| Subscriptions | `POST /v1/subscriptions`, `GET /v1/subscriptions/{id}`, `DELETE /v1/subscriptions/{id}` | Create generates the **first invoice immediately** (24h to pay it or it self-cancels to `incomplete_cancelled`). `DELETE` is immediate — but our `cancel_subscription` keeps the paid period entitled until `current_period_end`. |
| Subscription invoices | `GET /subscriptions/invoices?resource_id=subs_…`, `POST /v1/subscriptions/invoices/{id}/pay` | The invoice carries `payment_intent.{id,status}` — the first invoice's intent is what the Maya payment attaches to. |
| Payment intents | `GET /v1/payment_intents/{id}`, `POST /v1/payment_intents/{id}/attach` | Attach with `payment_method` + `client_key` + `return_url`; the response's `next_action.redirect.url` is the customer-facing redirect. |
| Payment methods | `POST /v1/payment_methods` | Only `{type: "paymaya"}` here — no card data ever reaches this repo (vaulting would need PayMongo.js + PCI scope). |
| Webhooks | dashboard (Developers → Webhooks) or `POST /v1/webhooks` | One endpoint for `/api/billing/webhook`; the signature key is that endpoint's secret, not the API key. There is **no events API and no CLI**, so replay/`--simulate` is how you re-deliver. |

**Account-level prerequisites (not self-service):** email support@paymongo.com to enable
**Subscriptions** and **Card Vaulting**, and to reach Fully Verified (DTI + BIR 2303) for live keys.
A 400 on `POST /v1/subscriptions` with a valid test key usually means the first.

**Events the backend consumes** (`backend/src/app/payments.py`, `handle_webhook_event`):
`subscription.activated|updated` → upsert `plan`/`status`/`current_period_end`; `invoice.paid` →
`active` (recovers `past_due`); `invoice.payment_failed` → `past_due`; draft/open invoice churn
(`invoice.created|finalized|updated`) is ignored. Envelope parsing tolerates both PayMongo shapes
(`data.attributes.*` and `data.*`).

**Guardrails**
- `DELETE` on a customer/subscription/plan, `--drop-customer`, and any event that downgrades
  (`subscription.updated --status=cancelled`, `invoice.payment_failed`) → require `--admin-destroy`.
- Delivery is authenticated by HMAC of `"{t}.{raw_body}"` with the endpoint secret (`te` for test,
  `li` for live slots); the handler also enforces a replay window (`PAYMONGO_SIGNATURE_TOLERANCE_S`,
  default 300 s, logged when it rejects) and fails closed when `PAYMONGO_WEBHOOK_SECRET` is unset.
  `/billing/webhook` is rate-limit exempt on purpose. Deleting a customer makes any vaulted card
  unusable.
- Maya's hosted page is a real redirect, not an embeddable widget; there is no test-card number to
  type and the account's own Maya means must be used to complete it.

---

## C. Read/write/guard summary

| Verb class | Examples | Default policy |
|---|---|---|
| Read | GET lists/details on both | ✅ allowed |
| Create | new user/token/session, plan/customer/subscription, payment method attach | ✅ allowed |
| Mutate lifecycle | cancel_at, PM attach, tier-relevant status flips | ✅ allowed |
| Destroy | DELETE user/sub/customer/plan, status→cancelled events | ❌ `--admin-destroy` |
| Live | any `_live_` key | ❌ never auto |

## D. Extra caution (repo specifics)

- This repo reads Clerk keys as `CLERK_SECRET_KEY`-style only in **operator** scripts; the app
  itself needs `CLERK_DOMAIN`, `CLERK_JWKS_URL`. Do not mistake the operator secret for app config.
- The `subscriptions` table's `owner_id` is the Clerk `sub`. Keep your test users' `sub`; everything
  maps on it.
- Write scripting against the env-produced `PAYMONGO_PLAN_ID` / `FRONTEND_BASE_URL`; hardcoding a
  `plan_` is brittle (plans can be recreated).
- Entitlement lives in `subscriptions.status` **plus** `current_period_end`: `active`/`cancelled` are
  entitled only while the period is in the future, `past_due`/`unpaid` never are. A row can look
  "premium" and still not grant access — check both columns before calling it a bug.
