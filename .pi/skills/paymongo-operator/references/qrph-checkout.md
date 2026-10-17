# Real QR Ph payment through the browser (the "upgrade" leg)

The shipping rail is `BILLING_MODE=period` on **QR Ph**: one-time Payment Intent → a QR drawn in the
SPA → `payment.paid` → 30 days of premium. Nothing redirects. `POST /api/billing/checkout` answers
`{"qr": {image_url, expires_at}}`, `QrCheckout.tsx` renders it and polls `GET /api/usage` until the
webhook flips the tier. A redirect method answers `{"url": …}` and would need nothing new here, but
none is enabled on this account (Maya and cards need KYB) — see SKILL.md §1.

Drive the browser with the `playwright` MCP server declared in `.pi/mcp.json`
(`mcp__playwright__browser_*`, called from a codemode script) as the `hermetic-e2e` skill documents.

> **Human-in-the-loop only where a wallet is.** TEST mode: the QR comes with
> `next_action.code.test_url`, a sandbox page that completes the payment with no wallet, so the leg is
> fully automatable (`payments.sh --create-period` prints it). LIVE mode: a real wallet scans, so never
> automate it.

## Preconditions

- `PAYMONGO_SECRET_KEY` (test) + `FRONTEND_BASE_URL`; `need-keys.sh` green.
- Backend + frontend reachable (`make up`; frontend on :5173).
- Either the Clerk testing session from `clerk-mint.sh` (set the `__session` cookie on the frontend
  origin via `context.add_cookies`), or `CLERK_ENABLED=false` dev mode, where every call is `DEV_USER`.

## Procedure

### 1. Drive the SPA to the Upgrade UX

- `page.goto("{FRONTEND_BASE_URL}/settings/billing")` (or the `UpgradeNotice` CTA mid-interview), click
  Upgrade → `POST /api/billing/checkout`.
- Expect the QR modal: an `<img>` whose `src` is a `data:image/png;base64,…` URI, the wallet line, and
  a countdown to `expires_at` (30 min, the provider's own deadline).
- Pressing Upgrade again re-serves the SAME code while it is payable, so a closed popup or a reload
  costs nothing.
- A 409 here is the server's own `detail`: "Add an email to your account", "Your subscription already
  covers the current period", "Payment already received", or "Your payment is being processed".

### 2. Complete the payment

- TEST mode: open that intent's `test_url` (`payments.sh --create-period`, or
  `GET /v1/payment_intents/pi_…` → `next_action.code.test_url`) and complete it.
- LIVE mode: scan the QR with a real wallet or bank app. The code carries the amount and is single-use.

### 3. Let the webhook round-trip

There is no return URL on this rail, so the modal is the guard: it polls `GET /api/usage` every 4s,
keeps polling for 2 min past expiry, and reloads the page when the tier flips. PayMongo has **no CLI
and no events API**, so when the app is only on localhost deliver the equivalent instead:

```bash
.pi/skills/paymongo-operator/scripts/webhook-driver.sh --event=payment.paid --intent=pi_…
```

(`payment_intent.succeeded` is accepted by the handler but the account refuses to register it — see
SKILL.md §2.) The credit is a compare-and-set on
`provider_subscription_id = pi_… AND status = 'incomplete'`, so a replay, the sibling event type or a
PayMongo retry cannot buy two periods; a refused write logs `paymongo.webhook.payment_not_credited`.
If a retried checkout finds the stored intent already `succeeded`, it credits the period there instead
of selling a second one.

### 4. Assert entitlement

- `GET {BACKEND}/api/usage` → `"tier": "premium"`, `"billing_mode": "period"`, `premium_until` ~30
  days out.
- Or `debug-state.sh` for the row: `plan='premium'`, `status='active'`.
- Teardown: `POST /api/billing/cancel` records no-renewal; the paid period keeps serving until
  `current_period_end` (that is intended, not a bug).

## Keyless shortcut (no PayMongo account at all)

Skip this reference: seed the row and drive the webhook directly (SKILL.md §4). That proves
`webhook → subscriptions → resolve_tier → /api/usage` with no keys, and is what CI-shaped checks
should assert on.

## Guardrails recap

- Never a real wallet or card; test mode's `test_url` is the only payment this leg automates.
- Never print or paste a key — the browser only ever sees an established cookie or session.
- The QR is not proof of payment; only the signed webhook (or a server-side
  `GET /v1/payment_intents/{id}`) is.
- Destructive teardown still requires `--admin-destroy`.
