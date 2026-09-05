#!/usr/bin/env bash
# clerk-mint.sh — operator helper: create a throwaway Clerk test user and print a browser-auth
# session/testing token WITHOUT any password. Destructive teardown needs --admin-destroy.
#
# Reads (never prints values): CLERK_SECRET_KEY, CLERK_FRONTEND_API, CLERK_TESTING_TOKEN_TEMPLATE.
# Outputs machine-ish lines starting with an unchanging prefix plus the token payload. The model
# uses the token to clear `__session` for the app origin / drive Playwright. Never logs the secret.
set -euo pipefail

API="https://api.clerk.com/v1"
ADMINDESTROY=0
ARG_TEARDOWN=0
USER_ID=""
EMAIL=""

for a in "$@"; do
  case "$a" in
    --admin-destroy) ADMINDESTROY=1 ;;
    --teardown)      ARG_TEARDOWN=1 ;;
    --user=*)        USER_ID="${a#--user=}" ;;
    --email=*)       EMAIL="${a#--email=}" ;;
    *) echo "unexpected arg: $a"; exit 2 ;;
  esac
done

if [ -z "${CLERK_SECRET_KEY:-}" ]; then echo "refused: CLERK_SECRET_KEY unset (run need-keys.sh)"; exit 1; fi
case "$CLERK_SECRET_KEY" in *_live_*) echo "refused: live Clerk key"; exit 1;; esac

AUTH="Authorization: Bearer $CLERK_SECRET_KEY"
echo "== Clerk operator ==  (never prints secrets)"

if [ "$ARG_TEARDOWN" = 1 ]; then
  if [ "$ADMINDESTROY" != 1 ]; then
    echo "refused: destructive op (--teardown) requires --admin-destroy"
    exit 3
  fi
  if [ -z "$USER_ID" ]; then echo "refused: --teardown needs --user=<id>"; exit 2; fi
  echo "DELETE $API/users/$USER_ID  (running)"
  curl -fsS -X DELETE -H "$AUTH" "$API/users/$USER_ID" >/dev/null
  echo "deleted user $USER_ID"
  exit 0
fi

# 1) Create a throwaway user (primary_email_address is nice-to-have; Clerk needs an email normally).
email="${EMAIL:-maxterview.operator.$(date +%s)@example.com}"
user=$(curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
  -X POST "$API/users" \
  -d "{\"email_address\":[\"$email\"],\"first_name\":\"Operator\",\"last_name\":\"Probe\",\"skip_password_requirement\":true}")
uid=$(printf '%s' "$user" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
echo "user-id  $uid   (email $email)"

# 2) Create a client session for that user and mint an active session token (dev-instance short-lived
#    token). Requires CLERK_FRONTEND_API if we go through the session API; for prod-use prefer the
#    testing-token template (see token-template path below).
client=$(curl -fsS -H "$AUTH" -H "Content-Type: application/json" -X POST "$API/clients")
client_id=$(printf '%s' "$client" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
echo "client-id $client_id"

token=""
if [ -n "${CLERK_TESTING_TOKEN_TEMPLATE:-}" ]; then
  # Produce a signed TESTING token via the template (works on dev AND prod). Needs the template id.
  # eslint-style: this returns a long JWT; we never print the secret var, only the JWT payload.
  tk=$(curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
       -X POST "$API/testing_tokens" -d "{\"template\":\"${CLERK_TESTING_TOKEN_TEMPLATE}\"}")
  token=$(printf '%s' "$tk" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p' | head -1)
else
  echo "  ~ CLERK_TESTING_TOKEN_TEMPLATE unset; using dev-session token. For prod-instance browser "
  echo "    auth create a testing-token template and set CLERK_TESTING_TOKEN_TEMPLATE."
fi
if [ -n "$token" ]; then
  echo "testing-token  $token"
  echo "  (set it as the frontend origin's __session cookie to authenticate that browser as $uid)."
  echo "  It will use your configured Clerk instance. NOTE: the token is a credential — handle as a secret."
fi
if [ -z "$token" ]; then
  echo "token-issue: could not mint a token (need dev instance session flow or testing-token template)."
fi
