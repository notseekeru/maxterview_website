#!/usr/bin/env bash
# paymongo-stub.sh — operator helper: read/create a throwaway PayMongo TEST object (plan/customer).
#
#   --create-plan [--amount=9900] [--interval=month] [--name=...]   create the ₱99/mo premium plan
#   --list-plans                                                     list plans (id + amount + interval)
#   --create-customer --email=x@y [--first=..] [--last=..]           create a customer
#   --list-customers                                                 list customers (id + email)
#   --drop-customer --id=cus_x                                       delete a customer (--admin-destroy)
#
# Reads (never prints): PAYMONGO_SECRET_KEY. Live keys are refused. Amounts are in CENTAVOS
# (9900 = ₱99). Plan ids belong in backend/.env as PAYMONGO_PLAN_ID.
set -euo pipefail
_ENGINE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$_ENGINE_DIR/_env.sh"

API="https://api.paymongo.com"
ADMINDESTROY=0
MODE=""
AMOUNT=9900
INTERVAL="month"
PLAN_NAME="Premium monthly"
EMAIL=""
FIRST="Test"
LAST="Member"
TARGET=""

for a in "$@"; do
  case "$a" in
    --admin-destroy) ADMINDESTROY=1 ;;
    --create-plan|--list-plans|--create-customer|--list-customers|--drop-customer) MODE="${a#--}" ;;
    --amount=*) AMOUNT="${a#--amount=}" ;;
    --interval=*) INTERVAL="${a#--interval=}" ;;
    --name=*) PLAN_NAME="${a#--name=}" ;;
    --email=*) EMAIL="${a#--email=}" ;;
    --first=*) FIRST="${a#--first=}" ;;
    --last=*) LAST="${a#--last=}" ;;
    --id=*) TARGET="${a#--id=}" ;;
    *) echo "unexpected arg: $a"; exit 2 ;;
  esac
done

[ -n "${PAYMONGO_SECRET_KEY:-}" ] || { echo "refused: PAYMONGO_SECRET_KEY unset"; exit 1; }
case "$PAYMONGO_SECRET_KEY" in *_live_*) echo "refused: live PayMongo key"; exit 1;; esac
AUTH="Authorization: Basic $(printf '%s:' "$PAYMONGO_SECRET_KEY" | base64 | tr -d '\n')"

# `curl -fsS` keeps failures loud; node pretty-prints when available, otherwise raw JSON is fine.
_get() { curl -fsS -H "$AUTH" "$API$1"; }
_post() { curl -fsS -H "$AUTH" -H 'Content-Type: application/json' -X POST "$API$1" -d "$2"; }
_delete() { curl -fsS -H "$AUTH" -X DELETE "$API$1"; }

_pick() { # _pick <json> <jq-ish grep> — node when present, else grep the ids
  if command -v node >/dev/null 2>&1; then
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const rows=j.data?[].concat(j.data):[];for(const r of rows){const a=r.attributes||{};console.log(`  ${r.id}  ${a.amount??a.email??""} ${a.interval??""} ${a.name??(a.first_name||"")+((a.last_name)?" "+a.last_name:"")}`)}})'
  else
    grep -o '"id": *"[^"]*"' | sed -E 's/.*"([^"]*)"/  \1/'
  fi
}

case "$MODE" in
  create-plan)
    echo "== creating plan ₱$((AMOUNT / 100))/$INTERVAL ($AMOUNT centavos) =="
    _post /v1/subscriptions/plans "$(printf '{"data":{"attributes":{"name":"%s","amount":%s,"currency":"PHP","interval":"%s","interval_count":1}}}' "$PLAN_NAME" "$AMOUNT" "$INTERVAL")" | _pick
    echo "  put the plan id in backend/.env as PAYMONGO_PLAN_ID"
    ;;
  list-plans)
    echo "== plans =="
    _get /v1/subscriptions/plans | _pick
    ;;
  create-customer)
    [ -n "$EMAIL" ] || { echo "refused: --email is required (PayMongo keys customers by unique email)"; exit 2; }
    echo "== creating customer $EMAIL =="
    _post /v1/customers "$(printf '{"data":{"attributes":{"first_name":"%s","last_name":"%s","email":"%s"}}}' "$FIRST" "$LAST" "$EMAIL")" | _pick
    ;;
  list-customers)
    echo "== customers =="
    _get /v1/customers | _pick
    ;;
  drop-customer)
    [ -n "$TARGET" ] || { echo "refused: --id=cus_x required"; exit 2; }
    if [ "$ADMINDESTROY" != 1 ]; then echo "refused: --drop-customer is destructive; add --admin-destroy"; exit 3; fi
    echo "== deleting customer $TARGET =="
    _delete "/v1/customers/$TARGET" >/dev/null && echo "  deleted $TARGET (any vaulted card is unusable)"
    ;;
  *) echo "usage: paymongo-stub.sh --create-plan|--list-plans|--create-customer --email=x|--list-customers|--drop-customer --id=cus_x [--admin-destroy]"; exit 2 ;;
esac
