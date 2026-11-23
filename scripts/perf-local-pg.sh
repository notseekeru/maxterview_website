#!/usr/bin/env bash
set -euo pipefail

GITOPS=${GITOPS:-$HOME/gitops}
HERE=$(cd -- "$(dirname -- "$0")" && pwd)
TARGET=${TARGET:?set TARGET=<user>@<node-host> in .env}
KEY=${KEY:?set KEY=<path to the node ssh key> in .env}
FILE=apps-of-apps/maxterview.yaml
ENV=apps/maxterview/overlays/perf/env.yaml
LINE='^([[:space:]]*path: apps/maxterview/overlays/)(prod|perf)([[:space:]]*)$'
DSN='postgresql://maxterview:maxterview@maxterview-pg:5432/maxterview'

cluster() { ssh -i "$KEY" "$TARGET" "$@"; }

pg_manifest() {
    cat <<'EOF'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: maxterview-pg
  namespace: maxterview
  labels: {app: maxterview-pg}
spec:
  replicas: 1
  selector:
    matchLabels: {app: maxterview-pg}
  template:
    metadata:
      labels: {app: maxterview-pg}
    spec:
      containers:
        - name: postgres
          image: postgres:18-alpine
          env:
            - {name: POSTGRES_USER, value: maxterview}
            - {name: POSTGRES_PASSWORD, value: maxterview}
            - {name: POSTGRES_DB, value: maxterview}
          ports:
            - {containerPort: 5432}
          volumeMounts:
            - {name: data, mountPath: /var/lib/postgresql}
          resources:
            requests: {cpu: 100m, memory: 128Mi}
            limits: {memory: 1Gi}
          readinessProbe:
            exec: {command: ["pg_isready", "-U", "maxterview", "-d", "maxterview"]}
            initialDelaySeconds: 3
            periodSeconds: 5
      volumes:
        - name: data
          # AI HERE: emptyDir gives every window a fresh schema; a PVC would persist and could skip the migration.
          emptyDir: {}
---
apiVersion: v1
kind: Service
metadata:
  name: maxterview-pg
  namespace: maxterview
spec:
  selector: {app: maxterview-pg}
  ports:
    - {port: 5432, targetPort: 5432}
EOF
}

migrate_manifest() {
    cat <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: maxterview-pg-migrate
  namespace: maxterview
spec:
  backoffLimit: 1
  template:
    spec:
      restartPolicy: Never
      imagePullSecrets:
        - {name: ghcr-login}
      containers:
        - name: migrate
          image: $1
          command: ["/bin/sh", "-c"]
          args:
            - |
              set -eu
              if [ -x /app/.venv/bin/yoyo ]; then
                exec /app/.venv/bin/yoyo apply --no-config-file --batch --database "$DSN" /app/migrations
              else
                exec node /app/dist/scripts/migrate.js apply --database "$DSN"
              fi
EOF
}

overlay() { sed -nE "s#$LINE#\2#p"; }

env_has_dsn() {
    cd "$GITOPS"
    git show origin/main:"$ENV" | grep -q 'name: DATABASE_URL'
}

write_env_dsn() {
    cd "$GITOPS"
    git fetch --quiet origin main
    git checkout --quiet --detach origin/main
    awk -v dsn="$DSN" '
        { print }
        /^            - name: DEV_USER_SUB$/ { getline v; print v
            print "            - name: DATABASE_URL"
            print "              value: " dsn }
    ' "$ENV" >"$ENV.new"
    mv "$ENV.new" "$ENV"
    git add -- "$ENV"
    git commit --quiet -m "chore(gitops): point the perf window at the local postgres"
    git push --quiet --force-with-lease="main:$(git rev-parse origin/main)" origin HEAD:main
    git checkout --quiet -B main origin/main
}

drop_env_dsn() {
    cd "$GITOPS"
    git fetch --quiet origin main
    git checkout --quiet --detach origin/main
    awk '/^            - name: DATABASE_URL$/{skip=1; next} skip && /^              value:/{skip=0; next} {print}' "$ENV" >"$ENV.new"
    mv "$ENV.new" "$ENV"
    if git diff --quiet -- "$ENV"; then
        git checkout --quiet -B main origin/main
        return 0
    fi
    git add -- "$ENV"
    git commit --quiet -m "chore(gitops): drop the local postgres from the perf window"
    git push --quiet --force-with-lease="main:$(git rev-parse origin/main)" origin HEAD:main
    git checkout --quiet -B main origin/main
}

pg_ready() {
    cluster 'k3s kubectl -n maxterview get deploy maxterview-pg -o jsonpath="{.status.readyReplicas}"' 2>/dev/null
}

case ${1:-} in
on)
    pg_manifest | cluster 'cat >/tmp/pg.yaml && k3s kubectl apply -f /tmp/pg.yaml >/dev/null'
    for _ in $(seq 1 30); do
        [ "$(pg_ready)" = "1" ] && break
        sleep 2
    done
    [ "$(pg_ready)" = "1" ] || {
        echo "postgres did not become ready" >&2
        exit 1
    }
    image=$(cluster 'k3s kubectl -n maxterview get deploy maxterview-backend -o jsonpath="{.spec.template.spec.containers[0].image}"')
    migrate_manifest "$image" | cluster 'cat >/tmp/m.yaml && k3s kubectl delete job maxterview-pg-migrate -n maxterview --ignore-not-found >/dev/null && k3s kubectl apply -f /tmp/m.yaml >/dev/null'
    for _ in $(seq 1 40); do
        ok=$(cluster 'k3s kubectl -n maxterview get job maxterview-pg-migrate -o jsonpath="{.status.succeeded}"' 2>/dev/null || true)
        [ "$ok" = "1" ] && break
        sleep 3
    done
    [ "${ok:-}" = "1" ] || {
        cluster 'k3s kubectl -n maxterview logs job/maxterview-pg-migrate --tail=20' >&2 || true
        echo "migrations did not succeed" >&2
        exit 1
    }
    env_has_dsn || write_env_dsn
    "$HERE/perf-window.sh" on
    ;;
off)
    "$HERE/perf-window.sh" off
    for _ in $(seq 1 30); do
        if ! cluster 'k3s kubectl -n maxterview get deploy maxterview-backend -o jsonpath="{range .spec.template.spec.containers[0].env[*]}{.name}{\"\\n\"}{end}"' 2>/dev/null | grep -qx DATABASE_URL; then
            break
        fi
        sleep 10
    done
    if cluster 'k3s kubectl -n maxterview get deploy maxterview-backend -o jsonpath="{range .spec.template.spec.containers[0].env[*]}{.name}{\"\\n\"}{end}"' 2>/dev/null | grep -qx DATABASE_URL; then
        echo "the backend still points at the local postgres; leaving it up" >&2
        exit 1
    fi
    drop_env_dsn
    cluster 'k3s kubectl -n maxterview delete job maxterview-pg-migrate --ignore-not-found >/dev/null; k3s kubectl -n maxterview delete deploy maxterview-pg --ignore-not-found >/dev/null; k3s kubectl -n maxterview delete svc maxterview-pg --ignore-not-found >/dev/null'
    echo "local postgres removed"
    ;;
status)
    "$HERE/perf-window.sh" status
    echo "postgres ready replicas: $(pg_ready)"
    echo "perf overlay DSN: $(env_has_dsn && echo "local postgres" || echo "absent")"
    cluster 'k3s kubectl -n maxterview get deploy maxterview-backend -o jsonpath="{range .spec.template.spec.containers[0].env[*]}{.name}={.value}{\"\\n\"}{end}"' 2>/dev/null | grep -E '^(DATABASE_URL|DB_POOL_MAX|APP_ENV)=' || true
    ;;
*)
    echo "usage: $(basename "$0") on|off|status" >&2
    exit 2
    ;;
esac
