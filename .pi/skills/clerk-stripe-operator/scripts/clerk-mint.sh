#!/usr/bin/env bash
# clerk-mint.sh — operator helper: create a throwaway Clerk test user and print a browser-auth
# session/testing token WITHOUT any password. Destructive teardown needs --admin-destroy.
#
# Reads (never prints values): CLERK_SECRET_KEY, CLERK_FRONTEND_API, CLERK_TESTING_TOKEN_TEMPLATE.
# Outputs machine-ish lines starting with an unchanging prefix plus the token payload. The model
# uses the token to clear `__session` for the app origin / drive Playwright. Never logs the secret.
set -euo pipefail
_ENGINE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$_ENGINE_DIR/_env.sh"

API="https://api.clerk.com/v1"
ADMINDESTROY=0
ARG_TEARDOWN=0
USER_ID=""
EMAIL=""
USERNAME=""

for a in "$@"; do
  case "$a" in
    --admin-destroy) ADMINDESTROY=1 ;;
    --teardown)      ARG_TEARDOWN=1 ;;
    --user=*)        USER_ID="${a#--user=}" ;;
    --email=*)       EMAIL="${a#--email=}" ;;
    --username=*)    USERNAME="${a#--username=}" ;;
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

# 1) Create a throwaway user. Some dev instances require a `username` in their user
#    requirements (else POST users -> 422 form_data_missing:["username"]). Auto-derive one
#    when not given, and ask Clerk not to email the throwaway address.
email="${EMAIL:-maxterview.operator.$(date +%s)@example.com}"
username="${USERNAME:-operator_$(date +%s)}"
create_user() {
  curl -sS -H "$AUTH" -H "Content-Type: application/json" \
    -X POST "$API/users" \
    -d "{\"email_address\":[\"$email\"],\"username\":\"$username\",\"first_name\":\"Operator\",\"last_name\":\"Probe\",\"skip_password_requirement\":true,\"notify_primary_email_address\":false}"
}
RESP="$(create_user)"
# A 422 body is still valid JSON that curl won't flag, so surface errors explicitly and
# capture the FIRST object key "id" (the real user_… id), NOT nested identification idn_… ids.
if printf '%s' "$RESP" | grep -q '"errors"'; then
  echo "create-user FAILED (instance may require extra fields). Body:"
  echo "$RESP" | head -c 600
  echo
  exit 4
fi
uid=$(printf '%s' "$RESP" | sed -n 's/.*"id": *"\(user_[^"]*\)".*/\1/p' | head -1)
username_echo="${uid:+$username}"
echo "user-id  $uid   (email $email, username $username_echo)"

# 2) Mint a signed auth token. The legacy Backend `/clients` endpoint is deprecated (405),
#    so use the current supported testing-token API (dev instance doesn't need a template).
#    For a prod-instance browser-authenticating token, set CLERK_TESTING_TOKEN_TEMPLATE.
token=""
if [ -n "${CLERK_TESTING_TOKEN_TEMPLATE:-}" ]; then
  tk=$(curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
       -X POST "$API/testing_tokens" -d "{\"template\":\"${CLERK_TESTING_TOKEN_TEMPLATE}\"}")
else
  tk=$(curl -fsS -H "$AUTH" -H "Content-Type: application/json" -X POST "$API/testing_tokens" -d '{}')
fi
token=$(printf '%s' "$tk" | sed -n 's/.*"token": *"\([^"]*\)".*/\1/p' | head -1)
[ -z "$token" ] && echo "token-issue: could not mint via /testing_tokens (see body above)."; printf '%s' "$tk" | grep -q '"errors"' && { echo "token API error body:"; echo "$tk" | head -c 400; }
if [ -n "$token" ]; then
  echo "testing-token  $token"
  echo "  (set it as the frontend origin's __session cookie / or drive @clerk/testing with it to"
  echo "   authenticate that browser as $uid. It will use your configured Clerk instance. NOTE: the"
  echo "   token is a credential - handle as a secret. It is NOT a JWT session cookie by itself: to"
  echo "   sign into the SPA headlessly, use clerk.signIn( emailAddress ) from @clerk/testing/playwright"
  echo "   (see SKILL.md 'Fully-headless Clerk auth')."
fi
