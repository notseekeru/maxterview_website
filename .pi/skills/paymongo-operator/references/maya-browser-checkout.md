# Real Maya payment via a host-direct browser (the "upgrade" leg)

This reference is what an agent follows to drive the **real** first-payment redirect for a PayMongo
subscription in a browser. Drive it either with the `playwright` MCP server declared in `.mcp.json`
(`browser_navigate`/`browser_snapshot`/`browser_click`) or host-direct with `playwright-core` +
chromium resolved from `/nix/store` exactly as the `hermetic-e2e` skill documents (no host
`npm install`, no `node_modules` in local storage).

It is the continuation of `clerk-mint.sh` + `webhook-driver.sh`: mint the identity, drive the SPA to
the Maya page, complete the payment, and assert the entitlement flip end to end.

> **Not a CI spec runner, and not fully automatable.** PayMongo hands the customer to **Maya's own
> hosted page**, so the payment itself is a human-in-the-loop step (there is no test-card number to
> type — Maya is an e-wallet login). The automated leg stops at the redirect and hands back to the
> user. Do not brute-force or loop against it.

## Why the browser layer exists

The API and webhook layers make the state (plan, customer, subscription, `subscriptions` row). This
leg makes the **actual product flow** real: a user clicks Upgrade on the SPA, lands on Maya, pays, and
PayMongo posts the webhook back. Assertions stay on your own `/api/usage` and `subscriptions` — the
only trustworthy signals (never the redirect itself; `Paymongo-Signature`-verified webhooks are the
confirmation, per PayMongo's own integration-security guidance).

**Preconditions** (`need-keys.sh` all green, plus two account-level switches):
- `PAYMONGO_SECRET_KEY` (test) + `PAYMONGO_PLAN_ID` set, `FRONTEND_BASE_URL` set.
- **Subscriptions enabled on the PayMongo account** (email support@paymongo.com) — without it the
  `POST /v1/subscriptions` inside `/api/billing/checkout` fails with a provider 400/502.
- Backend + frontend reachable (`make up`; frontend at 5173).
- Either (a) `CLERK_ENABLED=false` dev fallback → every call is `DEV_USER`, or (b) real Clerk via the
  testing token from `clerk-mint.sh` to authenticate the browser as a chosen user.

## Driver conventions (host-direct playwright)

```js
import pw from process.env.PCORE_INDEX;              // CJS default import
const { chromium } = pw;
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH,
                                  headless: true, args: ["--no-sandbox", "--disable-gpu"] });
const ctx = await b.newContext();
const page = await ctx.newPage();
// every step below maps to page.*: page.goto, page.click, page.fill, ...
```

Resolve `PCORE_INDEX` (e.g. `.../playwright-core-1.61.1/index.js`) and `CHROME_PATH`
(`.../playwright-chromium/chrome-linux64/chrome`) with `find /nix/store`.

Because the Maya login is a human step, launch with `headless: false` for that one step (or use the
MCP browser the user can watch) and hand the page over at the checkpoint below.

## Procedure

### 0. (Real-Clerk only) Authenticate as the minted user
Run `.pi/skills/paymongo-operator/scripts/clerk-mint.sh` for a session/testing token, then set the
Clerk `__session` cookie on the frontend origin via `context.add_cookies` for the SPA's URL
(e.g. `http://localhost:5173`). In no-Clerk dev mode skip this — the backend returns `DEV_USER`.

### 1. Drive the SPA to the Upgrade UX
- `page.goto("{FRONTEND_BASE_URL}/app")`, then `/app/settings/billing` (or the `UpgradeNotice` CTA).
- The Upgrade button calls `startSubscription()` → `POST /api/billing/checkout` → the backend creates
  Customer → Subscription (`incomplete`) → attaches a `paymaya` PaymentMethod to the **first
  invoice's** Payment Intent and returns Maya's redirect URL. A failure here is most often "no email
  on the account" (409) or "Subscriptions not enabled" (502).
- Navigate the browser to that URL. **Handoff point.**

### 2. Complete the payment on Maya's page
- TEST mode: PayMongo/Maya present their sandbox surface; complete it as the human operator. There is
  no card number and no `4242` equivalent — this account's own Maya sandbox credentials are the input.
- LIVE mode: the customer's real Maya account. Never automate a human's real wallet.
- If anything challenges the run, STOP automation and let the human finish in the visible browser.

### 3. Let the webhook round-trip
PayMongo redirects back to `{FRONTEND_BASE_URL}/app?upgrade=pending` (the query is an inert landing
marker; the SPA does not read it) and posts `payment_token.activation` / `payment_session.completed`
(both ignored by our handler) then **`subscription.activated`** and **`subscription.invoice.paid`**.
Those need a publicly reachable `{BACKEND}/api/billing/webhook` plus the endpoint's secret in
`PAYMONGO_WEBHOOK_SECRET` — PayMongo has **no CLI and no events API**, so if the app is only on
localhost, deliver the equivalent instead:

```bash
.pi/skills/paymongo-operator/scripts/webhook-driver.sh --event=subscription.activated \
  --subscription=subs_… --customer=cus_…          # signed with PAYMONGO_WEBHOOK_SECRET
```

(24-hour rule: if the first payment is never completed, PayMongo self-cancels the subscription to
`incomplete_cancelled` and a new one must be created — `POST /api/billing/checkout` does that.)

### 4. Assert entitlement
- `GET {BACKEND}/api/usage` → expect `"tier": "premium"` for that owner.
- Or `debug-state.sh` for the row: `plan='premium'`, `status='active'`, `current_period_end` = the
  next billing date (a date, not an epoch).
- Teardown: `POST /api/billing/cancel` (or `webhook-driver.sh --admin-destroy --event=subscription.updated
  --status=cancelled`), then confirm the row reads `free/cancelled`. Note that a **cancel keeps
  entitlement until `current_period_end`** — that is intended (the period was paid for), so verify
  with `resolve_tier`'s rule in mind rather than expecting an instant `free`.

## Keyless shortcut (no PayMongo account at all)
Skip this whole reference: seed the row and drive the webhook directly (SKILL.md §4). That proves
`webhook → subscriptions → resolve_tier → /api/usage` without keys, and is what CI-shaped checks
should assert on.

## Resume / quit
If you minted a throwaway identity:
`.pi/skills/paymongo-operator/scripts/clerk-mint.sh --admin-destroy --teardown --user=<id>`.

## Guardrails recap (they apply to the browser leg too)
- Never a real wallet/card; the Maya step is human-in-the-loop by design.
- Never print or paste a key — the browser only ever sees an established cookie/session.
- The redirect is not proof of payment; only the signed webhook (or a server-side
  `GET /v1/subscriptions/{id}`) is.
- Destructive teardown still requires `--admin-destroy`.
