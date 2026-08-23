# SECURITY — maxterview

Threat model, control status, and accepted risks for the MVP. Companion to `PLAN.md` (§7 checklist).

**Current posture:** MVP is not yet production-deployed. Auth is the dev fallback (`CLERK_ENABLED=false` →
`DEV_USER`) until the k3s/GitOps + Clerk rollout is done (see README **Deployment** / PLAN).

---

## Control status (verified against source 2026-08-23)

| Control | Status | Verification |
|---|---|---|
| Secrets not in code/compose | ✅ | `.env` git-ignored; only `.env.example` committed |
| Postgres on internal network | ✅ dev / ⚠️ prod | `compose.yml` `internal: true`; prod must keep private network |
| Non-root image users | ✅ | backend `appuser`, frontend `node` |
| Pinned deps | ✅ | `uv.lock` + `package-lock.json`; `--frozen` / `npm ci` |
| No unauthenticated prod boot | ✅ | D2 guard refuses `CLERK_ENABLED=false` outside dev/test |
| Owner-scoped queries | ✅ | every handler filters `WHERE owner_id = sub` (D4) |
| Health endpoint leaks nothing | ✅ | `/health` returns `{status:ok}` |
| CORS | ⚠️ | **no** `CORSMiddleware` — safe only because prod frontend/API are same-origin behind nginx. Must add an allow-list if the API is ever cross-origin |
| LLM prompt-injection | ⚠️ | relies on the system prompt; no explicit sanitization. Streaming rate-limited at the ingress (gitops `limit-rps` 30/s). Token/usage caps deferred to M10 |
| Dependency vulnerability scan | ⚠️ | `npm audit` runs (informational) in CI; **Trivy not yet wired** for backend/image |
| Observability | ⚠️ | structlog dependency present but not fully wired as JSON-in-prod; Grafana Cloud (Loki/Prometheus/Grafana) not set up. See `OBSERVABILITY.md` |

---

## Threat model (MVP)

### Assets
- User interview transcripts (`interviews`, `messages`, `feedback`) in Postgres.
- LLM provider access (`LLM_API_KEY`). No user credentials stored (Clerk manages auth; BYOK explicitly out of scope).

### Trust boundary
Browser (React SPA) → nginx/Vite `/api` proxy → FastAPI → Postgres, and FastAPI → LLM provider. The **FastAPI backend is the trust boundary**: it must never trust the client (owner-scoping) and must not leak provider secrets.

### Principal threats & mitigations

| Threat | Mitigation | Gap |
|---|---|---|
| Cross-tenant data access | `WHERE owner_id = sub` on every query; foreign/unauthorized → 404 (not leaking existence) | None (D4) |
| Forged / replayed token | RS256-pinned, JWKS `kid`, `iss`/`exp` verified (`auth.py`) | `aud` only enforced if `CLERK_AUDIENCE` set (default off — enable pre-ship) |
| Runaway/unauthenticated API | Any request still requires `get_current_user` agent → `DEV_USER` in dev | Production requires `CLERK_ENABLED=true` |
| Prompt injection via user answer | System prompt acts as an interviewer boundary; model not given tools | No dedicated guardrail; open-ended content through to the LLM. Accept for MVP; ingress rate-limit mitigates abuse |
| Secret exfiltration via LLM | Provider keys are env-only, never in prompts | None |
| Dependency exploit | Pinned lockfile + `npm audit` (informational) | Trivy image scan + active `uv`/`npm` audits deferred |

### Rate limiting & abuse prevention

**Current state (verified 2026-08-23):**

| Layer | Control | Where | Status |
|---|---|---|---|
| Edge (ingress) | nginx `limit-rps: 30` / `limit-burst: 20` per ingress | gitops repo `infra/*-ingress.yaml` (inherited by a future maxterview ingress) | ✅ configured |
| Backend | **no rate limiter** | — | ⚠️ gap — nothing throttles per-client at the app layer |
| Backend | per-LLM-call `max_tokens` ceiling | `app/llm.py` `LLM_MAX_TOKENS` | ✅ bounds each request |
| Auth | required on every request (`get_current_user`) | `main.py` | ✅ (but `DEV_USER` in dev) |
| Usage/quota | per-user caps | — | ❌ deferred to **M10** (`require_tier`, daily interview + token budget) |

**Abuse vectors to guard (docs plan — no code yet):**

1. **Per-client API rate limit** — add an app-level limiter (e.g. `slowapi`/`limits`, in-memory or Redis) so one client can't hammer the LLM endpoint regardless of the shared ingress RPS. This is a **recommended M11/M10 code follow-up** (documented; not built).
2. **Streaming abuse** — SSE chat streams hold connections; bound per-user concurrent streams + total tokens (M10 meter). Ingress `proxy-read-timeout` (300s) bounds a single stream.
3. **Signup/login spray** — handled by Clerk (their rate limits + TOTP); do not build our own. Only relevant once `CLERK_ENABLED=true`.
4. **Bot / scraped free usage** — the free daily interview cap (M10) is the primary lever; ingress IP limits (`limit-rps`) are a secondary, shared-namespace backstop.

> These are **documented control intentions**; implementation happens under a M10/M11 code pass. M11 is docs-first by current scope.
---

## Accepted risks (post-MVP, noted not fixed)

1. **LLM prompt-injection surface** — user answers are forwarded to the LLM unfiltered. The model is a
   non-agent interviewer (no tools, no secrets in context), so injection has limited blast radius. Revisit if
   the LLM gains tools or fed sensitive user data.
2. **CORS relies on same-origin proxy** — safe behind nginx/Vite, but future cross-origin clients would need
   an explicit allow-list (currently no `CORSMiddleware`).
3. **Trivy + observability not wired** — dependency/binary scanning and error/uptime observability (Grafana) deferred.
4. **Local llama.cpp caveat** — no auth or isolation hardening on a local model server; dev-only, not a
   deployment target.

---

## Pre-ship checklist (before real production traffic)

- [ ] `CLERK_ENABLED=true` + real `CLERK_DOMAIN`/`CLERK_JWKS_URL`; set `CLERK_AUDIENCE`
- [ ] Add an app-level per-client rate limiter (slowapi/limits) + document in this file
- [ ] Resolve the Clerk domain/DNS (`clerk.seekeru.tech` Pending → approve Cloudflare records)
- [ ] `DATABASE_URL` (and `LLM_API_KEY`/Clerk keys) only in k8s secrets via Terraform/Infisical
- [ ] Keep Postgres on a private network; rest of the gitops ingress annotations (CSP/CORS/rate-limit) as-is
- [ ] Enable Trivy in the CD pipeline; wire Grafana observability (`OBSERVABILITY.md`)
- [ ] Dependency audits (`uv pip audit` / `npm audit`) non-informational after initial clean
- [ ] **Run a penetration test** against the deployed app before broad public traffic (see below)

---

## Penetration testing plan

A manual/assisted penetration test should run **before broad public traffic** (after the pre-ship
checklist above is complete). Scope and method are documented here; findings land back in this file
and the PLAN §7 checklist as they are resolved.

**Timing:** post-deploy, post-Clerk-enable, once an app-level rate limiter exists (M11 code pass).

**Scope (in):**
- `interviews`, `messages`, `feedback` CRUD + SSE chat endpoint (authz / authn / IDOR).
- Ownership isolation: second user must not read/modify the first user's interviews.
- JWT handling: tampered/expired/wrong-`aud`/rotated-key rejection.
- Input handling: oversized / malformed `role`/`topic`/message bodies (422/validation).
- Rate limiting & abuse: burst above `limit-rps`, high-concurrency streams.
- Prompt-injection attempts against the interview/feedback LLM calls.
- Secrets: no `DATABASE_URL`/`LLM_API_KEY`/Clerk keys in responses or `/health`.

**Scope (out / accepted-risks):** the LLM provider API itself, Clerk's SaaS auth, the k3s/gitops
cluster control plane, and Cloudflare (all vendor-managed).

**Tooling (recommended):** `OWASP ZAP` or `Burp Suite Community` for DAST on the deployed SPA+API;
`curl`/`jq`-driven authz checks; a local `llm-smoke-full.sh` run is a baseline sanity pass.

**Exit criteria:** no cross-tenant data access; all 401/404/409/422 paths behave per APPFLOW §7
error table; rate limiter trips as configured; no secret leakage. Record results + any new accepted
risks in this file.
