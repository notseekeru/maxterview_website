#!/usr/bin/env bash
set -euo pipefail

GITOPS=${GITOPS:-$HOME/gitops}
FILE=apps-of-apps/maxterview.yaml
TOGGLE='^chore\(gitops\): (open|close|point) the maxterview'
LINE='^([[:space:]]*path: apps/maxterview/overlays/)(prod|perf|edge)([[:space:]]*)$'

case ${1:-} in
on) want=perf msg='chore(gitops): open the maxterview perf-val-change' ;;
off) want=prod msg='chore(gitops): close the maxterview perf-val-change' ;;
edge) want=edge msg='chore(gitops): point the maxterview app at overlays/edge' ;;
status) want="" msg="" ;;
*)
    echo "usage: $(basename "$0") on|off|edge|status" >&2
    exit 2
    ;;
esac

cd "$GITOPS"
[ -z "$(git status --porcelain)" ] || {
    echo "gitops worktree is dirty; commit or stash it first" >&2
    exit 1
}

overlay() {
    text=$(cat)
    n=$(grep -cE "$LINE" <<<"$text" || true)
    [ "$n" = 1 ] || {
        echo "expected one overlay path in $FILE, found $n" >&2
        exit 1
    }
    sed -nE "s#$LINE#\2#p" <<<"$text"
}

git fetch --quiet origin main

if [ -z "$want" ]; then
    have=$(git show origin/main:"$FILE" | overlay)
    [ "$have" = prod ] && echo "window closed (overlays/$have)" || echo "window open (overlays/$have)"
    exit 0
fi

for _ in 1 2 3; do
    base=$(git rev-parse origin/main)
    git checkout --quiet --detach "$base"
    have=$(overlay <"$FILE")

    if [ "$have" = "$want" ]; then
        git checkout --quiet -B main "$base"
        echo "window already $1 (overlays/$have); nothing to commit"
        exit 0
    fi

    sed -i -E "s#$LINE#\1$want#" "$FILE"
    git add -- "$FILE"

    if grep -qE "$TOGGLE" <<<"$(git log -1 --format=%s)"; then
        if git diff --cached --quiet HEAD^; then
            git reset --quiet --hard HEAD^
        else
            git commit --quiet --amend -m "$msg"
        fi
    else
        git commit --quiet -m "$msg"
    fi

    if git push --quiet --force-with-lease="main:$base" origin HEAD:main; then
        git checkout --quiet -B main origin/main
        echo "perf window $1: overlays/$want pushed at $(git rev-parse --short origin/main)"
        exit 0
    fi

    echo "push raced origin/main; retrying" >&2
    git fetch --quiet origin main
    sleep 2
done

git checkout --quiet -B main origin/main
echo "could not push origin/main after 3 attempts" >&2
exit 1
