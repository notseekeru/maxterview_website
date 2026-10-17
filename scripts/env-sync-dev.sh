#!/usr/bin/env bash
# Pulls the credential block into .env and backend/.env from Infisical's dev env, then verifies each
# file's key set against its template. Two owners for one key means one value wins with no signal, so
# a stray line for a managed key is replaced too.
# AI HERE: the two files are written one after the other, so a failure between them updates .env and
# leaves backend/.env alone. Re-running is safe. Upgrade path: stage both, then move them together.
# AI HERE: the block is appended, so a managed key does not sit in its own section. Upgrade path:
# rewrite the line where `cp *.env.example` puts it.
set -euo pipefail
umask 077

cd "$(dirname "$0")/.."
DEV_PATH=${ENV_PULL_DEV_PATH:-/consumers/maxterview}
ROOT_KEYS="NEON_API_KEY GRAFANA_SERVICE_ACCOUNT_TOKEN"
BACKEND_KEYS="CLERK_SECRET_KEY PAYMONGO_SECRET_KEY BYOK_ENCRYPTION_KEY LLM_API_KEY CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN"
BEGIN="# >>> credentials: make env-sync-dev (Infisical dev $DEV_PATH)"
END="# <<< credentials"

vault=$(mktemp)
block=""
strays=""
target_tmp=""
trap 'rm -f "$vault" "$block" "$strays" "$target_tmp" 2>/dev/null || true' EXIT

infisical export --silent --env dev --path "$DEV_PATH" --format dotenv >"$vault"

payload() {
    for k in $1; do
        line=$(grep -m1 "^$k=" "$vault" || true)
        value=${line#*=}
        value=${value#\'}
        value=${value%\'}
        [ -n "$value" ] || {
            echo "env-sync-dev: the vault has no usable value for $k, refusing to write a partial block" >&2
            exit 1
        }
    done
}

markers() {
    file=$1
    want=$2
    [ -f "$file" ] || {
        echo "env-sync-dev: $file is missing. Copy its template first." >&2
        exit 1
    }

    opens=$(grep -Fxc "$BEGIN" "$file" || true)
    closes=$(grep -Fxc "$END" "$file" || true)
    if [ "$want" = 1 ]; then
        [ "$opens" = 1 ] && [ "$closes" = 1 ] || {
            echo "env-sync-dev: $file does not hold exactly one credentials block after the write" >&2
            exit 1
        }
    else
        [ "$opens" = "$closes" ] || {
            echo "env-sync-dev: $file has $opens opening and $closes closing markers. Repair the block by hand first." >&2
            exit 1
        }
    fi
}

fill() {
    target=$1
    keys=$2
    payload "$keys"
    markers "$target" 0

    block=$(mktemp)
    strays=$(mktemp)
    target_tmp="$target.tmp"
    {
        printf '%s\n' "$BEGIN"
        for k in $keys; do
            grep -m1 "^$k=" "$vault"
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
        echo "env-sync-dev: $target had $(tr '\n' ' ' <"$strays")outside the block; removed, the block wins" >&2
    fi

    cat "$block" >>"$target_tmp"
    chmod --reference="$target" "$target_tmp" 2>/dev/null || chmod 600 "$target_tmp"
    mv "$target_tmp" "$target"
    rm -f "$block" "$strays"
    block=""
    strays=""

    markers "$target" 1
    echo "env-sync-dev: $target <- $(printf '%s\n' $keys | wc -l) keys"
}

sync() {
    template=$1
    target=$2
    if [ ! -f "$template" ]; then
        echo "env-sync-dev: $template is missing, cannot check $target against it" >&2
        return 1
    fi

    expected=$(sed -n 's/^#\{0,1\} *\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$template" | sort -u)
    actual=$(sed -n 's/^\([A-Z][A-Z0-9_]*\)=.*/\1/p' "$target" | sort -u)
    undocumented=$(comm -13 <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") || true)
    unset_keys=$(comm -23 <(printf '%s\n' "$expected") <(printf '%s\n' "$actual") || true)

    if [ -n "$undocumented" ]; then
        echo "env-sync-dev: $target sets keys $template does not document:" >&2
        printf '  %s\n' $undocumented >&2
        return 1
    fi
    if [ -n "$unset_keys" ]; then
        n=$(printf '%s\n' $unset_keys | wc -l)
        [ "$n" = 1 ] && echo "env-sync-dev: $target: 1 documented key at its code default" \
            || echo "env-sync-dev: $target: $n documented keys at their code defaults"
    fi
}

fill .env "$ROOT_KEYS"
fill backend/.env "$BACKEND_KEYS"

sync .env.example .env
sync backend/.env.example backend/.env
sync frontend/.env.example frontend/.env
