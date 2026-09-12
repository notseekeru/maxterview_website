#!/usr/bin/env bash
# llm-smoke-full.sh — FULL multi-turn lifecycle LLM smoke test for the maxterview backend.
#
# Unlike scripts/llm-smoke.sh (single happy-path turn), this walks the ENTIRE lifecycle
# against a *live* backend + real model:
#
#   create(->pending) -> list -> get single
#     -> start(->in_progress)
#       -> chat loop x N turns:
#           stream SSE (assert message deltas, done, no error)
#           re-read transcript, assert user/assistant alternate in order
#     -> complete(->completed, auto-feedback)
#     -> guard: chat/stream & start now 409 (read-only after completed)
#     -> feedback non-empty  +  manual UPSERT (POST twice, second wins)
#     -> delete -> 204, verify gone (404)
#
# Usage:
#   scripts/llm-smoke-full.sh                          # against http://localhost:8000
#   scripts/llm-smoke-full.sh http://host:PORT         # override backend base URL
#   TURNS=3 scripts/llm-smoke-full.sh                  # override chat-loop turns (default 2)
#
# It runs inside the backend container (same python/http stack that serves the API) so it
# is reproducible regardless of host tooling. Requires the dev stack to be up (make up) and
# a live LLM in .env (LLM_BASE_URL); otherwise STUB_MODE makes it a unit test, not a smoke.
#
# Exit codes: 0 = full lifecycle green; 1 = any assertion failed.
set -euo pipefail

BACKEND_URL="${1:-http://localhost:8000}"

# runner: run a python snippet inside the backend container.
run_backend() {
    docker exec -i -e LLM_SMOKE_STREAM_TIMEOUT -e LLM_SMOKE_COMPLETE_TIMEOUT -e LLM_SMOKE_TURNS \
        -w /app maxterview_backend_dev uv run python -u - "$BACKEND_URL" <<'PY'
import json
import os
import sys
import time as _t
import urllib.request
import urllib.error

BASE = sys.argv[1]


def http(method, path, body=None, timeout=20):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout)


def http_status(method, path, body=None, timeout=20):
    """Like http() but returns (status_code, parsed_json) instead of raising on HTTPError."""
    try:
        r = http(method, path, body=body, timeout=timeout)
        raw = r.read().decode("utf-8", "replace")
        try:
            payload = json.loads(raw) if raw.strip() else None  # handle 204 No Content
        except Exception:
            payload = None
        return r.status, payload
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode("utf-8", "replace"))
        except Exception:
            payload = None
        return e.code, payload


def hcheck(cond, label):
    if not cond:
        raise SystemExit(f"ASSERT FAILED: {label}")


def stream_one_turn(iid, content):
    """POST /chat/stream, read SSE via chunked loop, return decoded body."""
    budget = int(os.environ.get("LLM_SMOKE_STREAM_TIMEOUT", "600"))
    body = json.dumps({"interview_id": iid, "content": content}).encode()
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
    return sse.decode("utf-8", "replace")


# --- live guard: backend reachable and not STUB-without-model ---
hcheck(http_status("GET", "/api/health", timeout=10)[0] == 200, "/api/health ok")

# 1. create -> pending  (+ list + get single)
iid = json.loads(http("POST", "/api/interviews", {"role": "LLM Full Smoke", "topic": "lifecycle"}).read())["id"]
print("created:", iid)
hcheck(bool(iid), "interview id present")

c = json.loads(http("GET", f"/api/interviews/{iid}").read())
hcheck(c["status"] == "pending", "new interview is pending")
hcheck(c["role"] == "LLM Full Smoke", "role round-trips")

lst = json.loads(http("GET", "/api/interviews").read())
hcheck(any(x["id"] == iid for x in lst), "interview appears in list")
print("get + list OK")

# 2. start -> in_progress
hcheck(http_status("POST", f"/api/interviews/{iid}/start")[0] == 200, "start returns 200")
c = json.loads(http("GET", f"/api/interviews/{iid}").read())
hcheck(c["status"] == "in_progress", "status is in_progress after start")
print("started -> in_progress")

# 3. multi-turn chat loop
turns = int(os.environ.get("LLM_SMOKE_TURNS", "2"))
prompts = [
    "I have experience building distributed systems and APIs.",
    "I also work with databases, caching, and observability.",
    "Testing and CI/CD are a big part of my workflow.",
][:turns]
if len(prompts) < turns:
    prompts += ["Tell me more about that."] * (turns - len(prompts))

for idx, content in enumerate(prompts, start=1):
    print(f"-- turn {idx}/{turns} --")
    sse = stream_one_turn(iid, content)
    hcheck("event: done" in sse, f"turn {idx} emitted done")
    hcheck("event: error" not in sse, f"turn {idx} had no error event")
    hcheck("event: message" in sse, f"turn {idx} emitted message deltas")

    # transcript must show user+assistant alternating in order
    msgs = json.loads(http("GET", f"/api/interviews/{iid}/messages").read())
    roles = [m["role"] for m in msgs]
    expected = sum((["user", "assistant"] for _ in range(idx)), [])
    hcheck(roles == expected, f"turn {idx}: transcript roles {roles} == {expected}")
    print(f"turn {idx} ok; transcript roles={roles}")

# 4. complete -> completed (auto-feedback)
complete_timeout = int(os.environ.get("LLM_SMOKE_COMPLETE_TIMEOUT", "600"))
code, c = http_status("POST", f"/api/interviews/{iid}/complete", timeout=complete_timeout)
hcheck(code == 200, "complete returns 200")
hcheck(c["status"] == "completed", "status is completed after complete")
print("completed")

# 5. guard: read-only after completed — chat/stream and start now 409
code, _ = http_status("POST", f"/api/interviews/{iid}/chat/stream",
                      {"interview_id": iid, "content": "too late"})
hcheck(code == 409, "chat/stream rejected with 409 after completed")
code, _ = http_status("POST", f"/api/interviews/{iid}/start")
hcheck(code == 409, "start rejected with 409 after completed")
print("post-complete guards OK (409)")

# 6. feedback: auto non-empty, then manual UPSERT (POST twice -> second wins)
fb = json.loads(http("GET", f"/api/interviews/{iid}/feedback").read())
hcheck(bool(fb.get("verdict")), "auto feedback verdict present")
hcheck(fb.get("scores"), "auto feedback scores present")
hcheck(fb.get("tips"), "auto feedback tips present")
print("auto feedback OK:", fb.get("scores"), "tips:", len(fb.get("tips") or []))

code, fb2 = http_status("POST", f"/api/interviews/{iid}/feedback",
                        {"scores": {"clarity": 9, "relevance": 8, "structure": 7, "confidence": 9},
                         "verdict": "Manual overwrite verdict.", "tips": ["manual tip"]})
hcheck(code == 201, "manual feedback POST returns 201")
code, fb3 = http_status("POST", f"/api/interviews/{iid}/feedback",
                        {"scores": {"clarity": 1}, "verdict": "Second manual overwrite.", "tips": []})
hcheck(code == 201, "second manual feedback POST returns 201 (UPSERT)")
fb_final = json.loads(http("GET", f"/api/interviews/{iid}/feedback").read())
hcheck(fb_final["verdict"] == "Second manual overwrite.", "feedback UPSERT second write wins")
hcheck(fb_final["scores"]["clarity"] == 1, "scores updated by UPSERT")
print("feedback UPSERT OK")

# 7. delete -> 204, verify gone -> 404
code, _ = http_status("DELETE", f"/api/interviews/{iid}")
hcheck(code == 204, "delete returns 204")
code, _ = http_status("GET", f"/api/interviews/{iid}")
hcheck(code == 404, "deleted interview is 404 on get")
print("delete + gone OK")

print("FULL LIFECYCLE SMOKE PASSED")
PY
}

if ! command -v docker >/dev/null 2>&1; then
    echo "[llm-smoke-full] FAIL: docker not found — this script runs inside the backend container." >&2
    exit 1
fi
if ! docker ps --filter "name=maxterview_backend_dev" --format '{{.Names}}' | grep -q maxterview; then
    echo "[llm-smoke-full] FAIL: backend container 'maxterview_backend_dev' not running. Run: make up" >&2
    exit 1
fi

STUB_HINT=$(docker exec maxterview_backend_dev sh -c 'echo "${LLM_BASE_URL:-}"' || true)
if [ -z "$STUB_HINT" ]; then
    echo "[llm-smoke-full] WARN: LLM_BASE_URL empty in the backend container -> this exercises STUB_MODE, not a real model." >&2
fi
# Idempotent cleanup: remove any leftover test interviews (from this or prior failed runs)
# so a timeout mid-stream doesn't leave orphan in_progress rows in the real history.
cleanup_test_data() {
    docker exec maxterview_postgres psql -U maxterview -d maxterview -q \
        -c "DELETE FROM interviews WHERE role IN ('LLM Smoke','LLM Full Smoke');" >/dev/null 2>&1 || true
    echo "[llm-smoke-full] cleaned leftover test interviews"
}
trap 'cleanup_test_data' EXIT

TURNS="${LLM_SMOKE_TURNS:-2}"
echo "[llm-smoke-full] full lifecycle smoke against ${BACKEND_URL} (turns=${TURNS})"

run_backend
