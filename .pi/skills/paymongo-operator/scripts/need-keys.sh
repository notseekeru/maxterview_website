#!/usr/bin/env bash
# need-keys.sh — zero-touch liveness/report of Clerk+PayMongo operator config.
# NEVER prints a value; only prints set/missing + a paste-me template for missing ones.
# Exit 0 if the required operator vars are set (test-mode), 1 if anything required is missing.
set -euo pipefail
_ENGINE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$_ENGINE_DIR/_env.sh"

# Vars the operator needs. Format: "VARNAME|label"
REQUIRED=(
    "CLERK_SECRET_KEY|Clerk test secret (sk_test_)"
    "PAYMONGO_SECRET_KEY|PayMongo test secret (sk_test_)"
    "PAYMONGO_PLAN_ID|PayMongo premium plan id (plan_…)"
)

# Helpful but not strictly hard-required (fall back gracefully when absent).
OPTIONAL=(
    "CLERK_FRONTEND_API|Clerk Frontend API host (browser auth only)"
    "CLERK_PUBLISHABLE_KEY_PREVIEW|Clerk publishable key (browser auth only)"
    "PAYMONGO_WEBHOOK_SECRET|PayMongo webhook secret (signs deliveries; webhook proof)"
    "FRONTEND_BASE_URL|Frontend base URL for the first-payment return"
)

missing=""
echo "== Clerk + PayMongo operator key liveness (values never printed) =="

for entry in "${REQUIRED[@]}"; do
    var="${entry%%|*}"
    label="${entry#*|}"
    val="${!var:-}"
    if [ -n "$val" ]; then
        # Reject live keys outright.
        case "$val" in
        *_live_*)
            echo "  ✗ $var ($label): PRESENT but LIVE (**sk_live_...) — operator refuses live. Set a TEST key."
            missing="$missing $var"
            ;;
        *) echo "  ✓ $var ($label)" ;;
        esac
    else
        echo "  ✗ $var ($label): missing"
        missing="$missing $var"
    fi
done

echo "-- optional (needed for full browser / webhook round-trips) --"
for entry in "${OPTIONAL[@]}"; do
    var="${entry%%|*}"
    label="${entry#*|}"
    val="${!var:-}"
    if [ -n "$val" ]; then
        case "$val" in
        *_live_*) echo "  ✗ $var ($label): LIVE (refused)" ;;
        *) echo "  ✓ $var ($label)" ;;
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
PAYMONGO_SECRET_KEY=<sk_test_... from https://dashboard.paymongo.com/developers>
PAYMONGO_PLAN_ID=<plan_... of the ₱99/mo premium plan; create with paymongo-stub.sh --create-plan>
# optional:
CLERK_FRONTEND_API=<your-instance>.clerk.accounts        # from your Clerk instance, browser-auth only
CLERK_PUBLISHABLE_KEY_PREVIEW=pk_test_...               # the one frontend/.env uses, browser-auth only
PAYMONGO_WEBHOOK_SECRET=<from the webhook endpoint you register for /api/billing/webhook>
FRONTEND_BASE_URL=http://localhost:5173                 # default already used by app
EOF
    echo ""
    echo "PayMongo support must also enable Subscriptions + Card Vaulting on the account (email support@paymongo.com)."
    echo "See .pi/skills/paymongo-operator/SKILL.md §1-§2 for where each lives."
    exit 1
fi

echo ""
echo "OK: all required TEST keys are present. Operator is usable."
exit 0
