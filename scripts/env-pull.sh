#!/bin/sh
# Refresh .env.secrets (the credentials the backend container needs) from Infisical's dev env.
# Every other dev path is offline: this is the only thing that talks to Infisical, and it either
# writes a complete file or leaves the existing one untouched.
#
# An empty value in the vault is a real state (prod-side scar: infra/k3s/variables.tf validation
# blocks exist because a set-but-empty TF_VAR satisfies "required"), so an empty value here is
# refused rather than allowed to blank out a working local one.
set -eu

cd "$(dirname "$0")/.."
DEV_PATH=${ENV_PULL_DEV_PATH:-/consumers/maxterview}
tmp=$(mktemp ./.env.secrets.XXXXXX)
trap 'rm -f "$tmp"' EXIT

infisical export --silent --env dev --path "$DEV_PATH" --format dotenv >"$tmp"

names=$(cut -d= -f1 "$tmp" | grep -E '^[A-Z0-9_]+$' || true)
[ -n "$names" ] || {
    echo "env-pull: no keys in dev$DEV_PATH, .env.secrets left unchanged" >&2
    exit 1
}

empty=$(sed "s/^\([A-Z0-9_]*\)='\(.*\)'$/\1=\2/" "$tmp" | awk -F= '$2==""{print $1}')
[ -z "$empty" ] || {
    echo "env-pull: refusing an empty value for: $empty. .env.secrets left unchanged" >&2
    exit 1
}

mv "$tmp" .env.secrets
echo "env-pull: $(printf '%s\n' "$names" | wc -l) keys -> .env.secrets"
