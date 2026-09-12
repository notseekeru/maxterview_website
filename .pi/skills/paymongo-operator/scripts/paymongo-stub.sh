#!/usr/bin/env bash
# stripe-stub.sh — operator helper: read/create a throwaway Stripe object (price/customer) on the
# real TEST account. Destructive (drop) requires --admin-destroy.
# Reads (never prints): STRIPE_SECRET_KEY. Returns ids as "price-id ..." / "customer-id ..." lines.
set -euo pipefail
_ENGINE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$_ENGINE_DIR/_env.sh"

API="https://api.stripe.com/v1"
ADMINDESTROY=0
MODE="read"        # read | create-price | create-customer | drop
TARGET=""
AMOUNT="999"
CURRENCY="usd"

for a in "$@"; do
  case "$a" in
    --admin-destroy) ADMINDESTROY=1 ;;
    --read-price|--read-customer) MODE="$a"; MODE="${MODE#--read-}" ;;
    --create-price)  MODE="create-price" ;;
    --create-customer) MODE="create-customer" ;;
    --drop)          MODE="drop" ;;
    --price=*)       TARGET="${a#--price=}" ;;
    --customer=*)    TARGET="${a#--customer=}" ;;
    --id=*)          TARGET="${a#--id=}" ;;
    *) echo "unexpected arg: $a"; exit 2 ;;
  esac
done

if [ -z "${STRIPE_SECRET_KEY:-}" ]; then echo "refused: STRIPE_SECRET_KEY unset"; exit 1; fi
case "$STRIPE_SECRET_KEY" in *_live_*) echo "refused: live Stripe key"; exit 1;; esac
AUTH="Authorization: Bearer $STRIPE_SECRET_KEY"
echo "== Stripe operator == (test account; never prints keys) == "

case "$MODE" in
  read)
    if [ -n "${STRIPE_PRICE_ID:-}" ]; then
      echo "GET $API/prices (your STRIPE_PRICE_ID present but not printed). Listing a few active:"
      curl -fsS -H "$AUTH" "$API/prices?limit=5&active=true" | \
        sed -n 's/.*"id":"\(price_[^"]*\)".*/\1/p' | sort -u || true
    fi
    ;;
  create-price)
    echo "POST $API/prices  (amount $AMOUNT $CURRENCY, recurring monthly)"
    out=$(curl -fsS -H "$AUTH" -H "Content-Type: application/x-www-form-urlencoded" \
      -X POST "$API/prices" \
      --data-urlencode "currency=$CURRENCY" \
      --data-urlencode "unit_amount=$AMOUNT" \
      --data-urlencode "recurring[interval]=month" \
      --data-urlencode "product_data[name]=maxterview premium test")
    pid=$(printf '%s' "$out" | sed -n 's/.*"id":"\(price_[^"]*\)".*/\1/p' | head -1)
    echo "new-price-id  ${pid:-FAILED}"
    echo "  set STRIPE_PRICE_ID=$pid in backend/.env if you want the app's /api/billing/checkout to use it."
    ;;
  create-customer)
    echo "POST $API/customers"
    out=$(curl -fsS -H "$AUTH" -H "Content-Type: application/x-www-form-urlencoded" \
      -X POST "$API/customers" --data-urlencode "description=maxterview operator customer")
    cid=$(printf '%s' "$out" | sed -n 's/.*"id":"\(cus_[^"]*\)".*/\1/p' | head -1)
    echo "new-customer-id  ${cid:-FAILED}"
    ;;
  drop)
    if [ "$ADMINDESTROY" != 1 ]; then echo "refused: drop requires --admin-destroy"; exit 3; fi
    if [ -z "$TARGET" ]; then echo "refused: drop needs --id=<price/cus id>"; exit 2; fi
    kind="customers"; case "$TARGET" in price_*) kind="prices";; esac
    echo "DELETE $API/$kind/$TARGET  (running)"
    curl -fsS -H "$AUTH" -X DELETE "$API/$kind/$TARGET" >/dev/null || echo "  note: many Stripe objects archive, not hard-delete; DELETE may 405 for some."
    echo "requested removal of $TARGET"
    ;;
  *) echo "unimplemented mode"; exit 2 ;;
esac
