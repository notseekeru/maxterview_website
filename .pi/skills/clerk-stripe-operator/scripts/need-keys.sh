#!/usr/bin/env bash
# need-keys.sh — zero-touch liveness/report of Clerk+Stripe operator config.
# NEVER prints a value; only prints set/missing + a paste-me template for missing ones.
# Exit 0 if the required operator vars are set (test-mode), 1 if anything required is missing.
set -euo pipefail
_ENGINE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$_ENGINE_DIR/_env.sh"

# Vars the operator needs. Format: "VARNAME|label"
REQUIRED=(
  "CLERK_SECRET_KEY|Clerk test secret (sk_test_)"
  "STRIPE_SECRET_KEY|Stripe test secret (sk_test_)"
  "STRIPE_PRICE_ID|Stripe premium price id"
)

# Helpful but not strictly hard-required (fall back gracefully when absent).
OPTIONAL=(
  "CLERK_FRONTEND_API|Clerk Frontend API host (browser auth only)"
  "CLERK_PUBLISHABLE_KEY_PREVIEW|Clerk publishable key (browser auth only)"
  "STRIPE_WEBHOOK_SECRET|Stripe webhook secret (whsec_; webhook proof)"
  "FRONTEND_BASE_URL|Frontend base URL for portals"
)

missing=""
echo "== Clerk + Stripe operator key liveness (values never printed) =="

for entry in "${REQUIRED[@]}"; do
  var="${entry%%|*}"; label="${entry#*|}"
  val="${!var:-}"
  if [ -n "$val" ]; then
    # Reject live keys outright.
    case "$val" in
      *_live_*) echo "  ✗ $var ($label): PRESENT but LIVE (**sk_live_...) — operator refuses live. Set a TEST key." ; missing="$missing $var" ;;
      *)        echo "  ✓ $var ($label)" ;;
    esac
  else
    echo "  ✗ $var ($label): missing"
    missing="$missing $var"
  fi
done

echo "-- optional (needed for full browser / webhook round-trips) --"
for entry in "${OPTIONAL[@]}"; do
  var="${entry%%|*}"; label="${entry#*|}"
  val="${!var:-}"
  if [ -n "$val" ]; then
    case "$val" in
      *_live_*) echo "  ✗ $var ($label): LIVE (refused)" ;;
      *)        echo "  ✓ $var ($label)" ;;
    esac
  else
    echo "  ~ $var ($label): unset (feature degrades but operator runs)"
  fi
done

if [ -n "$missing" ]; then
  echo ""
  echo "Paste these into backend/.env (git-ignored). Fill ONLY the <...> parts; values stay local:"
  cat <<'EOF'
CLERK_SECRET_KEY=<sk_test_... from Clerk dashboard: https://dashboard.clerk.com/apps/.../keys>
STRIPE_SECRET_KEY=<sk_test_... from https://dashboard.stripe.com/test/apikeys>
STRIPE_PRICE_ID=<price_... of your monthly premium; find in dashboard products or create now>
# optional:
CLERK_FRONTEND_API=<your-instance>.clerk.accounts        # from your Clerk instance, browser-auth only
CLERK_PUBLISHABLE_KEY_PREVIEW=pk_test_...               # the one frontend/.env uses, browser-auth only
STRIPE_WEBHOOK_SECRET=whsec_...                          # from `stripe listen` output, webhook proof
FRONTEND_BASE_URL=http://localhost:5173                 # default already used by app
EOF
  echo ""
  echo "See .pi/skills/clerk-stripe-operator/SKILL.md §2-§3 for where each lives."
  exit 1
fi

echo ""
echo "OK: all required TEST keys are present. Operator is usable."
exit 0
