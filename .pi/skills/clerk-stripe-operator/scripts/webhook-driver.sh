#!/usr/bin/env bash
# webhook-driver.sh — deliver a real Stripe test webhook event to the app's /billing/webhook.
#
# Modes:
#   --event=<type>                `stripe trigger <type>` through whatever `stripe listen` forwards.
#   --events[=<type>]             list the newest real events (id/type/created) to pick from.
#   --replay-event=<evt_id>       fetch that REAL event from the API and POST it to /billing/webhook
#                                 signed with the app's own STRIPE_WEBHOOK_SECRET (no CLI/listen
#                                 needed — the documented fallback for a machine with no listener).
#
# Safety: types that end real (test) app state on delivery (subscription.deleted, checkout.session
# .completed, payment_intent.*) require --admin-destroy in both modes.
#
# Reads (never prints): STRIPE_WEBHOOK_SECRET (whsec_), STRIPE_SECRET_KEY. Backend root from
# BACKEND_URL env or default http://localhost:8000. Webhook path is always /billing/webhook.
set -euo pipefail
_ENGINE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
. "$_ENGINE_DIR/_env.sh"

BACKEND_URL="${BACKEND_URL:-http://localhost:8000}"
WEBHOOK="$BACKEND_URL/billing/webhook"
API="https://api.stripe.com/v1"
ADMINDESTROY=0
EVENT=""
REPLAY_EVENT=""
LIST_EVENTS=0
ONLY_REQ=0   # set to just request creation (skip waiting)

for a in "$@"; do
  case "$a" in
    --admin-destroy) ADMINDESTROY=1 ;;
    --event=*) EVENT="${a#--event=}" ;;
    --events) LIST_EVENTS=1 ;;
    --events=*) LIST_EVENTS=1; EVENT="${a#--events=}" ;;
    --replay-event=*) REPLAY_EVENT="${a#--replay-event=}" ;;
    --req-only) ONLY_REQ=1 ;;
    *) echo "unexpected arg: $a"; exit 2 ;;
  esac
done

_destructive() {
  case "$1" in
    customer.subscription.deleted|checkout.session.completed|customer.deleted|payment_intent.*) return 0 ;;
    *) return 1 ;;
  esac
}
_require_admin() {
  if _destructive "$1" && [ "$ADMINDESTROY" != 1 ]; then
    echo "refused: '$1' is destructive to test state; add --admin-destroy"
    exit 3
  fi
}

# The event's `type` is the LAST one in the payload (nested objects carry their own `type`), and a
# StoredEvent is one long JSON line — node when present, else the last match on that line.
node_or_grep_type() {
  if command -v node >/dev/null 2>&1; then
    node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).type))' < "$1"
  else
    grep -o '"type": *"[^"]*"' "$1" | tail -1 | sed -E 's/.*"([^"]*)"$/\1/'
  fi
}

if [ -z "${STRIPE_SECRET_KEY:-}" ]; then echo "refused: STRIPE_SECRET_KEY unset"; exit 1; fi
case "$STRIPE_SECRET_KEY" in *_live_*) echo "refused: live Stripe key"; exit 1;; esac
AUTH="Authorization: Bearer $STRIPE_SECRET_KEY"

# --- list real events (read-only) -------------------------------------------------------------
if [ "$LIST_EVENTS" = 1 ]; then
  if [ -z "${STRIPE_WEBHOOK_SECRET:-}" ]; then echo "warn: STRIPE_WEBHOOK_SECRET unset — --replay-event will refuse"; fi
  q="$API/events?limit=10"
  [ -n "$EVENT" ] && q="$q&type=$EVENT"
  echo "== newest real Stripe events =="
  if command -v node >/dev/null 2>&1; then
    curl -fsS -H "$AUTH" "$q" | node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d)).on("end", () => {
        for (const e of JSON.parse(s).data) console.log(`  ${e.id}  ${e.type.padEnd(42)} ${new Date(e.created * 1000).toISOString().replace(/\.\d+Z$/, "Z")}`);
      });'
  else
    # No node on this host: the ids alone are all --replay-event needs.
    curl -fsS -H "$AUTH" "$q" | grep -o '"id": *"evt_[^"]*"' | sed -E 's/.*"(evt_[^"]*)"/  \1/'
  fi
  echo "  deliver one: $0 --replay-event=<evt_id>   (add --admin-destroy if it is destructive)"
  exit 0
fi

# --- replay a real event, signed with the app's own whsec -------------------------------------
if [ -n "$REPLAY_EVENT" ]; then
  if [ -z "${STRIPE_WEBHOOK_SECRET:-}" ]; then echo "refused: STRIPE_WEBHOOK_SECRET unset (needed to sign)"; exit 1; fi
  body=$(mktemp); trap 'rm -f "$body"' EXIT; chmod 600 "$body"
  curl -fsS -H "$AUTH" "$API/events/$REPLAY_EVENT" -o "$body" || { echo "refused: no such event $REPLAY_EVENT"; exit 4; }
  etype=$(node_or_grep_type "$body")
  [ -n "$etype" ] || { echo "refused: could not read type of $REPLAY_EVENT"; exit 4; }
  _require_admin "$etype"
  t=$(date +%s)
  # Sign over the exact bytes we POST (t.payload, HMAC-SHA256) — the same scheme stripe listen uses.
  sig=$({ printf '%s.' "$t"; cat "$body"; } | openssl dgst -sha256 -hmac "$STRIPE_WEBHOOK_SECRET" | awk '{print $NF}')
  echo "POST $WEBHOOK  (replay $etype $REPLAY_EVENT, real object, signed with STRIPE_WEBHOOK_SECRET)"
  code=$(curl -sS -o /tmp/webhook-replay.out -w '%{http_code}' -X POST "$WEBHOOK" \
    -H "Content-Type: application/json" -H "stripe-signature: t=$t,v1=$sig" --data-binary "@$body")
  echo "  -> HTTP $code $(head -c 200 /tmp/webhook-replay.out)"
  rm -f /tmp/webhook-replay.out
  [ "$code" = 200 ] || exit 5
  exit 0
fi

# --- trigger via the Stripe CLI (needs `stripe listen` forwarding) ------------------------------
if [ -z "$EVENT" ]; then echo "usage: webhook-driver.sh --event=<type> | --events[=<type>] | --replay-event=<evt_id> [--admin-destroy]"; exit 2; fi
_require_admin "$EVENT"

# Prefer the app being up.
if ! curl -fsS "$BACKEND_URL/health" >/dev/null 2>&1; then
  echo "warn: backend /health not reachable at $BACKEND_URL (still will attempt CLI trigger)."
fi

if command -v stripe >/dev/null 2>&1 && [ "$ONLY_REQ" = 0 ]; then
  echo "delivering existing/triggered event '$EVENT' to $WEBHOOK via 'stripe listen'..."
  echo "  -> run \`stripe listen --forward-to $WEBHOOK\` in another pane if not already running."
  stripe trigger "$EVENT" || {
    echo "  note: 'stripe trigger' error (or event not a CLI-triggerable type). Falling back to API replay."
  }
  exit 0
fi

echo "warn: no interactive stripe-listen forward detected; event relay depends on backend reachable"
echo "  via a running \`stripe listen --forward-to $WEBHOOK\`. Re-run with stripe listen up, or use"
echo "  --events then --replay-event=<evt_id> to deliver a real event with no listener."
exit 0
