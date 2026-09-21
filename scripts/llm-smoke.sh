#!/usr/bin/env bash

# Usage:
#   scripts/llm-smoke.sh                 # against http://localhost:8000
#   scripts/llm-smoke.sh http://host:PORT  # override backend base URL

set -euo pipefail

BACKEND_URL="${1:-http://localhost:8000}"
STREAM_TIMEOUT="${LLM_SMOKE_STREAM_TIMEOUT:-600}"
FINISH_TIMEOUT="${LLM_SMOKE_FINISH_TIMEOUT:-600}"

log() { printf '\n[llm-smoke] %s\n' "$*"; }
die() {
    printf '\n[llm-smoke] FAIL: %s\n' "$*" >&2
    exit 1
}

run_backend() {
    docker exec -i -e LLM_SMOKE_STREAM_TIMEOUT -e LLM_SMOKE_FINISH_TIMEOUT -w /app maxterview_backend_dev uv run python -u - "$BACKEND_URL" <<'PY'
import json
import os
import sys
import urllib.request

from app.llm import FEEDBACK_DIMS

BASE = sys.argv[1]


def http(method, path, body=None, timeout=20):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout)


def hcheck(cond, label):
    if not cond:
        raise SystemExit(f"ASSERT FAILED: {label}")

try:
    health = json.loads(http("GET", "/api/health", timeout=10).read())
    hcheck(health.get("status") == "ok", "/api/health ok")
except Exception as e:
    raise SystemExit(f"backend unreachable at {BASE}: {e!r}")

iid = json.loads(http("POST", "/api/interviews", {"role": "LLM Smoke", "topic": "e2e"}).read())["id"]
print("created interview:", iid)
hcheck(bool(iid), "interview id present")

http("POST", f"/api/interviews/{iid}/start")
print("started")
try:
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

msgs = json.loads(http("GET", f"/api/interviews/{iid}/messages").read())
roles = [m["role"] for m in msgs]
hcheck("user" in roles and "assistant" in roles, "user+assistant turns persisted")
print("transcript persisted:", roles)

finish_timeout = int(os.environ.get("LLM_SMOKE_FINISH_TIMEOUT", "600"))
resp = http("POST", f"/api/interviews/{iid}/finish", timeout=finish_timeout)
hcheck(resp.status == 200, "finish returns 200")
print("completed")

fb = json.loads(http("GET", f"/api/interviews/{iid}/feedback").read())
hcheck(bool(fb.get("verdict")), "feedback verdict present")
hcheck(fb.get("scores"), "feedback scores present")
hcheck(set(fb["scores"]) <= set(FEEDBACK_DIMS), f"score keys are real dims, got {sorted(fb['scores'])}")
hcheck(fb.get("tips"), "feedback tips present")
print("feedback OK:", fb.get("scores"), "tips:", len(fb.get("tips") or []))

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

STUB_HINT=$(docker exec maxterview_backend_dev sh -c 'echo "${LLM_BASE_URL:-}"' || true)
if [ -z "$STUB_HINT" ]; then
    log "WARN: LLM_BASE_URL is empty in the backend container — this will exercise STUB_MODE, not a real model."
    log "      Set LLM_BASE_URL/LLM_MODEL in .env and restart to test a live model."
fi
cleanup_test_data() {
    docker exec maxterview_postgres psql -U maxterview -d maxterview -q \
        -c "DELETE FROM interviews WHERE role IN ('LLM Smoke','LLM Full Smoke');" >/dev/null 2>&1 || true
    log "cleaned leftover test interviews"
}
trap cleanup_test_data EXIT

log "running LLM smoke test against $BACKEND_URL (stream=${STREAM_TIMEOUT}s, complete=${FINISH_TIMEOUT}s)"
if run_backend; then
    log "SMOKE TEST PASSED"
else
    die "SMOKE TEST FAILED (see assertion output above)"
fi
