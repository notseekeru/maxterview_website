#!/usr/bin/env bash
# debug-state.sh — read-only backend state dump for billing/entitlement triage.
# Prints recent `subscriptions` rows (mapped to owner) and the app's current quota/tier, without
# secrets. Requires the backend API to be reachable.
#
# Reads (never prints): DATABASE_URL (psql path only when a DB is up), backend host from
# BACKEND_URL env (default http://localhost:8000). Never runs destructive SQL.
set -euo pipefail
_ENGINE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$_ENGINE_DIR/_env.sh"

BACKEND_URL="${BACKEND_URL:-http://localhost:8000}"

echo "== backend health =="
curl -fsS "$BACKEND_URL/health" || { echo "backend unreachable at $BACKEND_URL"; exit 1; }

echo ""
echo "== GET /usage (current caller tier/quota) =="
# Usage is identity-scoped; with no __session cookie the app returns DEV_USER (dev fallback). For a
# real user, send the dev fallback only; a real run would carry its __session. We show DEV view if
# CLERK disabled in backend. Just surface whatever it gives.
curl -fsS "$BACKEND_URL/usage" || true; echo ""

echo ""
echo "== subscriptions table (owner_id mapped; never prints secrets) =="
# Prefer direct SQL via psql when PSQL_DSN / DATABASE_URL is set; otherwise instruct.
if [ -n "${DATABASE_URL:-}" ] || [ -n "${PSQL_DSN:-}" ]; then
  uri="${PSQL_DSN:-$DATABASE_URL}"
  # Try psql; container uses $DATABASE_URL through compose. Replace scheme prefix for psql tools:
  uri_psql="$(printf '%s' "$uri" | sed -E 's#postgres(ql)?://#postgresql://#')"
  echo "rows (last 10, newest first):"
  if command -v psql >/dev/null 2>&1; then
    PGPASSWORD="$(printf '%s' "$uri_psql" | sed -E 's#.*://[^:]*:([^@]*)@.*#\1#')" \
      psql "$uri_psql" -c \
      "SELECT owner_id, stripe_id IS NOT NULL AND stripe_id <> '' AS has_stripe, plan, status, current_period_end FROM subscriptions ORDER BY updated_at DESC LIMIT 10;" 2>/dev/null \
      || echo "  (psql failed; run `make psql` and query manually. DB rows: SELECT owner_id, plan, status FROM subscriptions;)"
  else
    echo "  (psql not on PATH; open `make psql` and run: SELECT owner_id, plan, status FROM subscriptions;)"
  fi
else
  echo "  DATABASE_URL not set in this shell — run via docker backend (compose) or set DATABASE_URL/PSQL_DSN."
  echo "  Suggested: SELECT owner_id, plan, status, current_period_end FROM subscriptions ORDER BY updated_at DESC LIMIT 10;"
fi

echo ""
echo "== blurb =="
echo "To verify a premium flip: complete a checkout/webhook, then GET /usage should read tier: premium."
echo "Remember nothing here touched or printed secrets."
