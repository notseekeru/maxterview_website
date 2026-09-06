---
name: clerk-stripe-operator
description: >-
  Operates the real (test-mode) Clerk and Stripe accounts for maxterview from the CLI, so the
  user never has to open the Clerk or Stripe dashboards to configure, inspect, seed, or reset
  the billing/auth sandbox. Lets an agent (pi or similar), or a human, read/create full test
  state, build a Clerk testing-token/session so a browser can authenticate as a throwaway user,
  drive a real Stripe checkout and (re)deliver real webhook events to the app, and prove
  entitlement flips in the backend (interview chat quotas / billing tiers). Load when the user
  wants to set up, debug, or reset Clerk+Stripe test state for maxterview, or to run the real
  checkout->webhook->tier journey without visiting stripes.com/clerk.com.
---

# Clerk + Stripe operator (maxterview)

Hands the model full administrative read/write over the **test-mode** Clerk and Stripe accounts
that back the maxterview monorepo, entirely through their APIs and env vars. Purpose: let an AI
(and the repo owner) configure, inspect, seed, and tear down sandbox state **without ever opening
the Clerk or Stripe dashboards**, and to prove the real subscription lifecycle flows end-to-end.

> **Security is load-bearing here.** This skill reaches a live Clerk `sk_test_` secret key and a
> live Stripe `sk_test_`/`whsec_`. These are real (test-mode) accounts. Treat them like production
> credentials: never echo them, never commit them, never put them in logs, never send them to a
> non-authorized third party. Follow section [Zero-touch + guardrails](#zero-touch--guardrails).

---

## 1. Scope of this skill

You use this skill when the user wants any of:

1. Stop hand-fiddling the Clerk/Stripe dashboards for the billing/auth sandbox of maxterview.
2. Create/inspect/reset Clerk test **users, sessions, sign-in/testing tokens, instances, and
   JWT templates** on their real test instance.
3. Create/inspect/reset Stripe test **prices, customers, subscriptions, checkout/portal
   sessions, events/logs** on their real test-mode Stripe account.
4. Run the genuine end-to-end billing journey: authenticate a headless browser **as a throwaway
   Clerk user** (testing-token, no password typing), reach a real hosted Stripe checkout, complete
   it with a test card, and assert in the app that the user's tier flipped to `premium`.
5. Read the resulting state (backend `subscriptions` table / `GET /usage`) to debug why a user
   is or isn't `premium`.

This is **NOT** for: running a hermetic/mocked billing test in CI (there is no fake state and no
CI money path), testing anonymous/guest flows, or doing anything against **live** (non-`sk_live_` /
`whsec_live`) resources.

---

## 2. Where keys and state live

Clerk and Stripe config is environment-driven already; the skill only **reads** those env vars.
They are NOT created or stored by this skill.

Put these in the **git-ignored** `backend/.env` (same file the app already reads). They are only
used server-side / process-side. Frontend Clerk key is separate (see below).

| Env var | Required | Meaning | Example |
|---|---|---|---|
| `CLERK_SECRET_KEY` | for Clerk ops | Clerk **test** secret key (`sk_test_...`) used to call `api.clerk.com/v1/` | `sk_test_...` |
| `CLERK_FRONTEND_API` | for session/token | Clerk Frontend API host (`<instance>.clerk.accounts` / `.clerk.dev`) you authenticate into via publishable key | `${instance}.clerk.accounts` |
| `CLERK_PUBLISHABLE_KEY_PREVIEW` | recom. | the `pk_...` that the frontend is configured with (frontend/.env `VITE_CLERK_PUBLISHABLE_KEY`) so the testing token targets the SAME instance | `pk_test_...` |
| `STRIPE_SECRET_KEY` | for Stripe ops | Stripe **test** secret (`sk_test_...`) used to call `api.stripe.com/v1/` | `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | for webhook proof | `whsec_...` the backend uses to verify `/billing/webhook` signatures | `whsec_...` |
| `STRIPE_PRICE_ID` | for checkout flow | the $9.99/mo premium **price** id; your `app/payments.py` requires it for `/billing/checkout` | `price_...` |
| `FRONTEND_BASE_URL` | for portal return | success/cancel + portal return URL the app uses | `http://localhost:5173` |

Keys must already exist in the environment (e.g. `backend/.env` loaded by docker compose, or set in
the shell). Run `scripts/need-keys.sh` — it will print exactly which of the above are present and
which are missing, and the *paste-me template* for the missing ones. It never prints any value.

The backend only reaches Stripe/clerk when these are populated; with `CLERK_ENABLED=false` the app
runs in the no-Clerk dev-fallback. That is fine for most UI debugging but does **not** exercise
real Clerk auth or the real webhook. For genuine operator work you need `CLERK_ENABLED=true` +
`CLERK_DOMAIN`/`CLERK_JWKS_URL`/`CLERK_AUDIENCE`.

---

## 3. One-time environment setup

Prereqs (only first time):

```bash
# 1. Check what the environment already has (never prints values):
.pi/skills/clerk-stripe-operator/scripts/need-keys.sh

# 2. If CloudFree/dev not set, add the missing clerk/stripe test vars to backend/.env per
#    the template the script prints, and (for real Clerk browser auth) flip the instance so the
#    frontend is pointed at it AND backend CLERK_ENABLED=true in dev.

# 3. For a real webhook round-trip, the Stripe CLI must be installed and logged-in once:
stripe --version            # present?
stripe login                # interactive, you, once
# then later, in another shell/TMUX:
stripe listen --forward-to http://localhost:8000/billing/webhook
# keep that running for the webhook tests; note the printed whsec_ and make it match
# STRIPE_WEBHOOK_SECRET in backend/.env.
```

After that the skill is usable. `need-keys.sh` is the single read-only liveness check.

---

## 4. Correct ordering of the full real-billing journey

High-signal debugging/verification path. Each step talks to the real account; none mutates live
resources; the whole chain drives the app's real `payments.handle_webhook_event` → `subscriptions`
→ `billing.resolve_tier`.

1. **Key liveness**: `scripts/need-keys.sh` — all green.
2. **Stripe test price exists (else create a throwaway)**: via REST (see manifest) or
   `scripts/stripe-stub.sh`. Read-only check: a `GET /v1/prices` for your `STRIPE_PRICE_ID`.
3. **App reachable**: backend `GET /health` = 200 on the port it runs (default 8000); frontend
   dev server reachable at `FRONTEND_BASE_URL`.
4. **Mint a throwaway Clerk identity + testing-token**: `scripts/clerk-mint.sh`. This creates a
   fresh test user (if asked), a session, and a **testing token** and prints a signed token TTL.
   - For Playwright/@clerk/testing use `setupClerkTestingToken`-style flows with the testing
     template id; for a raw browser you set Clerk's `__session` from the token on the target
     origin's cookies so your app's `ClerkGate`/`ClerkProvider` authenticates as that identity.
5. **Drive the app** up to `/app` → trigger the Upgrade/upgrade-UX. In no-Clerk mode the identity is
   `DEV_USER`; with real Clerk the token makes the browser that user.
6. **Reach real Stripe hosted checkout**: `POST /billing/checkout` (real `sk_test_`) returns a real
   `https://checkout.stripe.com/...` URL. In a headless browser, finish it with Stripe test card
   `4242 4242 4242 4242`, any future exp, any CVC.
   - Stripe may pause for a challenge (bot defense): hand back to the human at the **one** card step
     and resume when they click through. Do not fight or retry automation attempts against it.
7. **Webhook proof**: with `stripe listen` forwarding, Stripe sends real
   `checkout.session.completed` then `customer.subscription.created/updated`. If you are not behind
   the CLI, you can replay those exact events against `/billing/webhook` with a valid signature, or
   `stripe trigger customer.subscription.created` (see [scripts/webhook-driver.sh](#scripts)). Then
   assert the app sees the user as premium (`GET /usage` → `tier: premium`).
8. **State read**: `scripts/debug-state.sh` prints the latest `subscriptions` rows mapped to owner
   and current `/usage`. Verifies the flip and helps you debug why a user is/isn't premium.

---

### Fully-headless Clerk auth (verified 2026-09-06) — preferred over the Playwright MCP

The `.mcp.json` Playwright binary has been observed broken (ENOENT). The supported headless
sign-in is **`@clerk/testing/playwright`** run on the **host** (not the Alpine app container —
its bundled chromium is glibc/Debian and will not run under Alpine's musl). The repo flake's
devShell now ships `nodejs` for this. It needs a real dev-instance `sk_test_` + `pk_test_`.

Mechanism:
- `clerkSetup({ publishableKey, secretKey, frontendApiUrl })` mints a Clerk **testing token** and
  sets `CLERK_FAPI`/`CLERK_TESTING_TOKEN` in `process.env` (it returns `undefined`).
- `clerk.signIn({ page, emailAddress })` arms `setupClerkTestingToken` (route-intercepts the FAPI
  to inject `__clerk_testing_token`) and signs the user in with **no UI** — the app's
  `<ClerkProvider>` then holds a real `__session`. Requires `CLERK_SECRET_KEY` in `process.env`.
- A signed-in page yields an ~800-char `__session` cookie; the backend validates its JWT against
  the dev JWKS and `/usage` resolves that real `sub`.

Env / data realities learned:
- Dev instances with username-in-requirements reject user create without a `username`
  (422 `form_data_missing:["username"]`). `clerk-mint.sh` now auto-derives one.
- User API ids are `user_…`; the `idn_…` ids in the same payload are *identifications*, not the
  user id. `clerk-mint.sh` now parses the real `user_…` id.
- Clerk **Platform API key** (`CLERK_PLATFORM_API_KEY`) is the headless/agent alternative to
  `clerk auth login` (avoids the browser), but **creating that key is itself dashboard-only**
  and it manages account apps/domains, not sessions. For minting app/user sessions you need the
  instance `sk_test_` (Backend API `api.clerk.com/v1`).
- Backend Clerk JWT verification uses only the public JWKS URL + CLERK_DOMAIN — the backend does
  **not** read `CLERK_SECRET_KEY`. The secret is only needed for Backend API calls (user mint).

### Browser leg (MCP): completing the real hosted Checkout

The account-administration scripts above call Clerk/Stripe HTTP APIs and the Stripe CLI **directly**
(no MCP, no browser). The one genuinely browser-y step — clicking Upgrade in the SPA and
**paying on the real `checkout.stripe.com` page with the Stripe test card** — is driven through the
existing **Playwright MCP** server (already declared in `.mcp.json`; `mcp__playwright` tools
`navigate`/`fill`/`click`/etc.).

Follow `references/card-browser-checkout.md` for the full walkthrough. Skeleton: mint identity
(`clerk-mint.sh`) → browse `{FRONTEND_BASE_URL}/app` → trigger Upgrade → land on hosted Checkout →
fill `4242 4242 4242 4242` → Stripe webhook back to `/billing/webhook` → assert `tier: premium`).

Two hard notes about this leg:
- The Playwright server is **headless** in `.mcp.json`. Stripe's anti-bot may interrupt the card
  step; at that point **hand the visible browser back to the human to finish** (don't retry loops).
- This is an **interactive journey**, not a CI spec runner. It exercises the real Upgrade button +
  real hosted Checkout; full automation of the actual money step is not something Stripe permits.
## 5. Commands / scripts

Run from repo root. Scripts live in `.pi/skills/clerk-stripe-operator/scripts/`. They are **read
and print only** unless you pass the explicit destructive flag (below). All env reads are
zero-touch.

| Command | Effect | Destructive-by-default? |
|---|---|---|
| `need-keys.sh` | Report which Clerk/Stripe env vars are set (never values) + go/no-go | No |
| `clerk-mint.sh` | Create a throwaway test user + session + print a testing-token; keys on env | No |
| `stripe-stub.sh` | Create/read a throwaway Stripe price or customer against test account | No |
| `webhook-driver.sh` | Replay/`stripe trigger` a chosen webhook event against your `/billing/webhook`; useful when no `stripe listen` is present | No (fires events into sandbox on purpose) |
| `debug-state.sh` | Query backend `subscriptions`+`GET /usage` and print latest tier rows (read-only) | No |

### Destructive operations (requiring `--admin-destroy`)

The skill grants **read + create + mutate subscription lifecycle** by default. **Delete / teardown /
permanently destructive calls** (e.g. `DELETE /v1/subscriptions/{id}`, `DELETE /v1/users/{id}`,
force-disabling a user, wiping a customer) MUST be preceeded by one explicit flag so a debugging
run can never accidentally wipe real (test) state. **Every destructive invocation** must carry it.

```bash
.pi/skills/clerk-stripe-operator/scripts/webhook-driver.sh --admin-destroy --event customer.subscription.deleted
.pi/skills/clerk-stripe-operator/scripts/clerk-mint.sh --admin-destroy --teardown --user <id>
.PI/skills/clerk-stripe-operator/scripts/stripe-stub.sh --admin-destroy --drop --customer <id>
```

- Without the flag any destructive-looking call is refused with a clear message (it prints: "refused:
  destructive op requires --admin-destroy").
- With the flag, the skill still prints exactly the DELETE it is about to perform and the target id
  before doing it.

---

## 6. Reference: endpoint + guardrail catalog

The audited map of every Clerk/Stripe resource this skill can touch, with exact HTTP verbs, the ids
they affect, and the guardrail for each, lives in `references/operator-manifest.md`. Read it before
writing new scripting so you reuse the exact endpoints and don't reinvent auth. When in doubt, ask
the repo owner before a call that has a `DELETE` or `?cancel_at`/unschedule that could affect a
customer's standing test subscription.

---

## 7. Read vs write guard matrix (summary)

| Action | Allowed by default? |
|---|---|
| `GET` lists / details (users, prices, customers, subscriptions, events) | ✅ |
| Create throwaway user/session/testing-token/price/customer/subscription | ✅ |
| Mutate subscription lifecycle: activate, cancel-at, transition past_due<->active, change default PM | ✅ |
| `DELETE`/destroy a user, subscription, customer, or wipe test data | ❌ needs `--admin-destroy` |
| Anything against **live** (`live` keys / `run:live`) | ❌ never |

---

## 8. Zero-touch + guardrails

- **Never** print, log, dump, or paste a secret/key. `need-keys.sh` only prints "set"/"missing".
- Secret values live only in `backend/.env` / process env, git-ignored. Do not write them elsewhere.
- Bulk test runs that would tear down many rows in one call: prefer explicit, idempotent, small
  steps over mass `DELETE`s.
- When a test Stripe card is needed, it is ALWAYS the documented test card `4242 4242 4242 4242`
  (any future exp / any CVC). Never a real card.
- If `need-keys.sh` shows the account keys are live (`_live_`) for an operation that is not
  explicitly authorized as such, stop and flag it.
- The skill may act on `sk_test_`/`whsec_`/`sk_test_clerk` at your explicit direction. It never acts
  on `sk_live_`.
