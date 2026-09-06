# Real Stripe Checkout via the Playwright MCP (the "pay/upgrade" leg)

This reference is what an agent follows to drive a **real** hosted Stripe Checkout in a browser,
using the Playwright MCP server already declared in `.mcp.json`. It is the natural continuation of
`clerk-mint.sh` + `webhook-driver.sh`: mint the identity, drive the browser up to a real Stripe
page, complete it with a **test card**, and assert the entitlement flip end to end.

> Not a CI spec runner. It is an authenticated, human-at-the-stripe-card walkthrough. Stripe runs
> anti-bot heuristics on hosted Checkout; the automated leg stops at the card and hands back to the
> user the moment Stripe interrupts. Do not brute-force or retry automation against those checks.

## Why the browser layer exists

The API layer makes the state (users, price, webhook events). This browser leg makes the **actual
product flow** real: a user clicks Upgrade on the SPA, lands on Stripe's hosted page, pays with the
test card, and Stripe posts the webhook back to the app. Assertions happen on your own `/usage` and
`subscriptions`, which is the trustworthy signal.

**Preconditions** (`need-keys.sh` all green):
- Real `STRIPE_PRICE_ID` set (so `/billing/checkout` works), `FRONTEND_BASE_URL` set.
- Backend + frontend reachable (e.g. `docker compose -f compose.dev.yml up`, frontend at 5173).
- Either (a) `CLERK_ENABLED=false` dev fallback mode means every call is `DEV_USER`, or
  (b) real Clerk via testing-token from `clerk-mint.sh` to authenticate the browser as a chosen user.

## Driver conventions through Playwright MCP

The Playwright server in `.mcp.json` runs **chromium headless**. To use it, the agent issues
`mcp__playwright` calls: `navigate`, `fill`, `click`, `goto`, `new_page`, `screenshot`, `text`, etc.
All browser steps in this file are phrased in those terms. No new dependency is added: it reuses the
existing server.

Because Stripe may ask for a manual completion mid-flow, the browser used for the final card step
should ideally be one a human can see. The declared `.mcp.json` starts headless. If the human wants
visibility, launch a headed chromium for the run (`args: ["--browser","chromium"]` without `--headless`)
in your Playwright MCP server config or use the handoff step below on a page they watch.

## Procedure

### 0. (Real-Clerk only) Authenticate as the minted user
If the frontend runs with Clerk enabled, first run `.pi/skills/clerk-stripe-operator/scripts/clerk-mint.sh`
to get a session/testing token, then set the Clerk `__session` cookie on the frontend origin via the
Playwright `context.add_cookies` for the URL the SPA is served from (e.g. `http://localhost:5173`).
Now the SPA's `ClerkGate` treats the browser as signed in as that user. In no-Clerk dev mode skip this —
the backend returns `DEV_USER` for any request.

### 1. Drive the SPA to the Upgrade UX
- `mcp__playwright navigate` to `{FRONTEND_BASE_URL}/app`.
- Expect the app/gated dashboard. Trigger Upgrade — the `UsageBadge`/`UpgradeNotice` button calls
  `createCheckoutSession()` (SPA `POST /api/billing/checkout` → proxy strips `/api` → backend `POST /billing/checkout`), which returns a **real**
  `https://checkout.stripe.com/c/pay/...` URL. Catch the navigation or read the fetched URL.
- Do **not** follow that URL from node; navigate to it in the browser (a popup/new tab is fine).

### 2. Complete the Stripe hosted page with the test card
On the `checkout.stripe.com` page:
- Fill card number **`4242 4242 4242 4242`** (test card; never a real card), any future expiry
  (e.g. `12 / 34`), any CVC (e.g. `123`), and the postal code present.
- Confirm/”Pay”. Stripe runs bot heuristics here.
- **Handoff point:** if Stripe shows a challenge or the run trips a check, STOP automation. Tell the
  human to finish the card in the visible (headed) browser, then resume. Do not retry loops against
  the check. Secondary challenge card if you must exercise SCA: `4000 0025 0000 3155`.

### 3. Let the webhook round-trip
On success Stripe redirects to `{FRONTEND_BASE_URL}/app?upgrade=success`. With `stripe listen`
forwarding to `{BACKEND}/billing/webhook` (see SKILL.md §3), Stripe posts real
`checkout.session.completed` then `customer.subscription.created/updated`. If you are **not** behind
a running `stripe listen`, replay the equivalent with `.pi/skills/clerk-stripe-operator/scripts/webhook-driver.sh --event=customer.subscription.created`.

### 4. Assert entitlement
- `GET {BACKEND}/usage` → expect `"tier": "premium"` for that owner.
- Or `debug-state.sh` to read the `subscriptions` row (`plan='premium', status='active'`).
- For a teardown/rollback, run the deleted-event via `webhook-driver.sh --admin-destroy
  --event=customer.subscription.deleted` and re-check `/usage` returns `free`.

## Resume / quit
After asserting, if you minted a throwaway identity and want it gone, teardown:
`.pi/skills/clerk-stripe-operator/scripts/clerk-mint.sh --admin-destroy --teardown --user=<id>`.

## Guardrails recap (they apply to the browser leg too)
- Test card fixed to the allowed Stripe test numbers; never a real/saved card.
- Never print or paste a key; the browser never sees one, only an established cookie/token.
- Human handoff is mandatory at any Stripe challenge; no automation retries against anti-bot.
- Destructive teardown still requires `--admin-destroy`.
