# PRD — maxterview (AI Mock-Interview Coach)

**Product:** AI mock-interview coach — practice interviews with an LLM that asks questions, gives
feedback, and scores performance. **MVP is text-only; voice is a later phase.**
**Docs family:** this file (product), `PLAN.md` (technical plan/decisions D1–D10), `MONETIZATION.md` (billing, M10).
**Status:** Draft · Owner: user · Last updated: 2026-08-16

---

## 1. Problem & Goal

**Problem:** Job-seekers need realistic interview practice, but human mock interviews are scarce,
costly, or awkward. Most do unstructured prep with no feedback and no measure of progress.

**Goal (MVP):** Let a user run a **simulated, text-based interview** with an AI interviewer, get
**per-question and end-of-interview feedback + a score**, and see their **interview history** so they
can track improvement.

**Success metrics (MVP):**
- User completes ≥ 1 full simulated interview.
- User can see a feedback + score after an interview.
- Repeat usage: ≥ 2 interviews recorded per active user (progress tracking works).

---

## 2. Personas

Primary (MVP): **The job-seeker**
- Actively interviewing or prepping for behavioral/technical interviews.
- Wants low-friction, private, on-demand practice.
- Wants actionable feedback, not just questions.
- Single user per account (no teams — D4 owner-scoping). Free/premium tiers (see MONETIZATION).

---

## 3. User stories (MVP)

| ID | User story | Priority |
|---|---|---|
| US1 | As a user, I can create an interview by choosing a **role** (and optional **topic**). | P0 |
| US2 | As a user, I can have the AI ask me interview questions **one at a time**. | P0 |
| US3 | As a user, I can type my answers and have the AI respond/continue. | P0 |
| US4 | As a user, I can **end** the interview and receive **feedback + a score**. | P0 |
| US5 | As a user, I can see my **past interviews** (roles, dates, scores). | P0 |
| US6 | As a user, I can view the **messages** of a past interview. | P1 |
| US7 | As a user, I sign in (Clerk) and all my data is scoped to my account (D4). | P0 |
| US8 | (M10) As a free-tier user, I'm capped at 1 interview/day; premium is unlimited. | P2 |

**Out of scope (MVP):** voice input/output, real-time video, team/org accounts, dashboard charts,
custom question banks, resume parsing.

**Future / designed-not-built (documented so it's not lost):**
- **BYOK (Bring-Your-Own-Key):** user supplies their own LLM API key (e.g. DeepSeek/OpenAI). **Not MVP** —
  flagged now because it collides with (a) **credential storage** (storing third-party API keys requires an
  encrypted keystore + rotation + breach playbook — conflicts with PLAN §7/AGENTS zero-touch posture), and
  (b) **M10 monetization** (a BYOK user consumes their own tokens, bypassing the free/premium token-budget
  model in `MONETIZATION.md`). If pursued later, resolve both first (flavor: premium-gated vs. all-users;
  and whether BYOK usage is still metered).

---

## 4. Functional requirements

### 4.1 Auth (Clerk)
- User signs in via Clerk (frontend SDK). Backend verifies the JWT (`app/auth.py`).
- Every request resolves a `ClerkUser` (`get_current_user`); every query is scoped to `sub` = `owner_id` (D4).
- Dev/test: `CLERK_ENABLED=false` → fixed `DEV_USER` (D2).

### 4.2 Interviews
- **Create:** user picks a **role** (required) + **topic** (optional). Status = `pending`.
- **Start:** status → `in_progress`. AI begins the simulated interview.
- **Complete:** status → `completed` after the interview ends; feedback generated.
- Owned by `owner_id`; user can only access their own interviews (D4).
- (M10) Free tier: 1 interview/day — covered in `MONETIZATION.md`, not enforced in MVP.

### 4.3 Interview flow (simulated, text)
1. AI opens with a greeting + first question.
2. User replies with text.
3. AI asks the next question (optionally reacts to the user's answer).
4. Loop until the user ends the interview (US4) or a natural completion.
- All turns stored as `messages` (`user` / `assistant` / `system`), ordered by `created_at`.

### 4.4 Feedback & scoring
- At interview end, the LLM generates:
  - **Per-dimension scores:** `clarity`, `relevance`, `structure`, `confidence` (JSONB).
  - **Overall verdict** (text).
  - **Actionable tips** (array, JSONB).
- Stored in `feedback` (one per interview).
- Same feedback depth for free and premium (only quota/token budgets differ — MONETIZATION §1).

### 4.5 History / progress
- List of past interviews: role, topic, status, created_at, and score if completed.
- Optional: view a single interview's messages + feedback.

### 4.6 Consumption & metering (M10 only)
- Token budget metered server-side (per-interview + daily), input+output. See `MONETIZATION.md`.
- Not enforced during MVP (dev-fallback); `ClerkUser.tier` carried but unused in MVP.

---

## 5. Non-functional requirements

| Area | Requirement |
|---|---|
| Privacy/security | Every query scoped to `owner_id` (D4); no data leaks across users; 401 on bad token (no leak). |
| Latency | Question/answer turns feel responsive; feedback may be slower (LLM). SSE for streaming feedback/answers. |
| Reliability | `usage`/quota counters atomic + idempotent (M10); reads never expose internals. |
| Mobile | Responsive web UI (text-first). |
| Cost control | Per-tier token budgets + kill-switch (M10) — see MONETIZATION. |
| Observability | structlog (JSON in prod). Sensible request logging. |

---

## 6. Acceptance criteria (core)

- **US1/US4:** Creating an interview with a role, running a simulated Q&A, and ending it produces a
  stored interview, its messages, and a feedback record (with 4 dimension scores + verdict + tips).
- **US2/US3:** All turns persist as `messages`; reopening shows the conversation in order.
- **US5:** The interview list shows each completed interview's role and score; only the owner's data.
- **US7:** Unauthenticated/foreign-user requests are rejected or scoped out (401 / empty).
- **M10 readiness:** `ClerkUser.tier` present on every handler; gate stubbed (no enforcement) in MVP.

---

## 7. Scope (MVP vs. later)

**In MVP (M1–M9):** auth, interviews CRUD, simulated text interview (LLM via M6), feedback+scoring,
history, text-only frontend (M8). Paid gating is **not** enforced.

**Later (M10+):** billing/monetization, enforcement, `GET /usage`, premium upsell UI, dashboard
charts, voice, teams.
