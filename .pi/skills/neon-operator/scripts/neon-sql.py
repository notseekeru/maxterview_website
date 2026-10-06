#!/usr/bin/env python3
"""One SQL statement against the prod Neon DB through the Neon MCP (see SKILL.md)."""
import json, pathlib, re, sys, urllib.request

MCP_URL = "https://mcp.neon.tech/mcp"
PROJECT_ID = "purple-base-79730983"
WRITE_RE = r"^\s*(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b"


def api_key() -> str:
    env = pathlib.Path(__file__).resolve().parents[4] / ".env"
    for line in env.read_text().splitlines():
        if line.startswith("NEON_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("NEON_API_KEY not found in repo .env")


def rpc(method: str, params: dict, sid: str | None, nid: int = 1) -> tuple[str, dict]:
    req = urllib.request.Request(
        MCP_URL,
        method="POST",
        data=json.dumps({"jsonrpc": "2.0", "id": nid, "method": method, "params": params}).encode(),
        headers={
            "Authorization": "Bearer " + api_key(),
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        },
    )
    if sid:
        req.add_header("Mcp-Session-Id", sid)
    with urllib.request.urlopen(req, timeout=120) as r:
        sid = sid or r.headers.get("Mcp-Session-Id")
        body = r.read().decode()
    m = re.search(r"data: (\{.*\})", body, re.S)
    if not m:
        sys.exit(body)
    return sid, json.loads(m.group(1))


def main() -> None:
    args = sys.argv[1:]
    allow = "--allow-write" in args
    sql = " ".join(a for a in args if a != "--allow-write").strip()
    if not sql:
        sys.exit("usage: neon-sql.py '<SQL>' [--allow-write]")
    if not allow and re.match(WRITE_RE, sql, re.I):
        sys.exit("refusing non-SELECT; pass --allow-write if intentional")
    sid, _ = rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "neon-sql", "version": "1.0"}}, None)
    rpc("notifications/initialized", {}, sid)
    _, res = rpc("tools/call", {"name": "run_sql", "arguments": {"project_id": PROJECT_ID, "sql": sql}}, sid, 2)
    out = res.get("result", res)
    if isinstance(out, dict) and "content" in out:
        print(out["content"][0]["text"])
    else:
        print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
