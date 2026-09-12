#!/usr/bin/env bash
# clerk-mint.sh — operator helper: create a throwaway Clerk test user and print a browser-auth
# session/testing token WITHOUT any password. Destructive teardown needs --admin-destroy.
#
#   (default)              create user + print a @clerk/testing testing token (SPA sign-in)
#   --session-jwt[=path]   mint a session JWT for the user and write it to `path` (default
#                          /tmp/clerk-session.jwt, mode 600) — this is the credential the backend
#                          accepts as `Authorization: Bearer`, unlike the testing token. Never
#                          printed: it goes straight into the file.
#   --user=<id>            reuse an existing user instead of creating one
#   --session=<sess_id>    reuse an existing session
#   --teardown --user=<id> --admin-destroy   delete the user
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
SESSION_ID=""
JWT_OUT=""
JWT_TTL=3600

for a in "$@"; do
  case "$a" in
    --admin-destroy) ADMINDESTROY=1 ;;
    --teardown)      ARG_TEARDOWN=1 ;;
    --user=*)        USER_ID="${a#--user=}" ;;
    --email=*)       EMAIL="${a#--email=}" ;;
    --username=*)    USERNAME="${a#--username=}" ;;
    --session=*)     SESSION_ID="${a#--session=}" ;;
    --session-jwt)   JWT_OUT="/tmp/clerk-session.jwt" ;;
    --session-jwt=*) JWT_OUT="${a#--session-jwt=}" ;;
    --jwt-ttl=*)     JWT_TTL="${a#--jwt-ttl=}" ;;
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

# 1) Create a throwaway user (or reuse the one named by --user). Some dev instances require a
#    `username` in their user requirements (else POST users -> 422 form_data_missing:["username"]).
#    Auto-derive one when not given, and ask Clerk not to email the throwaway address.
email="${EMAIL:-maxterview.operator.$(date +%s)@example.com}"
username="${USERNAME:-operator_$(date +%s)}"
create_user() {
  curl -sS -H "$AUTH" -H "Content-Type: application/json" \
    -X POST "$API/users" \
    -d "{\"email_address\":[\"$email\"],\"username\":\"$username\",\"first_name\":\"Operator\",\"last_name\":\"Probe\",\"skip_password_requirement\":true,\"notify_primary_email_address\":false}"
}
if [ -n "$USER_ID" ]; then
  echo "reusing user $USER_ID"
else
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
  USER_ID="$uid"
  echo "user-id  $uid   (email $email, username $username_echo)"
fi

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
  echo "   authenticate that browser as $USER_ID. It will use your configured Clerk instance. NOTE: the"
  echo "   token is a credential - handle as a secret. It is NOT a JWT session cookie by itself: to"
  echo "   sign into the SPA headlessly, use clerk.signIn( emailAddress ) from @clerk/testing/playwright"
  echo "   (see SKILL.md 'Fully-headless Clerk auth')."
fi

# 3) Session JWT (opt-in): the credential the BACKEND accepts as `Authorization: Bearer`. A
#    testing token is only good for @clerk/testing's FAPI interception — for API-level proof
#    (`GET /usage`, curl against /billing/*) you need a real session token JWT. Written to a file,
#    never printed: it is a bearer credential for that throwaway user.
if [ -n "$JWT_OUT" ]; then
  [ -n "$USER_ID" ] || { echo "refused: --session-jwt needs a resolved user (pass --user=)"; exit 4; }
  if [ -z "$SESSION_ID" ]; then
    sresp=$(curl -fsS -H "$AUTH" -H "Content-Type: application/json" -X POST "$API/sessions" -d "{\"user_id\":\"$USER_ID\"}")
    SESSION_ID=$(printf '%s' "$sresp" | sed -n 's/.*"id": *"\(sess_[^"]*\)".*/\1/p' | head -1)
  fi
  [ -n "$SESSION_ID" ] || { echo "refused: could not create a session for $USER_ID"; exit 4; }
  tresp=$(curl -fsS -H "$AUTH" -H "Content-Type: application/json" \
           -X POST "$API/sessions/$SESSION_ID/tokens" -d "{\"expires_in_seconds\":$JWT_TTL}")
  jwt=$(printf '%s' "$tresp" | sed -n 's/.*"jwt": *"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$jwt" ] || { echo "refused: no jwt in session-token response"; exit 4; }
  (umask 077; printf '%s' "$jwt" > "$JWT_OUT")
  echo "session-jwt  $JWT_OUT (mode $(stat -c %a "$JWT_OUT"), ${#jwt} chars, ttl ${JWT_TTL}s)"
  echo "  user $USER_ID session $SESSION_ID — use: curl -H \"Authorization: Bearer \$(cat $JWT_OUT)\" \${BACKEND_URL:-http://localhost:8000}/usage"
fi
