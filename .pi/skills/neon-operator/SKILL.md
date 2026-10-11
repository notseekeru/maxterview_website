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

- Project `purple-base-79730983` (`neon_maxterview_website`, aws-ap-southeast-1, PG 18), org
  `org-spring-wind-56300230` ("Stephen"). Default branch `production`, db `neondb`, role
  `neondb_owner`.
- The Neon MCP is wired in `.pi/mcp.json`: `https://mcp.neon.tech/mcp`, bearer header built from
  repo `.env` `NEON_API_KEY`. It serves `run_sql` alongside project, branch, role and snapshot
  admin tools, `delete_project` and `reset_from_parent` among them. Pi gates none of them:
  `approveTools` is not a pi config key and does nothing.
- Neon's tool arguments are snake_case (`project_id`, not `projectId`).
- The raw API v2 (`console.neon.tech/api/v2/projects`) 400s without `org_id`, and there is no
  orgs endpoint, so drive the MCP.
- One-command kit: `.pi/skills/neon-operator/scripts/neon-sql.py '<SQL>'` from repo root. It
  carries its own MCP handshake (`initialize`, `notifications/initialized`, `tools/call run_sql`),
  reads the key from `.env` itself, and refuses non-SELECT unless `--allow-write`. Use it when the
  MCP tools are not loaded in the session.

## Schema source of truth

`backend/migrations/*.sql`. Prod tables worth knowing by name: `interviews`, `messages`
(transcript), `feedback` (scores, verdict, tips), `subscriptions`, `turn_usage`,
`llm_credentials`, `offers`, `resumes`, `interview_templates`, `template_seeds`.

## Known prod owners

- `user_3JL9fJezMFKuM5rPUPy69x4nuvQ`: seekeru (Stephen), the bulk of interviews
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

- SELECT-only by default. Any write goes through the human first; the script's guard is the only
  enforcement, since the MCP has none.
- Never print `NEON_API_KEY`; presence check only (`grep -c`).
- Transcripts are private user data: never commit them, log them, or paste them into docs.
- Feedback audits: diff the verdict against the transcript. A claim about an answer that does
  not exist in `messages` (or contradicts it) is a grader failure, not a user failure.
