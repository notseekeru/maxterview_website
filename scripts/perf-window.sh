#!/usr/bin/env bash
set -euo pipefail

GITOPS=${GITOPS:-$HOME/gitops}
FILE=apps-of-apps/maxterview.yaml

case ${1:-} in
on) want=perf action=open ;;
off) want=prod action=close ;;
status) want="" action="" ;;
*)
    echo "usage: $(basename "$0") on|off|status" >&2
    exit 2
    ;;
esac

cd "$GITOPS"
mapfile -t found < <(grep -n 'path: apps/maxterview/overlays/' "$FILE" || true)
[ "${#found[@]}" -eq 1 ] || {
    echo "expected one overlay path in $FILE, found ${#found[@]}" >&2
    exit 1
}
have=$(sed -n 's|.*/overlays/||p' <<<"${found[0]}")
have=${have//[[:space:]]/}
case $have in
prod | perf) ;;
*)
    echo "cannot read the overlay from: ${found[0]}" >&2
    exit 1
    ;;
esac

if [ "$1" = status ]; then
    state=$([ "$have" = perf ] && echo open || echo closed)
    echo "perf window $state (overlays/$have)"
    exit 0
fi

if [ "$want" = "$have" ]; then
    echo "perf window already $1; nothing to commit"
    exit 0
fi

git -c pull.rebase=false pull --ff-only --quiet
sed -i "s|apps/maxterview/overlays/$have|apps/maxterview/overlays/$want|" "$FILE"
git commit --quiet -m "chore(gitops): $action the maxterview perf-val-change" -- "$FILE"
git push --quiet
echo "perf window $1: overlays/$want pushed at $(git rev-parse --short HEAD)"
