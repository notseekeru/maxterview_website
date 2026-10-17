#!/bin/sh
# Fill the credential lines in `.env` (the two MCP tokens) and `backend/.env` (the six the backend
# container needs) from Infisical's dev env. The only dev command that needs the network.
#
# Each file gets one marked block, replaced wholesale. A hand edit on one of those lines, or a stray
# copy of the same key elsewhere in the file, is removed and reported: two owners for one key is how
# a value silently loses to the other one.
set -eu
umask 077

cd "$(dirname "$0")/.."
DEV_PATH=${ENV_PULL_DEV_PATH:-/consumers/maxterview}
ROOT_KEYS="NEON_API_KEY GRAFANA_SERVICE_ACCOUNT_TOKEN"
BACKEND_KEYS="CLERK_SECRET_KEY PAYMONGO_SECRET_KEY BYOK_ENCRYPTION_KEY LLM_API_KEY CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN"
BEGIN="# >>> credentials: make env-pull (Infisical dev $DEV_PATH)"
END="# <<< credentials"

vault=$(mktemp)
trap 'rm -f "$vault" "$target.tmp" "$block" "$strays"' EXIT
infisical export --silent --env dev --path "$DEV_PATH" --format dotenv >"$vault"

empty=$(sed "s/^\([A-Z0-9_]*\)='\(.*\)'$/\1=\2/" "$vault" | awk -F= '$2==""{print $1}')
[ -z "$empty" ] || {
    echo "env-pull: refusing an empty value for: $empty" >&2
    exit 1
}

fill() {
    target=$1
    keys=$2
    [ -f "$target" ] || {
        echo "env-pull: $target is missing. Copy its template first (see README quickstart)." >&2
        exit 1
    }

    block=$(mktemp)
    strays=$(mktemp)
    {
        printf '%s\n' "$BEGIN"
        for k in $keys; do
            line=$(grep -m1 "^$k=" "$vault" || true)
            [ -n "$line" ] || {
                echo "env-pull: the vault has no $k, which $target owns. Refusing to write a partial block." >&2
                exit 1
            }
            printf '%s\n' "$line"
        done
        printf '%s\n' "$END"
    } >"$block"

    awk -v begin="$BEGIN" -v end="$END" -v keys="$keys" -v strays="$strays" '
        BEGIN { n = split(keys, a, " "); for (i = 1; i <= n; i++) managed[a[i]] = 1 }
        $0 == begin { inblock = 1; next }
        $0 == end   { inblock = 0; next }
        inblock     { next }
        /^[A-Za-z_][A-Za-z0-9_]*=/ {
            if (substr($0, 1, index($0, "=") - 1) in managed) { print substr($0, 1, index($0, "=") - 1) >> strays; next }
        }
        { print }
    ' "$target" >"$target.tmp"

    if [ -s "$strays" ]; then
        echo "env-pull: $target had $(tr '\n' ' ' <"$strays")outside the block; removed, the block wins" >&2
    fi

    cat "$block" >>"$target.tmp"
    chmod --reference="$target" "$target.tmp" 2>/dev/null || chmod 600 "$target.tmp"
    mv "$target.tmp" "$target"
    rm -f "$block" "$strays"
    echo "env-pull: $target <- $(printf '%s\n' $keys | wc -l) keys"
}

fill .env "$ROOT_KEYS"
fill backend/.env "$BACKEND_KEYS"
