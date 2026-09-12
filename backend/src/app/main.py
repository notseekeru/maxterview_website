import asyncio
import os
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse

from app import API_PREFIX, billing, llm, payments
from app.auth import CLERK_ENABLED, get_current_user
from app.db import close_pool, fetch, fetchrow, init_pool
from app.models import ChatMessage, ChatTurn, ClerkUser, Dials, Feedback, FeedbackCreate, Interview, InterviewCreate, Message
from app.ratelimit import ClientRateLimitMiddleware

APP_ENV = os.getenv("APP_ENV", "development")


# M11 CORS allow-list: empty by default, because the SPA reaches the API same-origin through the
# nginx/Vite `/api` proxy and needs no CORS at all. Only set `CORS_ALLOW_ORIGINS` (comma-separated
# exact origins, never `*`) if the API is ever called from another origin.
def cors_origins(raw: str) -> list[str]:
    return [o.strip() for o in raw.split(",") if o.strip()]


CORS_ALLOW_ORIGINS = cors_origins(os.getenv("CORS_ALLOW_ORIGINS", ""))

COMPLETE_MAX_FEEDBACK_ATTEMPTS = 3
COMPLETE_FEEDBACK_BACKOFF_MS = 800


async def _backoff_sleep(ms: int) -> None:
    """Module hook so tests can patch the auto-retry pause to a no-op."""
    await asyncio.sleep(ms / 1000)


if not CLERK_ENABLED and APP_ENV not in ("development", "test"):
    raise RuntimeError("CLERK_ENABLED=false is only allowed when APP_ENV is development or test; refusing to boot.")

CurrentUser = Annotated[ClerkUser, Depends(get_current_user)]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await init_pool()
    yield
    await close_pool()


app = FastAPI(title="maxterview", lifespan=lifespan)

# AI HERE: /api is owned here (matches diagram), not by the dev proxy or the ingress — every layer
# passes the path through unchanged. Upgrade path: per-router prefixes if an admin/internal split lands.
api = APIRouter(prefix=API_PREFIX)

# Added first => innermost, so CORS stays outermost and its headers are still on a 429.
app.add_middleware(ClientRateLimitMiddleware)
if CORS_ALLOW_ORIGINS:
    app.add_middleware(CORSMiddleware, allow_origins=CORS_ALLOW_ORIGINS, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])


@api.get("/health")
async def health() -> dict:
    # No DB call — CD smoke runs with a dummy DATABASE_URL and no Postgres.
    return {"status": "ok"}


# --- interviews (all scoped to owner_id, D4) ---


# The interview dressing dials, as pydantic field names. Identical in the DB, so one tuple serves
# the `Dials(**row)` build, the columns of every interview read, and nothing can drift between them.
DIAL_FIELDS = ("company_size", "cynicism", "brutally_honest", "human_mode", "mix_chitchat", "mix_behavioural", "mix_technical")

# Interview row columns for every SELECT/RETURNING that builds an `Interview`. Shared because
# `Interview` fills an absent field from its default, so a query that forgets a dial would answer
# 200 with a WRONG value ('neutral' for a run created skeptical) rather than an error.
INTERVIEW_COLS = "id::text, owner_id, role, level, topic, status, created_at, updated_at, " + ", ".join(DIAL_FIELDS)


@api.get("/interviews", response_model=list[Interview])
async def list_interviews(user: CurrentUser) -> list[dict]:
    # Include optional score/verdict by LEFT JOIN feedback (US5: history shows a score; avoids N+1).
    rows = await fetch(
        f"""
        SELECT i.id::text, i.owner_id, i.role, i.level, i.topic, i.status, i.created_at, i.updated_at,
               {", ".join(f"i.{c}" for c in DIAL_FIELDS)},
               f.verdict AS verdict, f.decision AS decision, f.certainty AS certainty,
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


@api.post("/interviews", response_model=Interview, status_code=status.HTTP_201_CREATED)
async def create_interview(
    body: InterviewCreate,
    user: CurrentUser,
) -> dict:
    row = await fetchrow(
        """
        INSERT INTO interviews (owner_id, role, level, topic, company_size, cynicism, brutally_honest, human_mode, mix_chitchat, mix_behavioural, mix_technical)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING """
        + INTERVIEW_COLS,
        user.sub,
        body.role,
        body.level,
        body.topic,
        body.company_size,
        body.cynicism,
        body.brutally_honest,
        body.human_mode,
        body.mix_chitchat,
        body.mix_behavioural,
        body.mix_technical,
    )
    return dict(row)


@api.get("/interviews/{interview_id}", response_model=Interview)
async def get_interview(
    interview_id: str,
    user: CurrentUser,
) -> dict:
    row = await fetchrow(
        f"SELECT {INTERVIEW_COLS} FROM interviews WHERE id = $1 AND owner_id = $2",
        interview_id,
        user.sub,
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    return dict(row)


@api.delete("/interviews/{interview_id}", status_code=status.HTTP_204_NO_CONTENT)
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


@api.post("/interviews/{interview_id}/start", response_model=Interview)
async def start_interview(
    interview_id: str,
    user: CurrentUser,
) -> dict:
    row = await fetchrow(
        "UPDATE interviews SET status = 'in_progress', updated_at = now() WHERE id = $1 AND owner_id = $2 AND status = 'pending' RETURNING " + INTERVIEW_COLS,
        interview_id,
        user.sub,
    )
    if row is None:
        await _raise_start_error(interview_id, user.sub)
    return dict(row)


@api.post("/interviews/{interview_id}/complete", response_model=Interview)
async def complete_interview(
    interview_id: str,
    user: CurrentUser,
) -> dict:
    # EXISTS guard in the same UPDATE (not a pre-check) so a foreign id still 404s, no extra
    # round trip, and nothing can slip a turn in between. Mirrors _has_transcript().
    row = await fetchrow(
        "UPDATE interviews SET status = 'completed', updated_at = now() WHERE id = $1 AND owner_id = $2 AND status = 'in_progress' AND EXISTS (SELECT 1 FROM messages m WHERE m.interview_id = interviews.id AND m.role <> 'system') RETURNING " + INTERVIEW_COLS,
        interview_id,
        user.sub,
    )
    if row is None:
        await _raise_complete_error(interview_id, user.sub)
    interview = dict(row)

    await _auto_generate_and_persist_feedback(interview_id)

    return interview


@api.get("/interviews/{interview_id}/messages", response_model=list[Message])
async def list_messages(
    interview_id: str,
    user: CurrentUser,
) -> list[dict]:
    await _require_interview_owned(interview_id, user.sub)
    rows = await fetch(
        "SELECT id::text, interview_id::text, role, content, created_at FROM messages WHERE interview_id = $1 ORDER BY created_at",
        interview_id,
    )
    return [dict(r) for r in rows]


@api.get("/interviews/{interview_id}/feedback", response_model=Feedback)
async def get_feedback(
    interview_id: str,
    user: CurrentUser,
) -> dict:
    await _require_interview_owned(interview_id, user.sub)
    row = await fetchrow(
        "SELECT id::text, interview_id::text, scores, verdict, tips, decision, certainty, created_at FROM feedback WHERE interview_id = $1",
        interview_id,
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Feedback not found")
    return dict(row)


@api.post("/interviews/{interview_id}/feedback", response_model=Feedback, status_code=status.HTTP_201_CREATED)
async def create_feedback(
    interview_id: str,
    body: FeedbackCreate,
    user: CurrentUser,
) -> dict:
    await _require_interview_owned(interview_id, user.sub)
    row = await _upsert_feedback(interview_id, body.scores, body.verdict, body.tips, body.decision, body.certainty)
    return dict(row)


@api.post("/interviews/{interview_id}/feedback/generate", response_model=Feedback)
async def regenerate_feedback(
    interview_id: str,
    user: CurrentUser,
) -> dict:
    await _require_interview_owned(interview_id, user.sub)
    row = await fetchrow(
        "SELECT status FROM interviews WHERE id = $1 AND owner_id = $2",
        interview_id,
        user.sub,
    )
    if row is None or row["status"] != "completed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Interview is not completed")
    # Legacy dead end: completed before the /complete guard existed, so there is nothing the
    # model could ever grade. 409 (structural) beats a 503 the retry button can never clear.
    if not await _has_transcript(interview_id):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Nothing to score yet: this interview has no answers.")
    row = await _generate_and_persist_feedback(interview_id)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Scoring model could not produce feedback right now; try again later.",
        )
    return dict(row)


# --- usage ---


@api.get("/usage")
async def get_usage(user: CurrentUser) -> dict:
    """Cheap quota status: tier + the daily GLOBAL chat-turn dial (per owner, all interviews)."""
    tier = await billing.resolve_tier(user)
    chat = int(billing._quota(tier, "chat_turns"))
    used = await billing.chat_turns_used(user.sub)
    return {
        "tier": tier,
        f"chat_turns_per_day_{tier}": chat,
        "chat_turns_used_today": used,
        "chat_turns_remaining_today": max(0, chat - used),
    }


# --- billing (raw Stripe: checkout / portal / webhook) ---


@api.post("/billing/checkout")
async def billing_checkout(user: CurrentUser) -> dict:
    return {"url": payments.create_checkout_session(user)}


@api.post("/billing/portal", response_model=dict)
async def billing_portal(user: CurrentUser) -> dict:
    return {"url": await payments.create_portal_session(user)}


@api.post("/billing/webhook")
async def billing_webhook(request: Request) -> PlainTextResponse:
    import stripe

    payload = await request.body()
    sig = request.headers.get("stripe-signature", "")
    try:
        event = stripe.Webhook.construct_event(payload, sig, payments.STRIPE_WEBHOOK_SECRET)
    except (ValueError, stripe.SignatureVerificationError):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid signature") from None
    await payments.handle_webhook_event(event.to_dict())
    return PlainTextResponse("ok")


# --- SSE: interview chat streaming ---


@api.post("/interviews/{interview_id}/chat/stream")
async def chat_stream(
    interview_id: str,
    body: ChatTurn,
    user: CurrentUser,
) -> StreamingResponse:
    await _require_interview_owned(interview_id, user.sub)
    interview = await fetchrow(
        f"SELECT {INTERVIEW_COLS} FROM interviews WHERE id = $1 AND owner_id = $2",
        interview_id,
        user.sub,
    )
    if interview is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    if interview["status"] != "in_progress":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Interview is not in progress")

    prior_rows = await fetch(
        "SELECT role, content FROM messages WHERE interview_id = $1 ORDER BY created_at",
        interview_id,
    )
    # Interviewer turns already asked -> which phase of the arc this reply belongs to (chitchat
    # -> opener -> behavioural -> technical -> closing). Derived from the transcript, not stored.
    asked = sum(1 for r in prior_rows if r["role"] == "assistant")
    dials = Dials(**{k: interview[k] for k in DIAL_FIELDS})
    # The question mix is a real budget: once the arc is spent the interview is over, so refuse the
    # turn BEFORE spending a chat credit or a model call on it. The closing statement itself was
    # the previous turn (see llm.is_closing_turn); this is what makes it final.
    if llm.is_interview_finished(asked, dials):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This interview has asked all of its questions. Press Complete to get your feedback, or start a new interview with a wider question mix.",
        )

    tier = await billing.resolve_tier(user)
    if await billing.chat_turn_remaining(tier, user.sub) == 0:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail="Daily chat-turn credits reached. Try again after midnight UTC, or upgrade to premium.",
        )

    await billing.bump_chat_turn(user.sub)

    user_msg = await fetchrow(
        "INSERT INTO messages (interview_id, role, content) VALUES ($1, 'user', $2) RETURNING id::text",
        interview_id,
        body.content,
    )
    user_msg_id = user_msg["id"] if user_msg else None

    history = [
        ChatMessage(role="system", content=llm.system_prompt(interview["role"], interview["level"], interview["topic"], asked=asked, dials=dials)),
        *[ChatMessage(role=r["role"], content=r["content"]) for r in prior_rows],
        ChatMessage(role="user", content=body.content),
    ]

    async def _stream_events():
        # Closing turn: the interviewer's sign-off is canned, not sampled (see llm.CLOSING_MESSAGE).
        # Still streamed as one message event so the client needs no special case, and still
        # persisted, so the transcript ends the way it was displayed.
        if llm.is_closing_turn(asked, dials):
            await fetchrow(
                "INSERT INTO messages (interview_id, role, content) VALUES ($1, 'assistant', $2) RETURNING id",
                interview_id,
                llm.CLOSING_MESSAGE,
            )
            yield f"event: message\ndata: {llm.CLOSING_MESSAGE}\n\n"
            # Tells the client the run is over in the same frame it renders the sign-off.
            yield 'event: done\ndata: {"closing": true}\n\n'
            return

        collected: list[str] = []
        try:
            async for delta in llm.stream_chat(history):
                if delta:
                    collected.append(delta)
                    yield f"event: message\ndata: {delta}\n\n"
        except Exception as exc:
            if user_msg_id:
                await fetchrow(
                    "DELETE FROM messages WHERE id = $1 AND interview_id = $2",
                    user_msg_id,
                    interview_id,
                )
            yield f"event: error\ndata: {str(exc)}\n\n"
            return
        reply = "".join(collected).strip()
        await fetchrow(
            "INSERT INTO messages (interview_id, role, content) VALUES ($1, 'assistant', $2) RETURNING id",
            interview_id,
            reply,
        )
        yield "event: done\ndata: {}\n\n"

    return StreamingResponse(_stream_events(), media_type="text/event-stream")


async def _require_interview_owned(interview_id: str, owner_id: str) -> None:
    row = await fetchrow("SELECT 1 FROM interviews WHERE id = $1 AND owner_id = $2", interview_id, owner_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")


async def _has_transcript(interview_id: str) -> bool:
    """Any gradable turn? `system` rows are skipped by llm._format_transcript too, so an
    interview holding only system framing grades to an empty transcript -> 503 forever."""
    row = await fetchrow("SELECT 1 FROM messages WHERE interview_id = $1 AND role <> 'system' LIMIT 1", interview_id)
    return row is not None


async def _upsert_feedback(interview_id: str, scores: dict, verdict: str, tips: list, decision: str | None = None, certainty: int | None = None):
    # Single write path for feedback: idempotent UPSERT on the UNIQUE interview_id.
    return await fetchrow(
        "INSERT INTO feedback (interview_id, scores, verdict, tips, decision, certainty) VALUES ($1, $2, $3, $4, $5, $6) "
        "ON CONFLICT (interview_id) DO UPDATE SET scores = EXCLUDED.scores, verdict = EXCLUDED.verdict, tips = EXCLUDED.tips, "
        "decision = EXCLUDED.decision, certainty = EXCLUDED.certainty, created_at = now() "
        "RETURNING id::text, interview_id::text, scores, verdict, tips, decision, certainty, created_at",
        interview_id,
        scores,
        verdict,
        tips,
        decision,
        certainty,
    )


async def _auto_generate_and_persist_feedback(interview_id: str) -> dict | None:
    for attempt in range(COMPLETE_MAX_FEEDBACK_ATTEMPTS):
        row = await _generate_and_persist_feedback(interview_id)
        if row is not None:
            return row
        if attempt < COMPLETE_MAX_FEEDBACK_ATTEMPTS - 1:
            await _backoff_sleep(COMPLETE_FEEDBACK_BACKOFF_MS)
    return None


async def _generate_and_persist_feedback(interview_id: str) -> dict | None:
    history_rows = await fetch(
        "SELECT role, content FROM messages WHERE interview_id = $1 ORDER BY created_at",
        interview_id,
    )
    history = [ChatMessage(role=r["role"], content=r["content"]) for r in history_rows]
    # Dials come from the interview, not the caller: regenerate_feedback has no body to trust.
    row = await fetchrow(f"SELECT {', '.join(DIAL_FIELDS)} FROM interviews WHERE id = $1", interview_id)
    summary = await llm.generate_feedback(history, Dials(**{k: row[k] for k in DIAL_FIELDS}) if row else None)
    if summary is None:
        return None
    return await _upsert_feedback(interview_id, summary.scores, summary.verdict, summary.tips, summary.decision, summary.certainty)


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
    if row["status"] == "in_progress":
        # In progress but the UPDATE matched nothing => no gradable turns.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Nothing to score yet: send at least one message before completing.",
        )
    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Interview is not in progress")


app.include_router(api)
