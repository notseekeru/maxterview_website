#!/usr/bin/env bash
# webhook-driver.sh — deliver a PayMongo billing event to the app.
#
# Two delivery modes:
#   (default)    POST /api/billing/webhook signed with PAYMONGO_WEBHOOK_SECRET
#                (`Paymongo-Signature: t=<unix>,te=<hmac-sha256 of "{t}.{raw_body}">`) — this
#                exercises the real signature check.
#   --simulate   POST /api/billing/webhook/simulate, the dev/test-only shortcut that skips the
#                signature. PayMongo has no `stripe listen` equivalent, so this (plus this script's
#                signed mode) is how local webhooks get tested without a tunnel.
#
# Examples:
#   webhook-driver.sh --event=subscription.activated --customer=cus_1 --subscription=subs_1
#   webhook-driver.sh --event=subscription.updated --status=past_due --subscription=subs_1
#   webhook-driver.sh --event=payment.paid --intent=pi_x          (period mode: buys 30 days)
#   webhook-driver.sh --simulate --event=payment_intent.succeeded --intent=pi_x
#
# Reads (never prints): PAYMONGO_WEBHOOK_SECRET. Backend root from BACKEND_URL (default
# http://localhost:8000). An event needs an existing `subscriptions` row holding the matching
# provider id (`--intent` for a payment, `--subscription`/`--customer` for a subscription), otherwise
# the handler can't resolve an owner and deliberately writes nothing.
set -euo pipefail
_ENGINE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$_ENGINE_DIR/_env.sh"

BACKEND_URL="${BACKEND_URL:-http://localhost:8000}"
ADMINDESTROY=0
SIMULATE=0
EVENT=""
CUSTOMER="cus_demo"
SUBSCRIPTION="subs_demo"
STATUS="active"
PLAN="plan_demo"
NEXT_BILLING="2026-10-14"
AMOUNT=9900
# Period mode stores the Payment Intent id in `provider_subscription_id`, so `paid` events must name
# an intent that a real pending row holds (see payments.sh --create-period).
INTENT="pi_demo"
PAYMENT_ID="pay_demo"

for a in "$@"; do
  case "$a" in
    --admin-destroy) ADMINDESTROY=1 ;;
    --simulate) SIMULATE=1 ;;
    --event=*) EVENT="${a#--event=}" ;;
    --customer=*) CUSTOMER="${a#--customer=}" ;;
    --subscription=*) SUBSCRIPTION="${a#--subscription=}" ;;
    --status=*) STATUS="${a#--status=}" ;;
    --plan=*) PLAN="${a#--plan=}" ;;
    --next-billing=*) NEXT_BILLING="${a#--next-billing=}" ;;
    --intent=*) INTENT="${a#--intent=}" ;;
    --payment-id=*) PAYMENT_ID="${a#--payment-id=}" ;;
    *) echo "unexpected arg: $a"; exit 2 ;;
  esac
done

# Ending or downgrading entitlement is destructive to test state.
_destructive() {
  [ "$STATUS" = "cancelled" ] || [ "$STATUS" = "incomplete_cancelled" ] || [ "$EVENT" = "subscription.invoice.payment_failed" ]
}
if _destructive && [ "$ADMINDESTROY" != 1 ]; then
  echo "refused: '$EVENT' (status=$STATUS) ends or downgrades entitlement; add --admin-destroy"
  exit 3
fi

case "$EVENT" in
  subscription.activated|subscription.updated|subscription.past_due|subscription.unpaid|\
  subscription.invoice.created|subscription.invoice.finalized|subscription.invoice.updated|\
  subscription.invoice.paid|subscription.invoice.payment_failed|\
  payment.paid|payment.failed|payment_intent.succeeded) ;;
  "") echo "usage: webhook-driver.sh --event=<type> [--simulate] [--subscription=subs_x] [--customer=cus_x] [--intent=pi_x] [--status=active|past_due|cancelled] [--admin-destroy]"; exit 2 ;;
  *) echo "refused: unsupported event '$EVENT' (see usage for the handled set)"; exit 2 ;;
esac

# Build the resource the handler switches on: `subscription` for subscription.*, `invoice` for
# subscription.invoice.* (invoice events carry the subscription id as `resource_id`), `payment` for
# payment.* (carrying the intent it was charged against) and `payment_intent` for
# payment_intent.* (the resource IS the intent).
if [ "${EVENT#subscription.invoice.}" != "$EVENT" ]; then
  RESOURCE="invoice"
  RESOURCE_ID="$SUBSCRIPTION"
  ATTRS=$(printf '{"id":"inv_demo","amount":%s,"currency":"PHP","resource_id":"%s","status":"%s","due_date":"2026-09-14"}' \
    "$AMOUNT" "$SUBSCRIPTION" "$STATUS")
elif [ "$EVENT" = "payment_intent.succeeded" ]; then
  RESOURCE="payment_intent"
  RESOURCE_ID="$INTENT"
  ATTRS=$(printf '{"id":"%s","amount":%s,"currency":"PHP","status":"succeeded"}' "$INTENT" "$AMOUNT")
elif [ "${EVENT#payment.}" != "$EVENT" ]; then
  RESOURCE="payment"
  RESOURCE_ID="$PAYMENT_ID"
  PAID_STATUS="failed"; [ "$EVENT" = "payment.paid" ] && PAID_STATUS="paid"
  ATTRS=$(printf '{"id":"%s","amount":%s,"currency":"PHP","status":"%s","payment_intent_id":"%s"}' \
    "$PAYMENT_ID" "$AMOUNT" "$PAID_STATUS" "$INTENT")
else
  RESOURCE="subscription"
  RESOURCE_ID="$SUBSCRIPTION"
  ATTRS=$(printf '{"id":"%s","customer_id":"%s","plan_id":"%s","status":"%s","next_billing_schedule":"%s"}' \
    "$SUBSCRIPTION" "$CUSTOMER" "$PLAN" "$STATUS" "$NEXT_BILLING")
fi

body=$(mktemp); trap 'rm -f "$body"' EXIT; chmod 600 "$body"
# The newer envelope shape (data.type/livemode/data); the handler also accepts the older
# data.attributes.* one, and this script exists to exercise the documented one.
printf '{"data":{"type":"%s","livemode":false,"data":{"id":"%s","type":"%s","attributes":%s}}}' \
  "$EVENT" "$RESOURCE_ID" "$RESOURCE" "$ATTRS" > "$body"

if [ "$SIMULATE" = 1 ]; then
  url="$BACKEND_URL/api/billing/webhook/simulate"
  echo "POST $url  ($EVENT, unsigned — dev/test only)"
  code=$(curl -sS -o /tmp/webhook-driver.out -w '%{http_code}' -X POST "$url" \
    -H 'Content-Type: application/json' --data-binary "@$body")
else
  if [ -z "${PAYMONGO_WEBHOOK_SECRET:-}" ]; then echo "refused: PAYMONGO_WEBHOOK_SECRET unset (needed to sign); use --simulate"; exit 1; fi
  url="$BACKEND_URL/api/billing/webhook"
  t=$(date +%s)
  # Sign over the exact bytes we POST: HMAC-SHA256 of "{t}.{raw_body}", keyed by the endpoint secret.
  sig=$( { printf '%s.' "$t"; cat "$body"; } | openssl dgst -sha256 -hmac "$PAYMONGO_WEBHOOK_SECRET" | awk '{print $NF}')
  echo "POST $url  ($EVENT, signed te=…)"
  code=$(curl -sS -o /tmp/webhook-driver.out -w '%{http_code}' -X POST "$url" \
    -H 'Content-Type: application/json' -H "Paymongo-Signature: t=$t,te=$sig" --data-binary "@$body")
fi

echo "  -> HTTP $code $(head -c 200 /tmp/webhook-driver.out)"
rm -f /tmp/webhook-driver.out
[ "$code" = 200 ] || exit 5
echo "  then: $_ENGINE_DIR/debug-state.sh   (or GET /api/usage as that user)"
