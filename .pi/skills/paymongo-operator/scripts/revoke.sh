#!/usr/bin/env bash
# revoke.sh: end one owner's premium NOW: a chargeback, or a refund the webhook missed.
#
# Why this is a script and not an endpoint: this account has NO dispute signal at all: `dispute.*`
# and the docs' newer `refund.succeeded` are refused at webhook registration as invalid event types,
# `GET /v1/disputes` answers `access_denied` (all measured 2026-09-27), and `POST /v1/refunds` refuses
# a QR Ph payment outright, so a refund only ever arrives as `payment.refunded`. Disputes are seen in
# the PayMongo dashboard, and the app has no admin surface to act on one.
#
# The write is the same one `payments._revoke` makes: `plan='free'` plus a status that is NOT in
# `billing.ENTITLED_STATUSES`, so the next read downgrades: no job, no cache to bust. A later
# purchase overwrites the row, so this is not a ban.
#
#   revoke.sh --owner=<clerk sub> [--status=disputed] --admin-destroy
#   revoke.sh --intent=pi_x      [--status=refunded] --admin-destroy   (the row's stored provider id)
#   revoke.sh --customer=cus_x   [--status=disputed] --admin-destroy
#
# Reads (never prints): DATABASE_URL / PSQL_DSN: point it at the database whose entitlement you mean
# (the local compose one by default, i.e. NOT production unless you say so explicitly).
set -euo pipefail
_ENGINE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$_ENGINE_DIR/_env.sh"

OWNER=""
INTENT=""
CUSTOMER=""
STATUS="disputed"
ADMINDESTROY=0

for a in "$@"; do
  case "$a" in
    --admin-destroy) ADMINDESTROY=1 ;;
    --owner=*) OWNER="${a#--owner=}" ;;
    --intent=*) INTENT="${a#--intent=}" ;;
    --customer=*) CUSTOMER="${a#--customer=}" ;;
    --status=*) STATUS="${a#--status=}" ;;
    *) echo "unexpected arg: $a"; exit 2 ;;
  esac
done

case "$STATUS" in disputed|refunded) ;; *) echo "refused: --status must be disputed or refunded"; exit 2 ;; esac

# One of the three, and exactly one: an ambiguous predicate would revoke the wrong rows.
if [ -n "$OWNER" ]; then COL=owner_id; VAL="$OWNER"
elif [ -n "$INTENT" ]; then COL=provider_subscription_id; VAL="$INTENT"
elif [ -n "$CUSTOMER" ]; then COL=provider_customer_id; VAL="$CUSTOMER"
else echo "usage: revoke.sh (--owner=<clerk sub> | --intent=pi_x | --customer=cus_x) [--status=disputed|refunded] --admin-destroy"; exit 2
fi

if [ "$ADMINDESTROY" != 1 ]; then
  echo "refused: '$STATUS' takes entitlement away from $COL=$VAL; add --admin-destroy"
  exit 3
fi

uri="${PSQL_DSN:-${DATABASE_URL:-}}"
[ -n "$uri" ] || { echo "refused: DATABASE_URL (or PSQL_DSN) unset: export the database you mean first"; exit 1; }
command -v psql >/dev/null 2>&1 || { echo "refused: psql not on PATH (nix shell nixpkgs#postgresql)"; exit 1; }

# `returning` both statements so the operator sees the row they removed, not just a count. The query
# goes in on stdin: psql's `-c` does not interpolate `:'val'`.
_q() {
  PGPASSWORD="$(printf '%s' "$uri" | sed -E 's#.*://[^:]*:([^@]*)@.*#\1#')" \
    psql "$uri" -v ON_ERROR_STOP=1 -v val="$VAL" -v st="$STATUS" <<SQL
$1
SQL
}

echo "== row before =="
_q "SELECT owner_id, plan, status, current_period_end FROM subscriptions WHERE $COL = :'val';"
echo "== revoking =="
_q "UPDATE subscriptions SET plan = 'free', status = :'st', updated_at = now() WHERE $COL = :'val' AND plan = 'premium' RETURNING owner_id, plan, status, current_period_end;"
echo "== done: re-run debug-state.sh (or GET /api/usage as that user); the period is gone, not held =="
