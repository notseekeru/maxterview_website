---
name: neon-operator
description: >-
  Read-only prod database hands through the Neon MCP. Load when the user asks what's in prod
  (interviews, transcripts, feedback, usage), to verify prod state without kubectl, or to audit
  whether an AI's feedback matches the transcript it graded.
---

# neon-operator

You are operating the PROD Postgres (Neon) behind maxterview. This is the same database the
prod backend writes. There is no cluster access from this workspace; this is the read path.

## Measured facts

- Project `purple-base-79730983` (`neon_maxterview_website`, aws-ap-southeast-1), org
  `org-spring-wind-56300230` ("Stephen"). Default branch, db `neondb`.
- The Neon MCP is wired in `.mcp.json` (`https://mcp.neon.tech/mcp`, bearer from repo `.env`
  `NEON_API_KEY`, destructive tools gated by approveTools).
- The raw API v2 (`console.neon.tech/api/v2/projects`) 400s without `org_id`, and there is no
  orgs endpoint, so drive the MCP, not the API. Handshake that works: `initialize`
  (protocolVersion `2025-03-26`) → `notifications/initialized` → `tools/call` `run_sql`
  `{project_id, sql}`. Responses are SSE (`event: message` / `data: {...}`); reuse the
  `Mcp-Session-Id` response header across calls. `run_sql_transaction` takes
  `{sql_statements: [...]}` for multi-statement reads.
- One-command kit: `scripts/neon-sql.py '<SQL>'` from repo root (reads the key from `.env`
  itself; SELECT-only unless `--allow-write`).

## Schema source of truth

`backend/migrations/*.sql`. Key tables:

- `interviews` (owner_id, role, topic, status, level, created_at)
- `messages` (interview_id, role, content, created_at, move_class, comment)
- `feedback` (interview_id UNIQUE, scores jsonb, verdict, tips jsonb, decision, certainty, accuracy)

## Known prod owners

- `user_3JL9fJezMFKuM5rPUPy69x4nuvQ` — seekeru (Stephen), the bulk of interviews
- `user_3JFRNgZpOXEBTBBaVwjxv53IlGg`

## Proven queries

```sql
-- last N interviews
SELECT id, owner_id, role, status, level, created_at FROM interviews ORDER BY created_at DESC LIMIT 5;
-- transcript for one interview
SELECT role, content FROM messages WHERE interview_id='<uuid>' ORDER BY created_at;
-- feedback for one interview
SELECT scores, verdict, tips, decision, certainty, accuracy FROM feedback WHERE interview_id='<uuid>';
```

## Rules

- SELECT-only by default. Any write goes through the human first; the script's guard is the
  second line of defense behind the MCP's approveTools.
- Never print `NEON_API_KEY`; presence check only (`grep -c`).
- Transcripts are private user data: never commit them, log them, or paste them into docs.
- Feedback audits: diff the verdict against the transcript. A claim about an answer that does
  not exist in `messages` (or contradicts it) is a grader failure, not a user failure.
