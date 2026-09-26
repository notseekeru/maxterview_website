#!/usr/bin/env bash
# payments.sh — operator helper for the one-time payment path (BILLING_MODE=period, the launch mode).
#
#   --list-payments [--limit=N]                recent payments (id, amount, status, fee)
#   --create-period [--amount=9900] [--desc=]  create + attach a QR Ph Payment Intent (the sequence
#                                              `start_period_purchase` runs) and print the code's id,
#                                              expiry and (test mode) the test_url that pays it
#   --refund --payment-id=pay_x [--amount=N]   refund a paid payment (needs --admin-destroy)
#   --list-webhooks                            registered endpoints
#   --register-webhook --url=https://…         register an endpoint for the period-mode events
#
# Reads (never prints): PAYMONGO_SECRET_KEY. Live keys are refused. Amounts are in CENTAVOS.
# Delivering an event INTO the app is webhook-driver.sh's job:
#   webhook-driver.sh --event=payment.paid --intent=pi_x   → credits PREMIUM_PERIOD_DAYS
set -euo pipefail
_ENGINE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$_ENGINE_DIR/_env.sh"

API="https://api.paymongo.com"
ADMINDESTROY=0
MODE=""
AMOUNT=9900
LIMIT=10
DESC="Maxterview Premium (30 days)"
URL=""
PAYMENT_ID=""
# `payment.paid` is the event period mode emits and the only one this account accepts: live-mode
# registration REJECTS `payment_intent.succeeded` ("invalid event type", verified 2026-09-17) and
# `payment.failed` was never registered. The app still accepts `payment_intent.succeeded` for
# accounts that do emit it, and its period write is a compare-and-set, so a duplicate or sibling
# delivery cannot buy two periods.
EVENTS='["payment.paid"]'

for a in "$@"; do
  case "$a" in
    --admin-destroy) ADMINDESTROY=1 ;;
    --list-payments|--create-period|--refund|--list-webhooks|--register-webhook) MODE="${a#--}" ;;
    --amount=*) AMOUNT="${a#--amount=}" ;;
    --limit=*) LIMIT="${a#--limit=}" ;;
    --desc=*) DESC="${a#--desc=}" ;;
    --url=*) URL="${a#--url=}" ;;
    --payment-id=*) PAYMENT_ID="${a#--payment-id=}" ;;
    *) echo "unexpected arg: $a"; exit 2 ;;
  esac
done

[ -n "${PAYMONGO_SECRET_KEY:-}" ] || { echo "refused: PAYMONGO_SECRET_KEY unset"; exit 1; }
case "$PAYMONGO_SECRET_KEY" in *_live_*) echo "refused: live PayMongo key"; exit 1 ;; esac
AUTH="Authorization: Basic $(printf '%s:' "$PAYMONGO_SECRET_KEY" | base64 | tr -d '\n')"

_get() { curl -fsS -H "$AUTH" "$API$1"; }
_post() { curl -fsS -H "$AUTH" -H 'Content-Type: application/json' -X POST "$API$1" -d "$2"; }

# node when present (structured), else a grep of ids — the stub script's convention.
_rows() {
  if command -v node >/dev/null 2>&1; then
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);
      for(const r of (j.data?[].concat(j.data):[])){const a=r.attributes||{};
        console.log(`  ${r.id}  ${a.amount??""} ${a.currency??""} ${a.status??""} ${a.fee!==undefined?"fee="+a.fee:""} ${a.payment_intent_id??""}`)}})'
  else
    grep -o '"id": *"[^"]*"' | sed -E 's/.*"([^"]*)"/  \1/'
  fi
}

case "$MODE" in
  list-payments)
    echo "== payments (last $LIMIT) =="
    _get "/v1/payments?limit=$LIMIT" | _rows
    ;;
  create-period)
    echo "== creating a one-time intent for ₱$((AMOUNT / 100)) =="
    intent=$(_post /v1/payment_intents "$(printf '{"data":{"attributes":{"amount":%s,"currency":"PHP","payment_method_allowed":["qrph"],"capture_type":"automatic","description":"%s"}}}' "$AMOUNT" "$DESC")")
    intent_id=$(printf '%s' "$intent" | grep -o '"id": *"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"/\1/')
    client_key=$(printf '%s' "$intent" | grep -o '"client_key": *"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"/\1/')
    pm=$(_post /v1/payment_methods '{"data":{"attributes":{"type":"qrph"}}}')
    pm_id=$(printf '%s' "$pm" | grep -o '"id": *"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"/\1/')
    echo "  intent: $intent_id  (payable only through the QR below)"
    # The client_key form is the one a real run against this account accepted (backend
    # `_payable_intent` sends it first and never had to fall back), so there is no second shape
    # to hedge here.
    attach=$(_post "/v1/payment_intents/$intent_id/attach" "$(printf '{"data":{"attributes":{"payment_method":"%s","return_url":"%s/dashboard?upgrade=pending","client_key":"%s"}}}' "$pm_id" "${FRONTEND_BASE_URL:-http://localhost:5173}" "$client_key")")
    printf '%s' "$attach" | grep -qE '"(url|image_url)"' || { echo "  FAILED: nothing payable came back"; exit 5; }
    # The image is a ~14 KB base64 data URI, so print what a human acts on instead of the artifact:
    # QR Ph answers `next_action.code` and never a redirect, and test mode adds the `test_url` that
    # completes the payment with no wallet at all.
    if command -v node >/dev/null 2>&1; then
      printf '%s' "$attach" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        const a=((JSON.parse(s).data||{}).attributes||{}).next_action||{};
        if(a.redirect)return console.log("  redirect: "+a.redirect.url);
        const c=a.code||{};
        console.log(`  qr: ${c.id}  expires ${c.expires_at}  ${c.amount} centavos`);
        if(c.test_url)console.log("  test_url (pays it without a wallet): "+c.test_url)})'
    else
      printf '%s' "$attach" | grep -o '"expires_at": *"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"/  qr expires: \1/'
    fi
    echo "  next: pay it in a browser, then  webhook-driver.sh --event=payment.paid --intent=$intent_id"
    ;;
  refund)
    [ -n "$PAYMENT_ID" ] || { echo "refused: --payment-id=pay_x required"; exit 2; }
    if [ "$ADMINDESTROY" != 1 ]; then echo "refused: --refund moves real test money; add --admin-destroy"; exit 3; fi
    echo "== refunding ${AMOUNT} centavos of $PAYMENT_ID =="
    _post /v1/refunds "$(printf '{"data":{"attributes":{"amount":%s,"payment_id":"%s","reason":"requested_by_customer"}}}' "$AMOUNT" "$PAYMENT_ID")" | _rows
    ;;
  list-webhooks)
    echo "== webhook endpoints =="
    _get /v1/webhooks | _rows
    ;;
  register-webhook)
    [ -n "$URL" ] || { echo "refused: --url=https://… required (PayMongo must reach it)"; exit 2; }
    echo "== registering $URL =="
    # The response carries a signing secret. It is NOT printed (zero-touch): read it from
    # Dashboard → Developers → Webhooks and put it in backend/.env as PAYMONGO_WEBHOOK_SECRET.
    _post /v1/webhooks "$(printf '{"data":{"attributes":{"url":"%s","events":%s}}}' "$URL" "$EVENTS")" \
      | { if command -v node >/dev/null 2>&1; then
            node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=(JSON.parse(s).data||{}).attributes||{};
              console.log("  id:",JSON.parse(s).data?.id,"status:",a.status,"events:",(a.events||[]).join(","))})'
          else grep -o '"id": *"[^"]*"' | head -1; fi; }
    echo "  secret: copy it from the Dashboard into backend/.env as PAYMONGO_WEBHOOK_SECRET (not echoed here)"
    ;;
  *) echo "usage: payments.sh --list-payments [--limit=N] | --create-period [--amount=9900] | --refund --payment-id=pay_x --admin-destroy | --list-webhooks | --register-webhook --url=https://…"; exit 2 ;;
esac
