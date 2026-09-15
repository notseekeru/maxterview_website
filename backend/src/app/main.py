import asyncio
import json
import os
from contextlib import asynccontextmanager
from typing import Annotated

import asyncpg
import structlog
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse

from app import API_PREFIX, billing, byok, llm, payments, rating
from app.auth import CLERK_ENABLED, get_current_user
from app.db import close_pool, fetch, fetchrow, init_pool
from app.models import ChatMessage, ChatTurn, ClerkUser, Dials, Feedback, FeedbackCreate, Interview, InterviewCreate, LLMProvider, LLMProviderUpdate, Message
from app.ratelimit import ClientRateLimitMiddleware

APP_ENV = os.getenv("APP_ENV", "development")
log = structlog.get_logger(__name__)


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


async def _llm_config(user: CurrentUser) -> llm.LLMConfig:
    """Per-request LLM target: the owner's BYOK provider when one is saved, else the system
    default. Nested on CurrentUser, so the JWT is still verified once per request."""
    return await byok.resolve_config(user)


LLMConfigDep = Annotated[llm.LLMConfig, Depends(_llm_config)]


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
DIAL_FIELDS = ("company_size", "cynicism", "brutally_honest", "human_mode", "hardcore", "mix_chitchat", "mix_behavioural", "mix_technical")

# Interview row columns for every SELECT/RETURNING that builds an `Interview`. Shared because
# `Interview` fills an absent field from its default, so a query that forgets a dial would answer
# 200 with a WRONG value ('neutral' for a run created skeptical) rather than an error.
INTERVIEW_COLS = "id::text, owner_id, role, level, topic, status, created_at, updated_at, failed_turn, failed_class, " + ", ".join(DIAL_FIELDS)


@api.get("/interviews", response_model=list[Interview])
async def list_interviews(user: CurrentUser) -> list[dict]:
    # Accuracy is the derived 0-100 move-review average, not recomputed here: the class -> points ->
    # grade scale lives only in app/rating.py, and `grade` is a computed field on the model.
    rows = await fetch(
        f"""
        SELECT i.id::text, i.owner_id, i.role, i.level, i.topic, i.status, i.created_at, i.updated_at,
               {", ".join(f"i.{c}" for c in DIAL_FIELDS)},
               i.failed_turn, i.failed_class,
               f.verdict AS verdict, f.decision AS decision, f.certainty AS certainty, f.accuracy AS accuracy
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
        INSERT INTO interviews (owner_id, role, level, topic, company_size, cynicism, brutally_honest, human_mode, hardcore, mix_chitchat, mix_behavioural, mix_technical)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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
        body.hardcore,
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
    config: LLMConfigDep,
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

    await _auto_generate_and_persist_feedback(interview_id, config)

    return interview


@api.get("/interviews/{interview_id}/messages", response_model=list[Message])
async def list_messages(
    interview_id: str,
    user: CurrentUser,
) -> list[dict]:
    await _require_interview_owned(interview_id, user.sub)
    rows = await fetch(
        "SELECT id::text, interview_id::text, role, content, move_class, created_at FROM messages WHERE interview_id = $1 ORDER BY created_at, id",
        interview_id,
    )
    return [dict(r) for r in rows]


async def _feedback_row(interview_id: str) -> asyncpg.Record | None:
    """The review as the API serves it: feedback joined to the interview, for the hardcore failure.

    Single read path for every feedback endpoint, because the failure lives on the interview row and
    an INSERT ... RETURNING cannot reach it.
    """
    return await fetchrow(
        "SELECT f.id::text, f.interview_id::text, f.scores, f.verdict, f.tips, f.decision, f.certainty, f.accuracy, i.failed_turn, i.failed_class, f.created_at FROM feedback f JOIN interviews i ON i.id = f.interview_id WHERE f.interview_id = $1",
        interview_id,
    )


@api.get("/interviews/{interview_id}/feedback", response_model=Feedback)
async def get_feedback(
    interview_id: str,
    user: CurrentUser,
) -> dict:
    await _require_interview_owned(interview_id, user.sub)
    row = await _feedback_row(interview_id)
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
    await _upsert_feedback(interview_id, body.scores, body.verdict, body.tips, body.decision, body.certainty)
    return dict(await _feedback_row(interview_id))


@api.post("/interviews/{interview_id}/feedback/generate", response_model=Feedback)
async def regenerate_feedback(
    interview_id: str,
    user: CurrentUser,
    config: LLMConfigDep,
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
    row = await _generate_and_persist_feedback(interview_id, config)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Scoring model could not produce feedback right now; try again later.",
        )
    return dict(row)


# --- usage ---


@api.get("/usage")
async def get_usage(user: CurrentUser, config: LLMConfigDep) -> dict:
    """Cheap quota status: tier + the daily GLOBAL chat-turn dial (per owner, all interviews)."""
    tier = await billing.resolve_tier(user)
    chat = int(billing._quota(tier, "chat_turns"))
    used = await billing.chat_turns_used(user.sub)
    return {
        "tier": tier,
        f"chat_turns_per_day_{tier}": chat,
        "chat_turns_used_today": used,
        "chat_turns_remaining_today": max(0, chat - used),
        # BYOK: the turns run on the owner's provider account, so the quota is not enforced
        # (see chat_stream) and the UI says so instead of showing a stale number.
        "byok": config.byok,
    }


# --- settings: BYOK LLM provider (app/byok.py, BYOK.md) ---


@api.get("/settings/llm", response_model=LLMProvider)
async def get_llm_provider(user: CurrentUser) -> dict:
    return await byok.public_view(user)


@api.put("/settings/llm", response_model=LLMProvider)
async def put_llm_provider(body: LLMProviderUpdate, user: CurrentUser) -> dict:
    """Save the owner's provider. 503 when the deployment has no BYOK_ENCRYPTION_KEY."""
    await byok.save(user.sub, body.base_url, body.model, body.api_key)
    return await byok.public_view(user)


@api.delete("/settings/llm", status_code=status.HTTP_204_NO_CONTENT)
async def delete_llm_provider(user: CurrentUser) -> None:
    """Forget the owner's provider entirely; every call reverts to the system default."""
    await byok.clear(user.sub)


@api.post("/settings/llm/test")
async def test_llm_provider(user: CurrentUser) -> dict:
    return await byok.test(user)


# --- billing (PayMongo subscriptions: subscribe / cancel / webhook) ---


@api.post("/billing/checkout")
async def billing_checkout(user: CurrentUser) -> dict:
    """Start the premium subscription; returns the Maya URL for the first payment."""
    return {"url": await payments.start_subscription(user)}


@api.post("/billing/cancel", response_model=dict)
async def billing_cancel(user: CurrentUser) -> dict:
    """Stop future billing. PayMongo has no billing portal, so this is our cancel path."""
    await payments.cancel_subscription(user)
    return {"ok": True}


@api.post("/billing/webhook")
async def billing_webhook(request: Request) -> PlainTextResponse:
    raw = await request.body()
    if not payments.verify_signature(raw, request.headers.get("paymongo-signature", "")):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid signature")
    await payments.handle_webhook_event(json.loads(raw))
    return PlainTextResponse("ok")


# `stripe listen` has no PayMongo equivalent, and requiring a tunnel for local webhooks is friction
# we do not want. Same guard shape as the no-Clerk fallback (D2): unreachable wherever the app
# boots with APP_ENV=production.
@api.post("/billing/webhook/simulate")
async def billing_webhook_simulate(event: dict) -> PlainTextResponse:
    if APP_ENV not in ("development", "test"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    await payments.handle_webhook_event(event)
    return PlainTextResponse("ok")


# --- SSE: interview chat streaming ---


@api.post("/interviews/{interview_id}/chat/stream")
async def chat_stream(
    interview_id: str,
    body: ChatTurn,
    user: CurrentUser,
    config: LLMConfigDep,
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
    # Hardcore runs end at the first wrong answer; the client stops the composer, and this is what
    # makes that final rather than a UI rule the next request could ignore.
    if interview["failed_turn"]:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This hardcore run is over: one wrong answer ended it. Press Complete for the feedback.")

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

    # BYOK pays the provider, not us, so the daily cap does not apply and no turn is metered
    # (see /usage). resolve_tier is skipped with it: nothing else in this path needs the tier.
    if not config.byok:
        tier = await billing.resolve_tier(user)
        if await billing.chat_turn_remaining(tier, user.sub) == 0:
            raise HTTPException(
                status_code=status.HTTP_402_PAYMENT_REQUIRED,
                detail="Daily chat-turn credits reached. Try again after midnight UTC, or upgrade to premium.",
            )

        await billing.bump_chat_turn(user.sub)

    # A trailing user turn means an earlier attempt died before its reply was written (killed worker,
    # client abort): this send is that turn's retry, so it REPLACES it. Doing it only here, past the
    # guards, keeps a refused turn (409/402) from deleting anything. The stale row is dropped from the
    # history too, or the model would see the same answer twice.
    if prior_rows and prior_rows[-1]["role"] == "user":
        await fetchrow(
            "DELETE FROM messages WHERE interview_id = $1 AND id = (SELECT id FROM messages WHERE interview_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1)",
            interview_id,
        )
        prior_rows = prior_rows[:-1]

    user_msg = await fetchrow(
        "INSERT INTO messages (interview_id, role, content) VALUES ($1, 'user', $2) RETURNING id::text",
        interview_id,
        body.content,
    )
    user_msg_id = user_msg["id"] if user_msg else None

    async def _discard_turn() -> None:
        """Delete the in-flight user turn; never raises.

        Runs on the failure path, including cancellation, where a raising rollback would mask the
        original error. Shielded because a cancelled task can be cancelled again mid-delete."""
        if not user_msg_id:
            return
        try:
            await asyncio.shield(fetchrow("DELETE FROM messages WHERE id = $1 AND interview_id = $2", user_msg_id, interview_id))
        except BaseException:
            log.warning("chat.turn_rollback_failed", interview_id=interview_id)

    history = [
        ChatMessage(role="system", content=llm.system_prompt(interview["role"], interview["level"], interview["topic"], asked=asked, dials=dials)),
        *[ChatMessage(role=r["role"], content=r["content"]) for r in prior_rows],
        ChatMessage(role="user", content=body.content),
    ]

    async def _stream_events():
        # Hardcore judges THIS answer before the interviewer replies, because a wrong answer ends the
        # run: spending a question on someone who is already out is the one thing the mode promises
        # never to do. Runs before the closing branch too - the last answer still counts.
        if dials.hardcore:
            turn = sum(1 for m in history if m.role == "user")
            question = next((m["content"] for m in reversed(prior_rows) if m["role"] == "assistant"), "")
            cls = await llm.judge_answer(question, body.content, config, turn)
            if cls:
                await fetchrow("UPDATE messages SET move_class = $2 WHERE id = $1", user_msg_id, cls)
            if cls in rating.FAIL_CLASSES:
                await fetchrow("UPDATE interviews SET failed_turn = $2, failed_class = $3, updated_at = now() WHERE id = $1", interview_id, turn, cls)
                shout = llm.FAIL_MESSAGE.format(cls=cls.upper())
                yield f"event: message\ndata: {shout}\n\n"
                # `failed` tells the client WHY the run ended (the arc being spent is the other ending).
                yield f'event: done\ndata: {{"closing": true, "failed": {{"turn": {turn}, "class": "{cls}"}}}}\n\n'
                return

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
            async for delta in llm.stream_chat(history, config):
                if delta:
                    collected.append(delta)
                    yield f"event: message\ndata: {delta}\n\n"
            reply = "".join(collected).strip()
            if not reply:
                raise RuntimeError("the model returned no reply")  # an empty bubble would read as answered
            await fetchrow(
                "INSERT INTO messages (interview_id, role, content) VALUES ($1, 'assistant', $2) RETURNING id",
                interview_id,
                reply,
            )
        except Exception as exc:
            # Model or DB failure while the turn is in flight: the user's row must not outlive it, or
            # the next send duplicates the answer (see the repair above).
            await _discard_turn()
            yield f"event: error\ndata: {str(exc)}\n\n"
            return
        except BaseException:
            # Client went away (CancelledError/GeneratorExit): same rollback, nobody left to notify.
            await _discard_turn()
            raise
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


async def _upsert_feedback(interview_id: str, scores: dict, verdict: str, tips: list, decision: str | None = None, certainty: int | None = None, accuracy: int | None = None) -> None:
    # Single write path: idempotent UPSERT on the UNIQUE interview_id. `accuracy` is COALESCEd, not
    # overwritten: it derives from the stored message classes, so a raw POST /feedback (no
    # classification behind it) must not wipe a grade an earlier pass earned. Callers re-read the row
    # through _feedback_row, which is the only query that can see the interview's hardcore failure.
    await fetchrow(
        "INSERT INTO feedback (interview_id, scores, verdict, tips, decision, certainty, accuracy) VALUES ($1, $2, $3, $4, $5, $6, $7) "
        "ON CONFLICT (interview_id) DO UPDATE SET scores = EXCLUDED.scores, verdict = EXCLUDED.verdict, tips = EXCLUDED.tips, "
        "decision = EXCLUDED.decision, certainty = EXCLUDED.certainty, accuracy = COALESCE(EXCLUDED.accuracy, feedback.accuracy), created_at = now()",
        interview_id,
        scores,
        verdict,
        tips,
        decision,
        certainty,
        accuracy,
    )


async def _persist_move_classes(interview_id: str, candidate_ids: list[str], moves: dict[int, str]) -> list[str]:
    """Write the classifier's classes onto their message rows; return the classes stored.

    `moves` keys are 1-based candidate turn numbers indexing `candidate_ids` (llm._format_transcript
    numbers the same turns off the same query). One statement writes every candidate row, NULLing the
    turns this pass did not class, so a re-grade cannot leave a stale badge behind. An empty `moves`
    (classifier failed) is a no-op: the previous annotations and accuracy stay put."""
    graded = {turn: cls for turn, cls in moves.items() if isinstance(turn, int) and 1 <= turn <= len(candidate_ids)}
    if not graded:
        return []
    await fetch(
        "UPDATE messages SET move_class = u.move_class FROM unnest($2::text[], $3::text[]) AS u(id, move_class) WHERE messages.id = u.id::uuid AND messages.interview_id = $1 RETURNING messages.id",
        interview_id,
        candidate_ids,
        [graded.get(turn) for turn in range(1, len(candidate_ids) + 1)],
    )
    return list(graded.values())


async def _auto_generate_and_persist_feedback(interview_id: str, config: llm.LLMConfig) -> dict | None:
    for attempt in range(COMPLETE_MAX_FEEDBACK_ATTEMPTS):
        row = await _generate_and_persist_feedback(interview_id, config)
        if row is not None:
            return row
        if attempt < COMPLETE_MAX_FEEDBACK_ATTEMPTS - 1:
            await _backoff_sleep(COMPLETE_FEEDBACK_BACKOFF_MS)
    return None


async def _generate_and_persist_feedback(interview_id: str, config: llm.LLMConfig) -> dict | None:
    # `id` is selected for the move-review mapping and `move_class` for the hardcore path; the
    # `, id` tiebreak keeps the order stable, since llm numbers candidate turns off this exact list.
    history_rows = await fetch(
        "SELECT id::text, role, content, move_class FROM messages WHERE interview_id = $1 ORDER BY created_at, id",
        interview_id,
    )
    history = [ChatMessage(role=r["role"], content=r["content"]) for r in history_rows]
    # Dials come from the interview, not the caller: regenerate_feedback has no body to trust.
    row = await fetchrow(f"SELECT {', '.join(DIAL_FIELDS)}, failed_turn, failed_class FROM interviews WHERE id = $1", interview_id)
    dials = Dials(**{k: row[k] for k in DIAL_FIELDS}) if row else None
    failure = (row["failed_turn"], row["failed_class"]) if row and row["failed_turn"] else None
    # A hardcore run was already judged turn by turn as it was answered (chat_stream), so its
    # annotation pass would only re-litigate verdicts the candidate was told about.
    hardcore = bool(dials and dials.hardcore)
    summary = await llm.generate_feedback(history, dials, config, failure=failure, annotate=not hardcore)
    if summary is None:
        return None
    classes = [r["move_class"] for r in history_rows if r["role"] == "user"] if hardcore else await _persist_move_classes(interview_id, [r["id"] for r in history_rows if r["role"] == "user"], summary.moves)
    accuracy = rating.accuracy(classes)
    # Safety net: hardcore, no failure recorded (the live judge came back empty on some turn), and this
    # transcript does contain one. Record it, or the review would show F with nothing to shout about.
    if hardcore and failure is None:
        wrong = next(((turn, cls) for turn, cls in enumerate(classes, start=1) if cls in rating.FAIL_CLASSES), None)
        if wrong:
            await fetchrow("UPDATE interviews SET failed_turn = $2, failed_class = $3 WHERE id = $1", interview_id, wrong[0], wrong[1])
    # Accuracy averages what was STORED, not the model's payload: a turn the writer dropped must not
    # count towards the score it never earned.
    await _upsert_feedback(interview_id, summary.scores, summary.verdict, summary.tips, summary.decision, summary.certainty, accuracy)
    return dict(await _feedback_row(interview_id))


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
