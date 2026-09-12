#!/usr/bin/env bash
# llm-smoke.sh — reproducible end-to-end LLM smoke test for the maxterview backend.
#
# Hits the *live* backend and exercises the whole interview + LLM path with a real model:
#   create -> start -> chat/stream (SSE, assert done not error) -> assistant persisted
#   -> complete (200) -> feedback persisted non-empty.
#
# Usage:
#   scripts/llm-smoke.sh                 # against http://localhost:8000
#   scripts/llm-smoke.sh http://host:PORT  # override backend base URL
#
# It runs inside the backend container so it uses the same python/http stack that serves
# the API (reproducible regardless of host tooling). Requires the dev stack to be up
# (make up) and a live LLM configured in .env (LLM_BASE_URL) — otherwise STUB_MODE renders
# this pointless, so it fails fast with a hint.
#
# Exit codes: 0 = full flow green; 1 = any assertion failed.
set -euo pipefail

BACKEND_URL="${1:-http://localhost:8000}"
STREAM_TIMEOUT="${LLM_SMOKE_STREAM_TIMEOUT:-600}"
COMPLETE_TIMEOUT="${LLM_SMOKE_COMPLETE_TIMEOUT:-600}"

# The container maps ./backend -> /app; the script lives in the repo's scripts/.
log()  { printf '\n[llm-smoke] %s\n' "$*"; }
die()  { printf '\n[llm-smoke] FAIL: %s\n' "$*" >&2; exit 1; }

# runner: run a python snippet inside the backend container.
run_backend() {
    # shellcheck disable=SC2016
    docker exec -i -e LLM_SMOKE_STREAM_TIMEOUT -e LLM_SMOKE_COMPLETE_TIMEOUT -w /app maxterview_backend_dev uv run python -u - "$BACKEND_URL" <<'PY'
import json
import os
import sys
import urllib.request

BASE = sys.argv[1]


def http(method, path, body=None, timeout=20):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout)


def hcheck(cond, label):
    if not cond:
        raise SystemExit(f"ASSERT FAILED: {label}")


# Live model guard: if the backend is in STUB mode this test is meaningless.
try:
    health = json.loads(http("GET", "/api/health", timeout=10).read())
    hcheck(health.get("status") == "ok", "/api/health ok")
except Exception as e:
    raise SystemExit(f"backend unreachable at {BASE}: {e!r}")

# 1. create
iid = json.loads(http("POST", "/api/interviews", {"role": "LLM Smoke", "topic": "e2e"}).read())["id"]
print("created interview:", iid)
hcheck(bool(iid), "interview id present")

# 2. start
http("POST", f"/api/interviews/{iid}/start")
print("started")
try:
    # 3. chat/stream — read SSE via a chunked loop (a single full-body read() can stall on
    #    slow local TTFT reasoning gaps). Enforce our own time budget.
    body = json.dumps({"interview_id": iid, "content": "I write code and ship features."}).encode()
    budget = int(os.environ.get("LLM_SMOKE_STREAM_TIMEOUT", "600"))
    import time as _t
    r = urllib.request.urlopen(urllib.request.Request(
        f"{BASE}/api/interviews/{iid}/chat/stream", data=body,
        headers={"Content-Type": "application/json"}), timeout=budget)
    sse, deadline = b"", _t.time() + budget
    while _t.time() < deadline:
        try:
            chunk = r.read(4096)
        except Exception as e:
            raise SystemExit(f"stream read error after {round(_t.time()-deadline+budget,1)}s: {e!r}")
        if not chunk:
            break
        sse += chunk
        if b"event: done" in sse or b"event: error" in sse:
            break
    else:
        raise SystemExit("stream timed out before done (slow local model?)")
    sse = sse.decode("utf-8", "replace")
    hcheck("event: done" in sse, "stream emitted done")
    hcheck("event: error" not in sse, "stream had no error event")
    hcheck("event: message" in sse, "stream emitted message deltas")
    print(f"stream ok ({len(sse)} bytes, done present)")
finally:
    pass

# 4. assistant turn persisted
msgs = json.loads(http("GET", f"/api/interviews/{iid}/messages").read())
roles = [m["role"] for m in msgs]
hcheck("user" in roles and "assistant" in roles, "user+assistant turns persisted")
print("transcript persisted:", roles)

# 5. complete (may take a while with a local model)
complete_timeout = int(os.environ.get("LLM_SMOKE_COMPLETE_TIMEOUT", "600"))
resp = http("POST", f"/api/interviews/{iid}/complete", timeout=complete_timeout)
hcheck(resp.status == 200, "complete returns 200")
print("completed")

# 6. feedback persisted non-empty
fb = json.loads(http("GET", f"/api/interviews/{iid}/feedback").read())
hcheck(bool(fb.get("verdict")), "feedback verdict present")
hcheck(fb.get("scores"), "feedback scores present")
hcheck(fb.get("tips"), "feedback tips present")
print("feedback OK:", fb.get("scores"), "tips:", len(fb.get("tips") or []))

# 7. cleanup: delete the test interview so history stays clean.
http("DELETE", f"/api/interviews/{iid}", timeout=15)
print("deleted test interview:", iid)
PY
}

if ! command -v docker >/dev/null 2>&1; then
    die "docker not found — this script runs inside the backend container."
fi
if ! docker ps --filter "name=maxterview_backend_dev" --format '{{.Names}}' | grep -q maxterview; then
    die "backend container 'maxterview_backend_dev' not running. Run: make up"
fi

# Warn if the backend is likely in STUB mode (no LLM_BASE_URL) — the flow would pass
# without a model, which isn't a real smoke test.
STUB_HINT=$(docker exec maxterview_backend_dev sh -c 'echo "${LLM_BASE_URL:-}"' || true)
if [ -z "$STUB_HINT" ]; then
    log "WARN: LLM_BASE_URL is empty in the backend container — this will exercise STUB_MODE, not a real model."
    log "      Set LLM_BASE_URL/LLM_MODEL in .env and restart to test a live model."
fi
# Idempotent cleanup: remove leftover test interviews so a mid-stream timeout doesn't
# leave orphan in_progress rows in the real history.
cleanup_test_data() {
    docker exec maxterview_postgres psql -U maxterview -d maxterview -q \
        -c "DELETE FROM interviews WHERE role IN ('LLM Smoke','LLM Full Smoke');" >/dev/null 2>&1 || true
    log "cleaned leftover test interviews"
}
trap cleanup_test_data EXIT

log "running LLM smoke test against $BACKEND_URL (stream=${STREAM_TIMEOUT}s, complete=${COMPLETE_TIMEOUT}s)"
if run_backend; then
    log "SMOKE TEST PASSED"
else
    die "SMOKE TEST FAILED (see assertion output above)"
fi
