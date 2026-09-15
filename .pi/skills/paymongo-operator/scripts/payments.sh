#!/usr/bin/env bash
# payments.sh — operator helper for the ONE-TIME payment path (BILLING_MODE=period, the launch mode).
#
#   --list-payments [--limit=N]                recent payments (id, amount, status, fee)
#   --create-period [--amount=49900] [--desc=] create + attach a Maya Payment Intent and print the
#                                              redirect URL. This is the same sequence
#                                              `payments.start_period_purchase` runs, so an agent can
#                                              walk the real journey without the browser.
#   --refund --payment-id=pay_x [--amount=N]   refund a paid payment (needs --admin-destroy)
#   --list-webhooks                            registered endpoints
#   --register-webhook --url=https://…         register an endpoint for the period-mode events
#
# Reads (never prints): PAYMONGO_SECRET_KEY. Live keys are refused. Amounts are in CENTAVOS
# (49900 = ₱499). Needs NO account capability — unlike Subscriptions, which PayMongo enables by hand.
#
# Delivering an event INTO the app is webhook-driver.sh's job, not this script's:
#   webhook-driver.sh --event=payment.paid --intent=pi_x        → credits PREMIUM_PERIOD_DAYS
set -euo pipefail
_ENGINE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$_ENGINE_DIR/_env.sh"

API="https://api.paymongo.com"
ADMINDESTROY=0
MODE=""
AMOUNT=49900
LIMIT=10
DESC="Maxterview Premium (30 days)"
URL=""
PAYMENT_ID=""
# Both are registered on the endpoint: either may be the only one a method emits, and the app's
# period write is a compare-and-set, so a double delivery cannot buy two periods.
EVENTS='["payment.paid","payment_intent.succeeded","payment.failed"]'

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
    intent=$(_post /v1/payment_intents "$(printf '{"data":{"attributes":{"amount":%s,"currency":"PHP","payment_method_allowed":["paymaya","card"],"capture_type":"automatic","description":"%s"}}}' "$AMOUNT" "$DESC")")
    intent_id=$(printf '%s' "$intent" | grep -o '"id": *"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"/\1/')
    client_key=$(printf '%s' "$intent" | grep -o '"client_key": *"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"/\1/')
    pm=$(_post /v1/payment_methods '{"data":{"attributes":{"type":"paymaya"}}}')
    pm_id=$(printf '%s' "$pm" | grep -o '"id": *"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"/\1/')
    echo "  intent: $intent_id  (payable only through the redirect below)"
    # The client_key form is the one a real run against this account accepted (backend
    # `_redirect_for_intent` sends it first and never had to fall back), so there is no second shape
    # to hedge here.
    attach=$(_post "/v1/payment_intents/$intent_id/attach" "$(printf '{"data":{"attributes":{"payment_method":"%s","return_url":"%s/app?upgrade=pending","client_key":"%s"}}}' "$pm_id" "${FRONTEND_BASE_URL:-http://localhost:5173}" "$client_key")")
    url=$(printf '%s' "$attach" | grep -o '"url": *"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"/\1/')
    [ -n "$url" ] || { echo "  FAILED: no redirect URL"; exit 5; }
    echo "  redirect: $url"
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
  *) echo "usage: payments.sh --list-payments [--limit=N] | --create-period [--amount=49900] | --refund --payment-id=pay_x --admin-destroy | --list-webhooks | --register-webhook --url=https://…"; exit 2 ;;
esac
