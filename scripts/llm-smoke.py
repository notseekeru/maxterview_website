#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

CONTAINER = "maxterview_backend_dev"
ROLE = "LLM Smoke"  # identifies test rows; removal is the API's own DELETE, never SQL
TURN = "I write code and ship features."

def log(msg: str) -> None:
    print(f"[llm-smoke] {msg}", flush=True)

def die(msg: str) -> None:
    print(f"[llm-smoke] FAIL: {msg}", file=sys.stderr, flush=True)
    raise SystemExit(1)

def check(cond: Any, label: str, detail: Any = "") -> None:
    """The whole assertion framework: a smoke test owes a verdict, not a runner."""
    if not cond:
        die(f"{label}{f' ({detail})' if detail else ''}")

# Inside the container: app.llm is importable here.

def _call(base: str, token: str, method: str, path: str, body: Any = None, timeout: float = 20.0):
    """-> (status, json | text). HTTP errors are returned, not raised: the status IS the assertion."""
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:400].decode("utf-8", "replace")
    except Exception as e:
        return 0, f"{type(e).__name__}: {e}"
    if not raw:
        return status, None
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw[:400].decode("utf-8", "replace")

def stream_turn(base: str, token: str, iid: str, timeout: float) -> tuple[str, float]:
    """POST one candidate turn, read SSE until done/error. Returns (sse, seconds)."""
    body = json.dumps({"interview_id": iid, "content": TURN}).encode()
    req = urllib.request.Request(f"{base}/api/interviews/{iid}/chat/stream", data=body, method="POST", headers={"Content-Type": "application/json"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    started = time.monotonic()
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        die(f"POST /chat/stream -> HTTP {e.code}: {e.read()[:400].decode('utf-8', 'replace')}")
    except Exception as e:
        die(f"POST /chat/stream unreachable: {type(e).__name__}: {e}")
    sse = b""
    try:
        while time.monotonic() - started < timeout:
            chunk = r.read(4096)
            if not chunk:
                break
            sse += chunk
            if b"event: done" in sse or b"event: error" in sse:
                break
        else:
            die(f"stream timed out after {timeout}s with no done event (slow local model?)")
    except Exception as e:
        die(f"stream died after {time.monotonic() - started:.1f}s: {type(e).__name__}: {e}")
    finally:
        r.close()

    text = sse.decode("utf-8", "replace")
    check("event: done" in text, "stream emitted done", text.strip()[-300:])
    check("event: error" not in text, "stream emitted no error event", text.strip()[-300:])
    check("event: message" in text, "stream emitted message deltas")
    return text, time.monotonic() - started

def run_inside(args: argparse.Namespace) -> None:
    from app.llm import FEEDBACK_DIMS

    base, token = args.base, args.token
    status, health = _call(base, token, "GET", "/api/health", timeout=10)
    check(status == 200 and (health or {}).get("status") == "ok", "GET /api/health", health or status)

    status, interview = _call(base, token, "POST", "/api/interviews", {"role": ROLE, "topic": "e2e"})
    check(status == 201 and (interview or {}).get("id"), "create interview", interview or status)
    iid = interview["id"]
    log(f"interview {iid} created")

    try:
        status, body = _call(base, token, "POST", f"/api/interviews/{iid}/start")
        check(status == 200, "POST /start", body or status)

        sse, elapsed = stream_turn(base, token, iid, args.stream_timeout)
        log(f"stream ok ({elapsed:.1f}s, {len(sse)} bytes, done present)")

        status, msgs = _call(base, token, "GET", f"/api/interviews/{iid}/messages")
        roles = [m["role"] for m in msgs or []]
        check(status == 200 and "user" in roles and "assistant" in roles, "transcript persisted", roles or status)
        log(f"transcript persisted: {', '.join(roles)}")

        status, body = _call(base, token, "POST", f"/api/interviews/{iid}/finish", timeout=args.finish_timeout)
        check(status == 200, "POST /finish", body or status)

        status, fb = _call(base, token, "GET", f"/api/interviews/{iid}/feedback")
        check(status == 200 and isinstance(fb, dict), "GET /feedback", fb or status)
        check(bool(fb.get("verdict")), "feedback verdict present")
        check(bool(fb.get("scores")), "feedback scores present")
        check(set(fb["scores"]) <= set(FEEDBACK_DIMS), "score keys are real dims", sorted(fb["scores"]))
        check(bool(fb.get("tips")), "feedback tips present")
        log(f"feedback ok: {len(fb['scores'])} dims, accuracy={fb.get('accuracy')}, {len(fb['tips'])} tips")
    finally:
        # The only cleanup path: an aborted run still removes its own row.
        status, _ = _call(base, token, "DELETE", f"/api/interviews/{iid}", timeout=15)
        log(f"deleted test interview {iid} (HTTP {status})")

# Host side: docker plumbing only.

def run_host(args: argparse.Namespace) -> None:
    if not shutil.which("docker"):
        die("docker not found: this script drives the backend container")
    ps = subprocess.run(["docker", "ps", "--filter", f"name={CONTAINER}", "--format", "{{.Names}}"], capture_output=True, text=True)
    if CONTAINER not in ps.stdout.split():
        die(f"backend container {CONTAINER} is not running. Run: make up")

    # Emptiness only: the value is config, and the warning is about STUB_MODE, not about the URL.
    set_base = subprocess.run(["docker", "exec", CONTAINER, "sh", "-c", 'test -n "$LLM_BASE_URL"'], capture_output=True).returncode
    if set_base != 0:
        log("WARN: LLM_BASE_URL is empty in the backend container: this exercises STUB_MODE, not a real model.")
        log("      Set LLM_BASE_URL/LLM_MODEL in .env and restart to test a live model.")

    log(f"target {args.base} (stream {args.stream_timeout:.0f}s, finish {args.finish_timeout:.0f}s)")
    inner = ["docker", "exec", "-i", "-w", "/app", CONTAINER, "uv", "run", "python", "-u", "-", "--inside", args.base]
    inner += ["--stream-timeout", str(args.stream_timeout), "--finish-timeout", str(args.finish_timeout)]
    if args.token:
        inner += ["--token", args.token]
    if subprocess.run(inner, input=Path(__file__).read_text(), text=True).returncode:
        die("SMOKE TEST FAILED (assertion output above)")
    log("SMOKE TEST PASSED")

def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("base", nargs="?", default="http://localhost:8000", help="backend base URL (default http://localhost:8000)")
    p.add_argument("--token", default=os.getenv("LLM_SMOKE_TOKEN", ""), help="bearer JWT, needed only when the target has CLERK_ENABLED=true (env LLM_SMOKE_TOKEN)")
    p.add_argument("--stream-timeout", type=float, default=float(os.getenv("LLM_SMOKE_STREAM_TIMEOUT", "600")), help="seconds to wait for the reply's done event")
    p.add_argument("--finish-timeout", type=float, default=float(os.getenv("LLM_SMOKE_FINISH_TIMEOUT", "600")), help="seconds to wait for /finish, which runs two model stages")
    p.add_argument("--inside", action="store_true", help="internal: check BASE from here, no docker plumbing")
    args = p.parse_args()
    if args.inside:
        run_inside(args)
    else:
        run_host(args)

if __name__ == "__main__":
    main()
