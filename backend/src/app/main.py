import os
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.responses import StreamingResponse

from app import llm
from app.auth import CLERK_ENABLED, get_current_user
from app.db import close_pool, fetch, fetchrow, init_pool
from app.models import ChatMessage, ChatTurn, ClerkUser, Feedback, FeedbackCreate, Interview, InterviewCreate, Message, MessageCreate

APP_ENV = os.getenv("APP_ENV", "development")

if not CLERK_ENABLED and APP_ENV not in ("development", "test"):
    raise RuntimeError("CLERK_ENABLED=false is only allowed when APP_ENV is development or test; refusing to boot.")

CurrentUser = Annotated[ClerkUser, Depends(get_current_user)]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await init_pool()
    yield
    await close_pool()


app = FastAPI(title="maxterview", lifespan=lifespan)


@app.get("/health")
async def health() -> dict:
    # No DB call — CD smoke runs with a dummy DATABASE_URL and no Postgres.
    return {"status": "ok"}


# --- interviews (all scoped to owner_id, D4) ---


@app.get("/interviews", response_model=list[Interview])
async def list_interviews(user: CurrentUser) -> list[dict]:
    # Include optional score/verdict by LEFT JOIN feedback (US5: history shows a score; avoids N+1).
    rows = await fetch(
        """
        SELECT i.id::text, i.owner_id, i.role, i.topic, i.status, i.created_at, i.updated_at,
               f.verdict AS verdict,
               CASE WHEN jsonb_typeof(f.scores) = 'object' THEN
                 (SELECT round(avg(v.value::numeric)::numeric, 1) FROM jsonb_each_text(f.scores) AS v)
               ELSE NULL END AS score
        FROM interviews i
        LEFT JOIN feedback f ON f.interview_id = i.id
        WHERE i.owner_id = $1
        ORDER BY i.created_at DESC
        """,
        user.sub,
    )
    return [dict(r) for r in rows]


@app.post("/interviews", response_model=Interview, status_code=status.HTTP_201_CREATED)
async def create_interview(
    body: InterviewCreate,
    user: CurrentUser,
) -> dict:
    # M10 (MONETIZATION): free daily cap enforced here (conditional INSERT). Stubbed in MVP.
    row = await fetchrow(
        "INSERT INTO interviews (owner_id, role, topic) VALUES ($1, $2, $3) RETURNING id::text, owner_id, role, topic, status, created_at, updated_at",
        user.sub,
        body.role,
        body.topic,
    )
    return dict(row)


@app.get("/interviews/{interview_id}", response_model=Interview)
async def get_interview(
    interview_id: str,
    user: CurrentUser,
) -> dict:
    row = await fetchrow(
        "SELECT id::text, owner_id, role, topic, status, created_at, updated_at FROM interviews WHERE id = $1 AND owner_id = $2",
        interview_id,
        user.sub,
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    return dict(row)


@app.delete("/interviews/{interview_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_interview(
    interview_id: str,
    user: CurrentUser,
) -> None:
    result = await fetchrow(
        "DELETE FROM interviews WHERE id = $1 AND owner_id = $2 RETURNING id",
        interview_id,
        user.sub,
    )
    if result is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")


@app.post("/interviews/{interview_id}/start", response_model=Interview)
async def start_interview(
    interview_id: str,
    user: CurrentUser,
) -> dict:
    # pending -> in_progress (PRD US2: the AI begins asking questions).
    row = await fetchrow(
        "UPDATE interviews SET status = 'in_progress', updated_at = now() WHERE id = $1 AND owner_id = $2 AND status = 'pending' RETURNING id::text, owner_id, role, topic, status, created_at, updated_at",
        interview_id,
        user.sub,
    )
    if row is None:
        # Could be a foreign interview (404) or one already started (409).
        await _raise_start_error(interview_id, user.sub)
    return dict(row)


@app.post("/interviews/{interview_id}/complete", response_model=Interview)
async def complete_interview(
    interview_id: str,
    user: CurrentUser,
) -> dict:
    # in_progress -> completed (PRD US4: end -> feedback + score).
    row = await fetchrow(
        "UPDATE interviews SET status = 'completed', updated_at = now() WHERE id = $1 AND owner_id = $2 AND status = 'in_progress' RETURNING id::text, owner_id, role, topic, status, created_at, updated_at",
        interview_id,
        user.sub,
    )
    if row is None:
        await _raise_complete_error(interview_id, user.sub)
    interview = dict(row)

    # M6: auto-generate + persist feedback from the transcript (decision: in `complete`).
    await _generate_and_persist_feedback(interview_id)

    return interview


# --- messages ---


@app.get("/interviews/{interview_id}/messages", response_model=list[Message])
async def list_messages(
    interview_id: str,
    user: CurrentUser,
) -> list[dict]:
    # Verify the interview belongs to the user first (D4).
    await _require_interview_owned(interview_id, user.sub)
    rows = await fetch(
        "SELECT id::text, interview_id::text, role, content, created_at FROM messages WHERE interview_id = $1 ORDER BY created_at",
        interview_id,
    )
    return [dict(r) for r in rows]


@app.post("/interviews/{interview_id}/messages", response_model=Message, status_code=status.HTTP_201_CREATED)
async def create_message(
    interview_id: str,
    body: MessageCreate,
    user: CurrentUser,
) -> dict:
    await _require_interview_owned(interview_id, user.sub)
    # Messages only make sense mid-interview (Gap 4): reject if not in_progress.
    status_row = await fetchrow(
        "SELECT status FROM interviews WHERE id = $1 AND owner_id = $2",
        interview_id,
        user.sub,
    )
    if status_row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    if status_row["status"] != "in_progress":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Interview is not in progress")
    row = await fetchrow(
        "INSERT INTO messages (interview_id, role, content) VALUES ($1, 'user', $2) RETURNING id::text, interview_id::text, role, content, created_at",
        interview_id,
        body.content,
    )
    return dict(row)


# --- feedback ---


@app.get("/interviews/{interview_id}/feedback", response_model=Feedback)
async def get_feedback(
    interview_id: str,
    user: CurrentUser,
) -> dict:
    await _require_interview_owned(interview_id, user.sub)
    row = await fetchrow(
        "SELECT id::text, interview_id::text, scores, verdict, tips, created_at FROM feedback WHERE interview_id = $1",
        interview_id,
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Feedback not found")
    return dict(row)


@app.post("/interviews/{interview_id}/feedback", response_model=Feedback, status_code=status.HTTP_201_CREATED)
async def create_feedback(
    interview_id: str,
    body: FeedbackCreate,
    user: CurrentUser,
) -> dict:
    # Gap B: UPSERT — feedback.interview_id is UNIQUE; a plain INSERT would 500 on a second write.
    # M6's LLM handler calls this to write/update scores (may retry, idempotent).
    await _require_interview_owned(interview_id, user.sub)
    # JSONB round-trips natively via the pool codec (db.py init), so pass dict/list directly.
    row = await fetchrow(
        "INSERT INTO feedback (interview_id, scores, verdict, tips) VALUES ($1, $2, $3, $4) ON CONFLICT (interview_id) DO UPDATE SET scores = EXCLUDED.scores, verdict = EXCLUDED.verdict, tips = EXCLUDED.tips, created_at = now() RETURNING id::text, interview_id::text, scores, verdict, tips, created_at",
        interview_id,
        body.scores,
        body.verdict,
        body.tips,
    )
    return dict(row)


# --- SSE: interview chat (M6 wires real LLM streaming) ---


@app.post("/interviews/{interview_id}/chat/stream")
async def chat_stream(
    interview_id: str,
    body: ChatTurn,
    user: CurrentUser,
) -> StreamingResponse:
    await _require_interview_owned(interview_id, user.sub)
    # Consistent with create_message: chatting only makes sense mid-interview.
    interview = await fetchrow(
        "SELECT id::text, role, topic, status FROM interviews WHERE id = $1 AND owner_id = $2",
        interview_id,
        user.sub,
    )
    if interview is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    if interview["status"] != "in_progress":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Interview is not in progress")

    # Persist the user turn (chat_stream owns the user answer per decision).
    user_msg = await fetchrow(
        "INSERT INTO messages (interview_id, role, content) VALUES ($1, 'user', $2) RETURNING id::text",
        interview_id,
        body.content,
    )
    user_msg_id = user_msg["id"] if user_msg else None

    # Build the LLM context: system prompt + prior transcript (owner's interview, ordered).
    prior_rows = await fetch(
        "SELECT role, content FROM messages WHERE interview_id = $1 ORDER BY created_at",
        interview_id,
    )
    history = [
        ChatMessage(role="system", content=llm.system_prompt(interview["role"], interview["topic"])),
        *[ChatMessage(role=r["role"], content=r["content"]) for r in prior_rows],
    ]

    async def _stream_events():
        # M6: real LLM streaming (llm.py). Streams increment deltas, then emits a done event.
        # On LLM failure: emit an SSE error event and roll back the orphaned user message.
        collected: list[str] = []
        try:
            async for delta in llm.stream_chat(history):
                if delta:
                    collected.append(delta)
                    yield f"event: message\ndata: {delta}\n\n"
        except Exception as exc:  # LLM/network failure mid-stream
            # Remove the just-inserted user message so no orphan transcript remains.
            if user_msg_id:
                await fetchrow(
                    "DELETE FROM messages WHERE id = $1 AND interview_id = $2",
                    user_msg_id,
                    interview_id,
                )
            yield f"event: error\ndata: {str(exc)}\n\n"
            return
        # Persist the completed assistant turn so the transcript is complete.
        reply = "".join(collected).strip()
        await fetchrow(
            "INSERT INTO messages (interview_id, role, content) VALUES ($1, 'assistant', $2) RETURNING id",
            interview_id,
            reply,
        )
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(_stream_events(), media_type="text/event-stream")


# --- helper ---


async def _require_interview_owned(interview_id: str, owner_id: str) -> None:
    row = await fetchrow("SELECT 1 FROM interviews WHERE id = $1 AND owner_id = $2", interview_id, owner_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")


async def _generate_and_persist_feedback(interview_id: str) -> None:
    """M6: generate feedback from the transcript and write it (idempotent UPSERT)."""
    history_rows = await fetch(
        "SELECT role, content FROM messages WHERE interview_id = $1 ORDER BY created_at",
        interview_id,
    )
    history = [ChatMessage(role=r["role"], content=r["content"]) for r in history_rows]
    summary = await llm.generate_feedback(history)
    await fetchrow(
        "INSERT INTO feedback (interview_id, scores, verdict, tips) VALUES ($1, $2, $3, $4) ON CONFLICT (interview_id) DO UPDATE SET scores = EXCLUDED.scores, verdict = EXCLUDED.verdict, tips = EXCLUDED.tips, created_at = now() RETURNING id",
        interview_id,
        summary.scores,
        summary.verdict,
        summary.tips,
    )


async def _raise_start_error(interview_id: str, owner_id: str) -> None:
    # Distinguish "foreign/not found" (404) from "already started" (409).
    row = await fetchrow("SELECT status FROM interviews WHERE id = $1 AND owner_id = $2", interview_id, owner_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Interview is not pending")


async def _raise_complete_error(interview_id: str, owner_id: str) -> None:
    row = await fetchrow("SELECT status FROM interviews WHERE id = $1 AND owner_id = $2", interview_id, owner_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Interview is not in progress")
