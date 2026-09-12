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
#   webhook-driver.sh --event=subscription.invoice.paid --subscription=subs_1
#   webhook-driver.sh --simulate --event=subscription.updated --status=cancelled --subscription=subs_1 --admin-destroy
#
# Reads (never prints): PAYMONGO_WEBHOOK_SECRET. Backend root from BACKEND_URL (default
# http://localhost:8000). A subscription event needs an existing `subscriptions` row whose
# provider ids match --customer/--subscription, otherwise the handler can't resolve an owner and
# deliberately writes nothing.
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
AMOUNT=49900

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
  subscription.invoice.paid|subscription.invoice.payment_failed) ;;
  "") echo "usage: webhook-driver.sh --event=<type> [--simulate] [--subscription=subs_x] [--customer=cus_x] [--status=active|past_due|cancelled] [--admin-destroy]"; exit 2 ;;
  *) echo "refused: unsupported event '$EVENT' (see usage for the handled set)"; exit 2 ;;
esac

# Build the resource the handler switches on: `subscription` for subscription.*, `invoice` for
# subscription.invoice.* (invoice events carry the subscription id as `resource_id`).
if [ "${EVENT#subscription.invoice.}" != "$EVENT" ]; then
  RESOURCE="invoice"
  ATTRS=$(printf '{"id":"inv_demo","amount":%s,"currency":"PHP","resource_id":"%s","status":"%s","due_date":"2026-09-14"}' \
    "$AMOUNT" "$SUBSCRIPTION" "$STATUS")
else
  RESOURCE="subscription"
  ATTRS=$(printf '{"id":"%s","customer_id":"%s","plan_id":"%s","status":"%s","next_billing_schedule":"%s"}' \
    "$SUBSCRIPTION" "$CUSTOMER" "$PLAN" "$STATUS" "$NEXT_BILLING")
fi

body=$(mktemp); trap 'rm -f "$body"' EXIT; chmod 600 "$body"
# The newer envelope shape (data.type/livemode/data); the handler also accepts the older
# data.attributes.* one, and this script exists to exercise the documented one.
printf '{"data":{"type":"%s","livemode":false,"data":{"id":"%s","type":"%s","attributes":%s}}}' \
  "$EVENT" "$SUBSCRIPTION" "$RESOURCE" "$ATTRS" > "$body"

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
