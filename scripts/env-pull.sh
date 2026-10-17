#!/bin/sh
# The credentials block at the end of each target file is owned here. Two owners for one key means
# one value wins with no signal, so a stray line for a managed key is replaced too.
# AI HERE: the two files are written one after the other, so a failure between them updates .env and
# leaves backend/.env alone. Re-running is safe. Upgrade path: stage both, then move them together.
# AI HERE: the block is appended, so a managed key does not sit in its own section. Upgrade path:
# rewrite the line where `cp *.env.example` puts it.
set -eu
umask 077

cd "$(dirname "$0")/.."
DEV_PATH=${ENV_PULL_DEV_PATH:-/consumers/maxterview}
ROOT_KEYS="NEON_API_KEY GRAFANA_SERVICE_ACCOUNT_TOKEN"
BACKEND_KEYS="CLERK_SECRET_KEY PAYMONGO_SECRET_KEY BYOK_ENCRYPTION_KEY LLM_API_KEY CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN"
BEGIN="# >>> credentials: make env-pull (Infisical dev $DEV_PATH)"
END="# <<< credentials"

vault=$(mktemp)
block=""
strays=""
target_tmp=""
trap 'rm -f "$vault" "$block" "$strays" "$target_tmp" 2>/dev/null || true' EXIT
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

    opens=$(grep -Fxc "$BEGIN" "$target" || true)
    closes=$(grep -Fxc "$END" "$target" || true)
    [ "$opens" = "$closes" ] || {
        echo "env-pull: $target has $opens opening and $closes closing markers. Repair the block by hand first." >&2
        exit 1
    }

    block=$(mktemp)
    strays=$(mktemp)
    target_tmp="$target.tmp"
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
    ' "$target" >"$target_tmp"

    if [ -s "$strays" ]; then
        echo "env-pull: $target had $(tr '\n' ' ' <"$strays")outside the block; removed, the block wins" >&2
    fi

    cat "$block" >>"$target_tmp"
    chmod --reference="$target" "$target_tmp" 2>/dev/null || chmod 600 "$target_tmp"
    mv "$target_tmp" "$target"
    rm -f "$block" "$strays"
    block=""
    strays=""

    [ "$(grep -Fxc "$BEGIN" "$target")" = 1 ] || {
        echo "env-pull: $target does not hold exactly one credentials block after the pull" >&2
        exit 1
    }
    echo "env-pull: $target <- $(printf '%s\n' $keys | wc -l) keys"
}

fill .env "$ROOT_KEYS"
fill backend/.env "$BACKEND_KEYS"
