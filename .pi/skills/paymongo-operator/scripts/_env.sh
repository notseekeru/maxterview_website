#!/usr/bin/env bash
# _env.sh — sourced-by operator scripts; loads backend/.env, root .env and .env.secrets into the
# shell so keys the user pastes there are honored by scripts that run on the HOST (not just in the
# compose container, where `env_file` already injects them).
#
# Git-ignored secrets are read as *names* here. This loader NEVER prints a value. It only exports
# whatever is already in the file unchanged, and only when the var is not already set (process env
# wins, matching compose semantics where backend/.env overrides root on collision).
#
# Usage at top of each script (after `set -euo pipefail`):
#   SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
#   # shellcheck source=/dev/null
#   . "$SCRIPT_DIR/_env.sh"

# Determine the repo root (parent of .pi/skills/paymongo-operator/scripts/).
_ENGINE_CORE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../../.." && pwd)"
_ENGINE_ROOT_ENV="$_ENGINE_CORE_DIR/.env"
_ENGINE_BACKEND_ENV="$_ENGINE_CORE_DIR/backend/.env"
_ENGINE_SECRETS_ENV="$_ENGINE_CORE_DIR/.env.secrets"

# Load a dotenv file into env, without printing values and only if var not already set.
_engine_load_env() {
  local file="$1"
  [ -r "$file" ] || return 0
  # Read only KEY= lines; skip comments/blanks. Ignore lines that aren't simple KEY=VALUE (no
  # spaces in key). Values may contain '=' (we split on first '=' with IFS read).
  while IFS='=' read -r _k _rest; do
    case "$_k" in
      ''|\#*) continue ;;
    esac
    # Require a simple alnum/underscore key (defensive; avoids source-injection from a malformed .env).
    case "$_k" in
      *[!A-Za-z0-9_]*) continue ;;
    esac
    [ -n "${!_k:-}" ] && continue              # already set (non-empty) in env — respect it
    # Trim one level of surrounding single/double quotes (how a typical dotenv/compose .env parses).
    case "$_rest" in
      \"*\") _rest="${_rest%\"}"; _rest="${_rest#\"}" ;;
      \'*\')  _rest="${_rest%\'}";  _rest="${_rest#\'}"  ;;
    esac
    # shellcheck disable=SC2163
    export "$_k=$_rest"
  done < "$file"
  return 0
}

_engine_load_env "$_ENGINE_ROOT_ENV"
_engine_load_env "$_ENGINE_BACKEND_ENV"
_engine_load_env "$_ENGINE_SECRETS_ENV"
unset _engine_load_env _ENGINE_CORE_DIR _ENGINE_ROOT_ENV _ENGINE_BACKEND_ENV _ENGINE_SECRETS_ENV _k _rest
