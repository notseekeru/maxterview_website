import os
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.responses import StreamingResponse

from app.auth import CLERK_ENABLED, get_current_user
from app.db import close_pool, fetch, fetchrow, init_pool
from app.models import ChatTurn, ClerkUser, Feedback, Interview, InterviewCreate, Message, MessageCreate

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
    rows = await fetch(
        "SELECT id::text, owner_id, role, topic, status, created_at, updated_at FROM interviews WHERE owner_id = $1 ORDER BY created_at DESC",
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


# --- SSE stub (M6 wires the real LLM stream) ---


@app.post("/interviews/{interview_id}/chat/stream")
async def chat_stream(
    interview_id: str,
    body: ChatTurn,
    user: CurrentUser,
) -> StreamingResponse:
    await _require_interview_owned(interview_id, user.sub)

    async def _stub_events():
        # AI HERE: M6 replaces this stub with the real LLM SSE stream (app/llm.py).
        # MVP stub emits an immediate assistant placeholder so the frontend can wire up.
        yield f"event: message\ndata: {body.content}\n\n"
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(_stub_events(), media_type="text/event-stream")


# --- helper ---


async def _require_interview_owned(interview_id: str, owner_id: str) -> None:
    row = await fetchrow("SELECT 1 FROM interviews WHERE id = $1 AND owner_id = $2", interview_id, owner_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
