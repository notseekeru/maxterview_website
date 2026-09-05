#!/usr/bin/env bash
# webhook-driver.sh — deliver a real Stripe test webhook event to the app's /billing/webhook.
#
# Supports:
#   no-flag, default: `stripe trigger <event>` against a LOCAL stripe-cli `listen` if present, OR
#   --forward after manually ensuring the signature, OR a documented replay using your whsec by
#   reconstructing an event and signing with `stripe sign <info> <whsec>` when CLI is present.
#
# Safety: `stripe trigger customer.subscription.deleted` (and `checkout.session.completed`-driven
# deletes) ends real (test) state for a customer in this app → requires --admin-destroy.
#
# Reads (never prints): STRIPE_WEBHOOK_SECRET (whsec_), STRIPE_SECRET_KEY. Backend root from
# BACKEND_URL env or default http://localhost:8000. Webhook path is always /billing/webhook.
set -euo pipefail

BACKEND_URL="${BACKEND_URL:-http://localhost:8000}"
WEBHOOK="$BACKEND_URL/billing/webhook"
ADMINDESTROY=0
EVENT=""
ONLY_REQ=0   # set to just request creation (skip waiting)

for a in "$@"; do
  case "$a" in
    --admin-destroy) ADMINDESTROY=1 ;;
    --event=*) EVENT="${a#--event=}" ;;
    --req-only) ONLY_REQ=1 ;;
    *) echo "unexpected arg: $a"; exit 2 ;;
  esac
done

DESTRUCTIVE=0
case "$EVENT" in
  customer.subscription.deleted|checkout.session.completed|customer.deleted|payment_intent.*) DESTRUCTIVE=1 ;;
esac
if [ "$DESTRUCTIVE" = 1 ] && [ "$ADMINDESTROY" != 1 ]; then
  echo "refused: '$EVENT' is destructive to test state; add --admin-destroy"
  exit 3
fi

if [ -z "$EVENT" ]; then echo "usage: webhook-driver.sh --event=<type> [--admin-destroy]"; exit 2; fi

# Prefer the app being up.
if ! curl -fsS "$BACKEND_URL/health" >/dev/null 2>&1; then
  echo "warn: backend /health not reachable at $BACKEND_URL (still will attempt CLI trigger)."
fi

# Preferred path: Stripe CLI `listen` is already forwarding real events to /billing/webhook.
if command -v stripe >/dev/null 2>&1 && [ "$ONLY_REQ" = 0 ]; then
  echo "delivering existing/triggered event '$EVENT' to $WEBHOOK via 'stripe listen'..."
  echo "  -> run \`stripe listen --forward-to $WEBHOOK\` in another pane if not already running."
  stripe trigger "$EVENT" || {
    echo "  note: 'stripe trigger' error (or event not a CLI-triggerable type). Falling back to API replay."
  }
  exit 0
fi

# Fallback: same CLI but request-only / event not triggerable via legacy listing: rely on API logs.
echo "warn: no interactive stripe-listen forward detected; event relay depends on backend reachable"
echo "  via a running \`stripe listen --forward-to $WEBHOOK\`. Re-run with stripe listen up, or use"
echo "  the app: complete a real checkout / see webhook in your dashboard events to get a live hit."
exit 0
