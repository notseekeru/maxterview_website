import asyncio
import json
import os
import time
from collections import Counter
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager, suppress
from datetime import datetime
from statistics import fmean, median
from typing import Annotated

import asyncpg
import structlog
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Request, Response, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse
from pydantic import ValidationError

from app import API_PREFIX, billing, byok, dials, latex, levels, llm, offer, payments, rating, resumes, review, telemetry, voice
from app.auth import CLERK_ENABLED, get_current_user
from app.db import close_pool, fetch, fetchrow, init_pool
from app.dials import DIAL_FIELDS
from app.logs import RequestContextMiddleware, configure_logging
from app.models import (
    HIRING_DECISIONS,
    Analytics,
    ChatMessage,
    ChatTurn,
    ClerkUser,
    ClientError,
    DashboardDims,
    Dials,
    Feedback,
    FeedbackCreate,
    Interview,
    InterviewCreate,
    InterviewTemplate,
    LatexSource,
    LLMProvider,
    LLMProviderUpdate,
    Message,
    Offer,
    Resume,
    ResumeCreate,
    ResumeExtract,
    ResumeReview,
    ResumeSummary,
    ReviewRewriteRequest,
    TemplateCreate,
    VoiceCapability,
    VoiceText,
    VoiceTranscript,
)
from app.ratelimit import ClientRateLimitMiddleware

APP_ENV = os.getenv("APP_ENV", "development")
log = structlog.get_logger(__name__)


# Empty by default: the SPA is same-origin through the `/api` proxy. Never `*`.
def cors_origins(raw: str) -> list[str]:
    return [o.strip() for o in raw.split(",") if o.strip()]


CORS_ALLOW_ORIGINS = cors_origins(os.getenv("CORS_ALLOW_ORIGINS", ""))

COMPLETE_MAX_FEEDBACK_ATTEMPTS = 3
COMPLETE_FEEDBACK_BACKOFF_MS = 800


async def _backoff_sleep(ms: int) -> None:
    await asyncio.sleep(ms / 1000)


if not CLERK_ENABLED and APP_ENV not in ("development", "test"):
    raise RuntimeError("CLERK_ENABLED=false is only allowed when APP_ENV is development or test; refusing to boot.")

CurrentUser = Annotated[ClerkUser, Depends(get_current_user)]


async def _llm_config(user: CurrentUser) -> llm.LLMConfig:
    return await byok.resolve_config(user)


LLMConfigDep = Annotated[llm.LLMConfig, Depends(_llm_config)]


async def _user_tier(user: CurrentUser) -> str:
    return await billing.resolve_tier(user)


TierDep = Annotated[str, Depends(_user_tier)]


async def _chat_config(config: LLMConfigDep, tier: TierDep) -> llm.LLMConfig:
    if config.byok or llm.PRO_CONFIG is None:
        return config
    return llm.PRO_CONFIG if tier == "premium" else config


ChatLLMDep = Annotated[llm.LLMConfig, Depends(_chat_config)]


@asynccontextmanager
async def lifespan(_app: FastAPI):
    telemetry.configure()
    beat = asyncio.create_task(telemetry.heartbeat()) if telemetry.enabled() else None
    await init_pool()
    yield
    if beat is not None:
        beat.cancel()
        with suppress(asyncio.CancelledError):
            await beat
    await voice.aclose()
    await close_pool()
    telemetry.shutdown()


# Before anything can log: one chain for structlog and stdlib (uvicorn, unhandled tracebacks) alike.
configure_logging()

app = FastAPI(title="maxterview", lifespan=lifespan)

# AI HERE: /api is owned here (matches diagram), not by the dev proxy or the ingress: every layer
# passes the path through unchanged. Upgrade path: per-router prefixes if an admin/internal split lands.
api = APIRouter(prefix=API_PREFIX)

# Added first => innermost, so CORS stays outermost and its headers are still on a 429.
app.add_middleware(ClientRateLimitMiddleware)
if CORS_ALLOW_ORIGINS:
    app.add_middleware(CORSMiddleware, allow_origins=CORS_ALLOW_ORIGINS, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

# Added last => outermost: it sees the 429s and CORS rejections the inner layers return.
app.add_middleware(RequestContextMiddleware)

CLIENT_ERROR_MAX_BYTES = 4096


@api.get("/health")
async def health() -> dict:
    # No DB call: CD smoke runs with a dummy DATABASE_URL and no Postgres.
    # `up` is the field the Grafana uptime rule reads (bootstrap.py --probe-url); `status` is what
    # scripts/llm-smoke.py asserts. Dropping either one costs a rule or a check.
    return {"status": "ok", "up": 1}


@api.post("/client-errors", status_code=status.HTTP_204_NO_CONTENT)
async def client_errors(request: Request) -> Response:
    # AI HERE: a chunked request with no Content-Length still reaches the
    # parser: the ingress `proxy-body-size` is the outer bound until a global limit exists.
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > CLIENT_ERROR_MAX_BYTES:
        raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail="Not a browser error report")
    try:
        body = ClientError.model_validate_json(await request.body())
    except ValidationError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Not a browser error report") from exc
    log.info("browser.error", message=body.message, route=body.route, component_stack=body.component_stack)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# Shared: a query that forgets a dial returns the field's default, so the row is silently wrong
# rather than an error.
INTERVIEW_COLS = "id::text, owner_id, role, level, topic, resume_id::text, status, created_at, updated_at, failed_turn, failed_class, archived_at, " + ", ".join(DIAL_FIELDS)


@api.get("/interviews", response_model=list[Interview])
async def list_interviews(
    user: CurrentUser,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    archived: bool | None = None,
) -> list[dict]:
    # Accuracy is the derived 0-100 move-review average, not recomputed here: the class -> points ->
    # grade scale lives only in app/rating.py, and `grade` is a computed field on the model.
    rows = await fetch(
        f"""
        SELECT i.id::text, i.owner_id, i.role, i.level, i.topic, i.resume_id::text, i.status, i.created_at, i.updated_at,
               {", ".join(f"i.{c}" for c in DIAL_FIELDS)},
               i.failed_turn, i.failed_class, i.archived_at,
               f.verdict AS verdict, f.decision AS decision, f.certainty AS certainty, f.accuracy AS accuracy
        FROM interviews i
        LEFT JOIN feedback f ON f.interview_id = i.id
        WHERE i.owner_id = $1
          AND ($2::bool IS NULL OR (i.archived_at IS NOT NULL) = $2)
        ORDER BY i.created_at DESC
        LIMIT $3 OFFSET $4
        """,
        user.sub,
        archived,
        limit,
        offset,
    )
    return [dict(r) for r in rows]


@api.post("/interviews", response_model=Interview, status_code=status.HTTP_201_CREATED)
async def create_interview(
    body: InterviewCreate,
    user: CurrentUser,
) -> dict:
    # A None row here means a foreign or deleted id; this path has no cap to confuse it with.
    row = await fetchrow(
        f"""
        INSERT INTO interviews (owner_id, role, level, topic, resume_id, {", ".join(DIAL_FIELDS)})
        SELECT $1, $2, $3, $4, $5::uuid, {", ".join(f"${i}" for i in range(6, 6 + len(DIAL_FIELDS)))}
        WHERE $5::uuid IS NULL OR EXISTS (SELECT 1 FROM resumes WHERE id = $5::uuid AND owner_id = $1)
        RETURNING """
        + INTERVIEW_COLS,
        user.sub,
        body.role,
        body.level,
        body.topic,
        str(body.resume_id) if body.resume_id else None,
        *[getattr(body, f) for f in DIAL_FIELDS],
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Resume not found")
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


async def _set_archived(interview_id: str, owner_id: str, archived: bool) -> dict:
    row = await fetchrow(
        f"UPDATE interviews SET archived_at = CASE WHEN $3 THEN now() ELSE NULL END WHERE id = $1 AND owner_id = $2 RETURNING {INTERVIEW_COLS}",
        interview_id,
        owner_id,
        archived,
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    return dict(row)


@api.post("/interviews/{interview_id}/archive", response_model=Interview)
async def archive_interview(
    interview_id: str,
    user: CurrentUser,
) -> dict:
    return await _set_archived(interview_id, user.sub, True)


@api.delete("/interviews/{interview_id}/archive", response_model=Interview)
async def unarchive_interview(
    interview_id: str,
    user: CurrentUser,
) -> dict:
    return await _set_archived(interview_id, user.sub, False)


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


@api.post("/interviews/{interview_id}/finish", response_model=Interview)
async def finish_interview(
    interview_id: str,
    user: CurrentUser,
    config: LLMConfigDep,
) -> dict:
    # trip. The row must be a CANDIDATE one, since the generated opener is an assistant row.
    row = await fetchrow(
        "UPDATE interviews SET status = 'completed', updated_at = now() WHERE id = $1 AND owner_id = $2 AND status = 'in_progress' AND EXISTS (SELECT 1 FROM messages m WHERE m.interview_id = interviews.id AND m.role = 'user') RETURNING " + INTERVIEW_COLS,
        interview_id,
        user.sub,
    )
    if row is None:
        await _raise_finish_error(interview_id, user.sub)
    interview = dict(row)

    await _auto_generate_and_persist_feedback(interview_id, config)

    return interview


@api.get("/interviews/{interview_id}/messages", response_model=list[Message])
async def list_messages(
    interview_id: str,
    user: CurrentUser,
) -> list[dict]:
    rows = await fetch(
        """
        SELECT m.id::text, m.interview_id::text, m.role, m.content, m.move_class, m.comment, m.created_at
        FROM interviews i
        LEFT JOIN messages m ON m.interview_id = i.id
        WHERE i.id = $1 AND i.owner_id = $2
        ORDER BY m.created_at, m.id
        """,
        interview_id,
        user.sub,
    )
    if not rows:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    return [dict(r) for r in rows if r["id"] is not None]


FEEDBACK_COLS = "f.id::text, f.interview_id::text, f.scores, f.verdict, f.tips, f.decision, f.certainty, f.accuracy, f.redos, i.failed_turn, i.failed_class, f.created_at"


async def _feedback_row(interview_id: str) -> asyncpg.Record | None:
    return await fetchrow(
        f"SELECT {FEEDBACK_COLS} FROM feedback f JOIN interviews i ON i.id = f.interview_id WHERE f.interview_id = $1",
        interview_id,
    )


@api.get("/interviews/{interview_id}/feedback", response_model=Feedback)
async def get_feedback(
    interview_id: str,
    user: CurrentUser,
) -> dict:
    row = await fetchrow(
        f"SELECT {FEEDBACK_COLS} FROM interviews i LEFT JOIN feedback f ON f.interview_id = i.id WHERE i.id = $1 AND i.owner_id = $2",
        interview_id,
        user.sub,
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    if row["id"] is None:
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
    await _sync_offer(interview_id)
    return dict(await _feedback_row(interview_id))


@api.post("/interviews/{interview_id}/feedback/generate", response_model=Feedback)
async def regenerate_feedback(
    interview_id: str,
    user: CurrentUser,
    config: LLMConfigDep,
) -> dict:
    row = await fetchrow(
        """
        SELECT i.status, f.redos,
               EXISTS (SELECT 1 FROM messages m WHERE m.interview_id = i.id AND m.role = 'user') AS has_transcript
        FROM interviews i
        LEFT JOIN feedback f ON f.interview_id = i.id
        WHERE i.id = $1 AND i.owner_id = $2
        """,
        interview_id,
        user.sub,
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    if row["status"] != "completed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Interview is not completed")
    if not row["has_transcript"]:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Nothing to score yet: this interview has no answers.")
    # Redo allowance, per run. A run that never got a review reads as zero spent, so the repair path
    # stays open to an owner who has nothing to lose.
    tier = await billing.resolve_tier(user)
    limit = billing.redo_limit(tier)
    if (row["redos"] or 0) >= limit:
        spent = f"This run has used all {limit} of its review redos."
        upsell = tier == "free"
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED if upsell else status.HTTP_409_CONFLICT,
            detail=f"{spent} Pro raises that limit." if upsell else spent,
        )
    row = await _generate_and_persist_feedback(interview_id, config)
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Scoring model could not produce feedback right now; try again later.",
        )
    await fetchrow("UPDATE feedback SET redos = redos + 1 WHERE interview_id = $1", interview_id)
    return dict(await _feedback_row(interview_id))


TEMPLATE_CAP = 20

TEMPLATE_COLS = "id::text, owner_id, name, role, level, topic, resume_id::text, created_at, updated_at, " + ", ".join(DIAL_FIELDS)

# Two bases because the two statements share no prefix. Generated rather than hand-counted: a hole in
# the numbering passes Postgres and fails at bind ("could not determine data type of parameter $n").
TEMPLATE_CREATE_DIAL_PARAM = 7
TEMPLATE_UPDATE_DIAL_PARAM = 8

DEFAULT_TEMPLATES: tuple[TemplateCreate, ...] = (
    TemplateCreate(name="Killer", role="Software Engineer", company_size="5k+", cynicism="skeptical", brutally_honest=True, human_mode=False, hardcore=True, depth="screen"),
    TemplateCreate(name="Griller", role="Software Engineer", company_size="201-1k", cynicism="skeptical", brutally_honest=True),
    TemplateCreate(name="Chiller", role="Software Engineer", company_size="1-10", cynicism="kind", depth="screen"),
)
# Rows as plain dicts: the asyncpg jsonb codec encodes them (a pre-dumped STRING would arrive as a
# JSON scalar, and jsonb_to_recordset would refuse it).
DEFAULT_TEMPLATES_ROWS = [t.model_dump(mode="json") for t in DEFAULT_TEMPLATES]

# Idempotent: the marker insert returns a row only the first time, so a deleted default stays deleted.
# Three rows arrive as ONE jsonb parameter; a VALUES list would need hand-counted placeholders.
# created_at is staggered off `ordinality`, or all three share one timestamp and return in any order.
SEED_DEFAULTS_SQL = f"""
        WITH seed AS (
            INSERT INTO template_seeds (owner_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING owner_id
        ), added AS (
            INSERT INTO interview_templates (owner_id, name, role, level, topic, resume_id, {", ".join(DIAL_FIELDS)}, created_at)
            SELECT $1, d.name, d.role, d.level, d.topic, d.resume_id, {", ".join(f"d.{f}" for f in DIAL_FIELDS)}, now() - (d.ordinality * interval '1 microsecond')
            FROM seed, ROWS FROM (jsonb_to_recordset($2::jsonb) AS (name text, role text, level text, topic text, resume_id uuid, company_size text, cynicism text, brutally_honest boolean, human_mode boolean, hardcore boolean, depth text)) WITH ORDINALITY AS d
            RETURNING {TEMPLATE_COLS}
        )
        SELECT * FROM added ORDER BY created_at DESC
        """


TEMPLATE_LIST_SQL = f"SELECT {TEMPLATE_COLS} FROM interview_templates WHERE owner_id = $1 ORDER BY created_at DESC"


@api.get("/templates", response_model=list[InterviewTemplate])
async def list_templates(user: CurrentUser) -> list[dict]:
    # AI HERE: a brand-new owner seeds on the first read. Seeding at owner creation needs a user row
    # and Clerk owns identity, so the first-request hook is the upgrade.
    rows = await fetch(TEMPLATE_LIST_SQL, user.sub)
    if not rows:
        rows = await fetch(SEED_DEFAULTS_SQL, user.sub, DEFAULT_TEMPLATES_ROWS) or await fetch(TEMPLATE_LIST_SQL, user.sub)
    return [dict(r) for r in rows]


@api.post("/templates", response_model=InterviewTemplate, status_code=status.HTTP_201_CREATED)
async def create_template(
    body: TemplateCreate,
    user: CurrentUser,
) -> dict:
    # Cap and resume ownership checked inside the INSERT: one round trip, no pre-count race. The caller
    # cannot tell which failed, so the message names the cap.
    row = await fetchrow(
        f"""
        INSERT INTO interview_templates (owner_id, name, role, level, topic, resume_id, {", ".join(DIAL_FIELDS)})
        SELECT $1, $2, $3, $4, $5, $6::uuid, {", ".join(f"${i}" for i in range(TEMPLATE_CREATE_DIAL_PARAM, TEMPLATE_CREATE_DIAL_PARAM + len(DIAL_FIELDS)))}
        WHERE (SELECT count(*) FROM interview_templates WHERE owner_id = $1) < {TEMPLATE_CAP}
          AND ($6::uuid IS NULL OR EXISTS (SELECT 1 FROM resumes WHERE id = $6::uuid AND owner_id = $1))
        RETURNING {TEMPLATE_COLS}
        """,
        user.sub,
        body.name,
        body.role,
        body.level,
        body.topic,
        str(body.resume_id) if body.resume_id else None,
        *[getattr(body, f) for f in DIAL_FIELDS],
    )
    if row is None:
        # Distinguish the two no-row causes: a foreign resume is a 404, the cap is a 409.
        if body.resume_id and not await fetchrow("SELECT 1 FROM resumes WHERE id = $1 AND owner_id = $2", str(body.resume_id), user.sub):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Resume not found")
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"Template limit reached ({TEMPLATE_CAP}); delete one to save another.")
    return dict(row)


@api.put("/templates/{template_id}", response_model=InterviewTemplate)
async def update_template(
    template_id: str,
    body: TemplateCreate,
    user: CurrentUser,
) -> dict:
    assignments = ", ".join(f"{f} = ${i}" for i, f in enumerate(DIAL_FIELDS, start=TEMPLATE_UPDATE_DIAL_PARAM))
    row = await fetchrow(
        f"UPDATE interview_templates SET name = $3, role = $4, level = $5, topic = $6, resume_id = $7::uuid, {assignments}, updated_at = now() WHERE id = $1 AND owner_id = $2 AND ($7::uuid IS NULL OR EXISTS (SELECT 1 FROM resumes WHERE id = $7::uuid AND owner_id = $2)) RETURNING {TEMPLATE_COLS}",
        template_id,
        user.sub,
        body.name,
        body.role,
        body.level,
        body.topic,
        str(body.resume_id) if body.resume_id else None,
        *[getattr(body, f) for f in DIAL_FIELDS],
    )
    if row is None:
        if body.resume_id and not await fetchrow("SELECT 1 FROM resumes WHERE id = $1 AND owner_id = $2", str(body.resume_id), user.sub):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Resume not found")
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Template not found")
    return dict(row)


@api.delete("/templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_template(
    template_id: str,
    user: CurrentUser,
) -> None:
    row = await fetchrow(
        "DELETE FROM interview_templates WHERE id = $1 AND owner_id = $2 RETURNING id",
        template_id,
        user.sub,
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Template not found")


# Resumes: an interview or preset holds `resume_id`, nothing else references one.

# No `text` in the list projection: per-row fan-out is what the rate-budget guardrail bans.
# `chars` is computed, so no stored length to keep in step with an edit.
RESUME_COLS = "id::text, owner_id, name, page_count, created_at, updated_at, length(text) AS chars"
RESUME_COLS_WITH_TEXT = RESUME_COLS + ", text"


def _resume_name(raw: str | None, fallback: str = "Untitled resume") -> str:
    stem = (raw or "").replace("\\", "/").rsplit("/", 1)[-1]
    if stem.lower().endswith(".pdf"):
        stem = stem[:-4]
    return resumes.sanitize(stem, 80).strip() or fallback


def _resume_body(text: str) -> str:
    body = resumes.sanitize(text, resumes.MAX_CHARS)
    if not body:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="There is no text to save. Paste some, or upload a PDF with selectable text.")
    return body


def _resume_cap_error(tier: str, cap: int) -> HTTPException:
    if tier == "free":
        return HTTPException(status_code=status.HTTP_402_PAYMENT_REQUIRED, detail=f"The free plan includes {cap} resume. Delete it to import another, or upgrade to Pro for {billing.PREMIUM_RESUMES}.")
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"You already have {cap} resumes, the maximum. Delete one to import another.")


async def _insert_resume(owner_id: str, tier: str, name: str, text: str, page_count: int = 0) -> dict:
    cap = billing.resume_limit(tier)
    row = await fetchrow(
        f"""
        INSERT INTO resumes (owner_id, name, text, page_count)
        SELECT $1, $2, $3, $4
        WHERE (SELECT count(*) FROM resumes WHERE owner_id = $1) < $5
        RETURNING {RESUME_COLS_WITH_TEXT}
        """,
        owner_id,
        _resume_name(name),
        _resume_body(text),
        page_count,
        cap,
    )
    if row is None:
        raise _resume_cap_error(tier, cap)
    return dict(row)


@api.get("/resumes", response_model=list[ResumeSummary])
async def list_resumes(user: CurrentUser) -> list[dict]:
    rows = await fetch(f"SELECT {RESUME_COLS} FROM resumes WHERE owner_id = $1 ORDER BY created_at DESC", user.sub)
    return [dict(r) for r in rows]


@api.get("/resumes/{resume_id}", response_model=Resume)
async def get_resume(
    resume_id: str,
    user: CurrentUser,
) -> dict:
    row = await fetchrow(f"SELECT {RESUME_COLS_WITH_TEXT} FROM resumes WHERE id = $1 AND owner_id = $2", resume_id, user.sub)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Resume not found")
    return dict(row)


@api.post("/resumes/extract", response_model=ResumeExtract)
async def extract_resume(file: UploadFile, user: CurrentUser) -> ResumeExtract:
    data = await file.read(resumes.MAX_BYTES + 1)
    if len(data) > resumes.MAX_BYTES:
        raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail=f"That file is larger than {resumes.MAX_BYTES // (1024 * 1024)} MB. Trim it down, or paste the text instead.")
    try:
        got = await resumes.extract_pdf(data)
    except resumes.ExtractError as exc:
        # The message is written for the user by app/resumes.py; pypdf's own messages are
        # attacker-controlled and never reach a response body.
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)) from exc
    return ResumeExtract(text=got.text, pages=got.pages, truncated=got.truncated)


@api.post("/resumes", response_model=Resume, status_code=status.HTTP_201_CREATED)
async def create_resume(body: ResumeCreate, user: CurrentUser) -> dict:
    return await _insert_resume(user.sub, await billing.resolve_tier(user), body.name, body.text)


@api.put("/resumes/{resume_id}", response_model=Resume)
async def update_resume(
    resume_id: str,
    body: ResumeCreate,
    user: CurrentUser,
) -> dict:
    row = await fetchrow(
        f"UPDATE resumes SET name = $3, text = $4, updated_at = now() WHERE id = $1 AND owner_id = $2 RETURNING {RESUME_COLS_WITH_TEXT}",
        resume_id,
        user.sub,
        _resume_name(body.name),
        _resume_body(body.text),
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Resume not found")
    return dict(row)


@api.delete("/resumes/{resume_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_resume(
    resume_id: str,
    user: CurrentUser,
) -> None:
    # Interviews and presets attached to it keep their rows: the FK is ON DELETE SET NULL, so a run
    # keeps its transcript and merely stops being tailored to a resume that no longer exists.
    row = await fetchrow("DELETE FROM resumes WHERE id = $1 AND owner_id = $2 RETURNING id", resume_id, user.sub)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Resume not found")


# A review is derived from one column of a resume, so it dies with the resume (CASCADE). An edit does
# NOT retire it: the review is what the candidate paid a turn for, so it stays on the page marked stale
# and the next review replaces it. sha256 runs in Postgres: the alternative is pulling 60k chars over the
# wire to hash them here.
@api.get("/resumes/{resume_id}/review", response_model=ResumeReview | None)
async def get_resume_review(
    resume_id: str,
    user: CurrentUser,
) -> dict | None:
    row = await fetchrow(
        """
        SELECT rr.review, rr.created_at,
               rr.source_hash = encode(sha256(convert_to(r.text, 'UTF8')), 'hex') AS fresh
        FROM resume_reviews rr JOIN resumes r ON r.id = rr.resume_id
        WHERE rr.resume_id = $1 AND r.owner_id = $2
        """,
        resume_id,
        user.sub,
    )
    return {**row["review"], "created_at": row["created_at"], "stale": not row["fresh"]} if row else None


@api.post("/resumes/{resume_id}/review", response_model=ResumeReview, status_code=status.HTTP_201_CREATED)
async def create_resume_review(
    resume_id: str,
    user: CurrentUser,
    config: ChatLLMDep,
    tier: TierDep,
) -> dict:
    row = await fetchrow("SELECT text FROM resumes WHERE id = $1 AND owner_id = $2", resume_id, user.sub)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Resume not found")
    if config.stub:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="No scoring engine is configured on this deployment, so a review cannot run.")
    # One chat turn, charged before the call like every other turn: a provider timeout is the price of
    # asking, and a free retry loop is not what the daily cap is for.
    await _spend_chat_turn(user, config, tier)
    got = await llm.review_resume(row["text"], config)
    if got is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="The reviewer could not read this resume right now. Try again in a moment.")
    saved = await fetchrow(
        "INSERT INTO resume_reviews (resume_id, source_hash, review) VALUES ($1, $2, $3) ON CONFLICT (resume_id) DO UPDATE SET source_hash = EXCLUDED.source_hash, review = EXCLUDED.review, created_at = now() RETURNING review, created_at",
        resume_id,
        review.source_hash(row["text"]),
        got,
    )
    return {**saved["review"], "created_at": saved["created_at"]}


@api.post("/resumes/{resume_id}/review/rewrite", response_model=ResumeReview)
async def retry_resume_rewrite(
    resume_id: str,
    body: ReviewRewriteRequest,
    user: CurrentUser,
    config: ChatLLMDep,
    tier: TierDep,
) -> dict:
    row = await fetchrow(
        """
        SELECT r.text, rr.review
        FROM resumes r
        LEFT JOIN resume_reviews rr ON rr.resume_id = r.id AND rr.source_hash = encode(sha256(convert_to(r.text, 'UTF8')), 'hex')
        WHERE r.id = $1 AND r.owner_id = $2
        """,
        resume_id,
        user.sub,
    )
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Resume not found")
    # The client returns a line the reviewer quoted from this page. One it cannot find is either stale or
    # forged, and either way it is not a line of this resume.
    source = review.claim(body.source, review.LINE_MAX)
    flat = " ".join(row["text"].split())
    if not source or (source not in row["text"] and " ".join(source.split()) not in flat):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="That line is not on this resume any more. Re-review it and try again.")
    current = row["review"]
    if current is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Review this resume first: there is no edit to retry.")
    if config.stub:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="No scoring engine is configured on this deployment, so an edit cannot be retried.")
    await _spend_chat_turn(user, config, tier)
    got = await llm.rewrite_line(row["text"], source, config)
    if got is None:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="The reviewer could not write a different line right now. Try again in a moment.")
    stored = dict(current)
    rewrites = [item for item in stored.get("rewrites", []) if item.get("source") != source]
    stored["rewrites"] = ([{"source": source, "rewrite": got}] + rewrites)[: review.MAX_REWRITES]
    saved = await fetchrow(
        "UPDATE resume_reviews SET review = $2 WHERE resume_id = $1 RETURNING review, created_at",
        resume_id,
        stored,
    )
    return {**saved["review"], "created_at": saved["created_at"]}


# The LaTeX preview compiles the text in the request, not the stored row: an editor has to render the
# edit the candidate is typing. Ownership is the only thing this needs from the database.


@api.post("/resumes/preview")
async def compile_resume(body: LatexSource, user: CurrentUser) -> Response:
    if "\\documentclass" not in body.text:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="That is not a LaTeX document: it needs a \\documentclass line.")
    if not latex.available():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="No LaTeX engine is installed on this deployment.")
    try:
        pdf = await latex.compile_pdf(body.text)
    except latex.CompileBusy as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="The preview is busy. Try again in a moment.", headers={"Retry-After": "5"}) from exc
    except latex.CompileError as exc:
        # The compiler's own first error, which carries the line number the editor points at.
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=exc.detail) from exc
    return Response(content=pdf, media_type="application/pdf", headers={"Cache-Control": "no-store"})


# Voice: Workers AI is the only engine, and it is optional infrastructure.


@api.get("/voice", response_model=VoiceCapability)
async def voice_capability(user: CurrentUser) -> dict:
    return voice.capability()


@api.post("/voice/tts")
async def voice_tts(body: VoiceText, user: CurrentUser) -> Response:
    try:
        speech = await voice.speak(body.text)
    except voice.VoiceError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    return Response(content=speech.audio, media_type=speech.media_type, headers={"Cache-Control": "no-store"})


@api.post("/voice/stt", response_model=VoiceTranscript)
async def voice_stt(file: UploadFile, user: CurrentUser) -> VoiceTranscript:
    data = await file.read(voice.MAX_UPLOAD_BYTES + 1)
    if len(data) > voice.MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail=f"That recording is larger than {voice.MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")
    try:
        got = await voice.transcribe(data)
    except voice.VoiceError as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    return VoiceTranscript(text=got.text, segments=got.segments, language=got.language)


# Dashboard stats: aggregates, not per-row reads.

# The radar's second series spans the newest rated runs: one run's per-dim holes are noise.
RECENT_WINDOW = 5
TREND_DOTS = 20
SPARK_DAYS = 14
DELTA_WINDOW = 5


# Analytics: the same one-aggregate rule as the dashboard above.

# No archived filter: an offer was issued, and hiding the run from the history list does not un-issue it.
OFFER_COLS = """
o.interview_id::text, o.title, o.band, o.base_salary, o.signing_bonus, o.equity, o.performance,
       o.benefits, o.created_at, i.role, i.level, i.failed_class, f.accuracy, f.decision"""

# The hiring end of models.DECISIONS, rendered into SQL from the one tuple that defines it, so the
# hire-rate column and the offer gate in _sync_offer cannot disagree about what a hire is.
HIRING_SQL = ", ".join(f"'{d}'" for d in HIRING_DECISIONS)

# Consecutive UTC days counting back from today. Today and yesterday both count, so a streak does not
# read 0 for the whole of a day the candidate is still practising in.
ANALYTICS_STREAK_SQL = """
WITH days AS (
    SELECT DISTINCT (created_at AT TIME ZONE 'UTC')::date AS d FROM interviews WHERE owner_id = $1
), ranked AS (
    SELECT d, (CURRENT_DATE - d) AS gap, row_number() OVER (ORDER BY d DESC) AS rn FROM days
)
SELECT count(*) AS days FROM ranked WHERE gap - rn IN (-1, 0)
"""

# No `archived_at` filter: the dashboard counts archived runs, so dropping them here would disagree
# with the numbers one route over.
ANALYTICS_SQL = f"""
WITH counts AS MATERIALIZED (
    SELECT m.interview_id, m.role, m.move_class, count(*) AS n
    FROM messages m
    JOIN interviews i ON i.id = m.interview_id
    WHERE i.owner_id = $1
    GROUP BY m.interview_id, m.role, m.move_class
), turn_totals AS MATERIALIZED (
    SELECT interview_id, sum(n) AS turns FROM counts WHERE role = 'user' GROUP BY interview_id
), move_totals AS MATERIALIZED (
    SELECT interview_id, jsonb_object_agg(move_class, n) AS moves
    FROM (SELECT interview_id, move_class, sum(n) AS n FROM counts WHERE move_class IS NOT NULL GROUP BY interview_id, move_class) c
    GROUP BY interview_id
), runs AS (
    SELECT i.id::text, i.role, i.level, i.status, i.created_at,
           {", ".join(f"i.{c}" for c in DIAL_FIELDS)},
           f.accuracy, f.decision, f.certainty, f.scores, i.failed_class,
           coalesce(tt.turns, 0) AS turns,
           coalesce(mt.moves, '{{}}'::jsonb) AS moves
    FROM interviews i
    LEFT JOIN feedback f ON f.interview_id = i.id
    LEFT JOIN turn_totals tt ON tt.interview_id = i.id
    LEFT JOIN move_totals mt ON mt.interview_id = i.id
    WHERE i.owner_id = $1
), activity AS (
    SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week,
           count(*) AS started,
           count(*) FILTER (WHERE status = 'completed') AS completed
    FROM interviews
    WHERE owner_id = $1 AND created_at >= now() - interval '12 weeks'
    GROUP BY 1
), completed AS (
    SELECT * FROM runs WHERE status = 'completed'
), dials AS (
    SELECT dial, value, count(*) AS runs, count(accuracy) AS rated,
           ROUND(avg(accuracy)::numeric, 1) AS avg_accuracy,
           (100.0 * count(*) FILTER (WHERE decision IN ({HIRING_SQL})) / nullif(count(decision), 0))::int AS hire_rate
    FROM (
        SELECT 'level' AS dial, level AS value, accuracy, decision FROM completed
        UNION ALL SELECT 'cynicism', cynicism, accuracy, decision FROM completed
        UNION ALL SELECT 'company_size', company_size, accuracy, decision FROM completed
        UNION ALL SELECT 'depth', depth, accuracy, decision FROM completed
        UNION ALL SELECT 'hardcore', CASE WHEN hardcore THEN 'hardcore' ELSE 'standard' END, accuracy, decision FROM completed
        UNION ALL SELECT 'honesty', CASE WHEN brutally_honest THEN 'brutally_honest' ELSE 'diplomatic' END, accuracy, decision FROM completed
        UNION ALL SELECT 'register', CASE WHEN human_mode THEN 'human' ELSE 'corporate' END, accuracy, decision FROM completed
    ) labelled
    GROUP BY dial, value
), offers AS (
    SELECT {OFFER_COLS}
    FROM offers o
    JOIN interviews i ON i.id = o.interview_id
    LEFT JOIN feedback f ON f.interview_id = o.interview_id
    WHERE i.owner_id = $1
), streak AS (
    {ANALYTICS_STREAK_SQL}
)
SELECT
    (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.created_at DESC), '[]') FROM runs r) AS runs,
    (SELECT coalesce(jsonb_agg(to_jsonb(a) ORDER BY a.week), '[]') FROM activity a) AS activity,
    (SELECT coalesce(jsonb_agg(to_jsonb(d)), '[]') FROM dials d) AS dials,
    (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.created_at DESC), '[]') FROM offers o) AS offers,
    (SELECT days FROM streak) AS streak_days
"""


@api.get("/stats/analytics", response_model=Analytics)
async def get_analytics(user: CurrentUser) -> dict:
    # AI HERE: one checkout instead of five. The five CTEs still scan the owner's history; the upgrade is a rollup.
    row = await fetchrow(ANALYTICS_SQL, user.sub)
    assert row is not None

    runs = []
    move_classes = dict.fromkeys(rating.MOVE_CLASSES, 0)
    total_turns = 0
    hardcore_failures = 0
    for r in row["runs"]:
        for cls in rating.MOVE_CLASSES:
            move_classes[cls] += r["moves"].get(cls, 0)
        total_turns += r["turns"]
        hardcore_failures += 1 if r["failed_class"] else 0
        runs.append({**r, "dials": {k: r[k] for k in DIAL_FIELDS}, "scores": r["scores"] or {}, "grade": rating.grade(r["accuracy"], failed=r["failed_class"] is not None)})

    return {
        "runs": runs,
        "activity": row["activity"],
        "move_classes": move_classes,
        "dials": dial_groups(row["dials"]),
        "total_turns": total_turns,
        "streak_days": row["streak_days"] or 0,
        "hardcore_failures": hardcore_failures,
        "offers": offer_board([offer_row({**r, "created_at": datetime.fromisoformat(r["created_at"])}) for r in row["offers"]]),
    }


# The radar in ONE row: two averages (all rated runs, the newest RECENT_WINDOW) plus their counts.
# Finished AND scored only: accuracy lives on feedback, not interviews. ROUND(...,1) matches the UI.
DASHBOARD_SQL = f"""
WITH owned AS (
    SELECT i.created_at, i.status, f.accuracy, f.decision, f.certainty, f.scores
    FROM interviews i
    LEFT JOIN feedback f ON f.interview_id = i.id
    WHERE i.owner_id = $1
), rated AS (
    SELECT created_at, accuracy FROM owned WHERE status = 'completed' AND accuracy IS NOT NULL
), decided AS (
    SELECT created_at, decision, certainty FROM owned WHERE status = 'completed' AND decision IS NOT NULL
), aged AS (
    SELECT CURRENT_DATE - (created_at AT TIME ZONE 'UTC')::date AS age, status FROM owned
), ages AS (
    SELECT generate_series({SPARK_DAYS - 1}, 0, -1) AS age
), days AS (
    SELECT DISTINCT (created_at AT TIME ZONE 'UTC')::date AS d FROM owned
), ranked AS (
    SELECT (CURRENT_DATE - d) - row_number() OVER (ORDER BY d DESC) AS gap FROM days
), dim_runs AS (
    SELECT created_at, scores FROM owned WHERE status = 'completed' AND accuracy IS NOT NULL
), dim_recent AS (
    SELECT scores FROM dim_runs ORDER BY created_at DESC LIMIT {RECENT_WINDOW}
)
SELECT
    (SELECT count(*) FROM owned) AS total,
    (SELECT count(*) FROM owned WHERE status = 'completed') AS completed,
    (SELECT count(*) FROM rated) AS rated,
    (SELECT coalesce(avg(accuracy), 0) FROM rated) AS avg_accuracy,
    (SELECT coalesce(jsonb_agg(jsonb_build_object('created_at', t.created_at, 'accuracy', t.accuracy) ORDER BY t.created_at), '[]')
       FROM (SELECT created_at, accuracy FROM rated ORDER BY created_at DESC LIMIT {TREND_DOTS}) t) AS accuracy_trend,
    (SELECT count(*) FROM decided) AS decided,
    (SELECT count(*) FROM decided WHERE decision IN ({HIRING_SQL})) AS hiring,
    (SELECT round(avg(certainty)) FROM decided WHERE certainty IS NOT NULL) AS avg_certainty,
    (SELECT count(*) FROM aged WHERE age >= 0 AND age < 7) AS week_runs,
    (SELECT count(*) FROM aged WHERE age >= 7 AND age < 14) AS prior_week_runs,
    (SELECT count(*) FROM aged WHERE status = 'completed' AND age >= 0 AND age < 7) AS week_finished,
    (SELECT count(*) FROM aged WHERE status = 'completed' AND age >= 7 AND age < 14) AS prior_week_finished,
    (SELECT count(*) FROM ranked WHERE gap IN (-1, 0)) AS streak,
    (SELECT min(age) FROM aged) AS last_run_days,
    (SELECT CASE WHEN count(*) >= {DELTA_WINDOW * 2}
                 THEN avg(accuracy) FILTER (WHERE rn <= {DELTA_WINDOW}) - avg(accuracy) FILTER (WHERE rn > {DELTA_WINDOW} AND rn <= {DELTA_WINDOW * 2}) END
       FROM (SELECT accuracy, row_number() OVER (ORDER BY created_at DESC) AS rn FROM rated) x) AS delta_accuracy,
    (SELECT CASE WHEN count(*) >= {DELTA_WINDOW * 2}
                 THEN avg(hit) FILTER (WHERE rn <= {DELTA_WINDOW}) - avg(hit) FILTER (WHERE rn > {DELTA_WINDOW} AND rn <= {DELTA_WINDOW * 2}) END
       FROM (SELECT CASE WHEN decision IN ({HIRING_SQL}) THEN 100.0 ELSE 0.0 END AS hit,
                    row_number() OVER (ORDER BY created_at DESC) AS rn FROM decided) x) AS delta_hire,
    (SELECT coalesce(jsonb_agg(n ORDER BY age DESC), '[]')
       FROM (SELECT a.age, count(o.age) AS n FROM ages a LEFT JOIN aged o ON o.age = a.age GROUP BY a.age) z) AS daily_runs,
    (SELECT coalesce(jsonb_agg(n ORDER BY age DESC), '[]')
       FROM (SELECT a.age, count(o.age) AS n FROM ages a LEFT JOIN aged o ON o.age = a.age AND o.status = 'completed' GROUP BY a.age) z) AS daily_finished,
    (SELECT coalesce(jsonb_agg(100.0 * hits / i ORDER BY i), '[]')
       FROM (SELECT i, sum(hit) OVER (ORDER BY i) AS hits
               FROM (SELECT row_number() OVER (ORDER BY created_at) AS i,
                            CASE WHEN decision IN ({HIRING_SQL}) THEN 1 ELSE 0 END AS hit FROM decided) d) s
      WHERE i > (SELECT count(*) FROM decided) - {TREND_DOTS}) AS hire_spark,
    (SELECT count(*) FROM dim_runs) AS count,
    (SELECT least((SELECT count(*) FROM dim_runs), {RECENT_WINDOW})) AS recent_n,
    (SELECT coalesce(jsonb_object_agg(d, avg_val), '{{}}'::jsonb)
       FROM (SELECT s.dim AS d, ROUND(avg(s.value::numeric), 1) AS avg_val
               FROM dim_runs, jsonb_each_text(dim_runs.scores) AS s(dim, value)
              GROUP BY s.dim) per_dim) AS averages,
    (SELECT coalesce(jsonb_object_agg(d, avg_val), '{{}}'::jsonb)
       FROM (SELECT s.dim AS d, ROUND(avg(s.value::numeric), 1) AS avg_val
               FROM dim_recent, jsonb_each_text(dim_recent.scores) AS s(dim, value)
              GROUP BY s.dim) per_dim_recent) AS recent
"""


@api.get("/stats/dashboard", response_model=DashboardDims)
async def get_dashboard_dims(user: CurrentUser) -> dict:
    row = await fetchrow(DASHBOARD_SQL, user.sub)
    assert row is not None
    return dict(row)


# Key -> (value slug -> label), in render order. Vocabularies come from app/dials.py and app/levels.py,
# so a new slug shows up before its label does. This table owns ORDER and labels only.
ANALYTICS_DIALS: tuple[tuple[str, dict[str, str]], ...] = (
    ("level", {s: levels.label(s) for s in levels.LEVELS}),
    ("cynicism", dict(zip(dials.CYNICISM, ("Kind", "Neutral", "Skeptical"), strict=True))),
    ("company_size", dict(zip(dials.COMPANY_SIZES, ("Any", "1-10", "11-50", "51-200", "201-1k", "1k-5k", "5k+"), strict=True))),
    ("depth", {"screen": "Screen", "standard": "Standard", "full": "Full loop"}),
    ("hardcore", {"hardcore": "Hardcore", "standard": "Standard"}),
    ("honesty", {"brutally_honest": "Brutally honest", "diplomatic": "Diplomatic"}),
    ("register", {"human": "Human", "corporate": "Corporate"}),
)


def dial_groups(rows: list[asyncpg.Record]) -> dict[str, list[dict]]:
    seen = {}
    for r in rows:
        seen.setdefault(r["dial"], {})[r["value"]] = {"runs": r["runs"], "rated": r["rated"], "avg_accuracy": r["avg_accuracy"], "hire_rate": r["hire_rate"]}
    groups = {}
    for key, labels in ANALYTICS_DIALS:
        values = seen.pop(key, {})
        ordered = [v for v in labels if v in values] + [v for v in values if v not in labels]
        groups[key] = [{"key": v, "label": labels.get(v, v), **values[v]} for v in ordered]
    return groups


# Offers: app/offer.py owns the rate card.

OFFERS_SQL = f"""
SELECT {OFFER_COLS}
FROM offers o
JOIN interviews i ON i.id = o.interview_id
LEFT JOIN feedback f ON f.interview_id = o.interview_id
WHERE i.owner_id = $1
ORDER BY o.created_at DESC
"""

OFFER_SQL = f"""
SELECT {OFFER_COLS}
FROM offers o
JOIN interviews i ON i.id = o.interview_id
LEFT JOIN feedback f ON f.interview_id = o.interview_id
WHERE o.interview_id = $1 AND i.owner_id = $2
"""


def offer_row(r: asyncpg.Record) -> Offer:
    floor, ceiling, _ = offer.band_range(r["band"])
    tier, tier_label = offer.tier(r["performance"])
    return Offer(
        **{
            "interview_id": r["interview_id"],
            "role": r["role"],
            "level": r["level"],
            "title": r["title"],
            "band": r["band"],
            "band_low": floor,
            "band_high": ceiling,
            "base_salary": r["base_salary"],
            "signing_bonus": r["signing_bonus"],
            "equity": r["equity"],
            "performance": r["performance"],
            "tier": tier,
            "tier_label": tier_label,
            "benefits": r["benefits"] or [],
            "accuracy": r["accuracy"],
            "grade": rating.grade(r["accuracy"], failed=r["failed_class"] is not None),
            "decision": r["decision"],
            "created_at": r["created_at"],
            "starts_on": offer.start_date(r["created_at"]),
        }
    )


def offer_summary(rows: list[Offer]) -> dict:
    if not rows:
        return {"count": 0}
    bases = sorted(r.base_salary for r in rows)
    totals = sorted(r.total_comp for r in rows)
    best = max(rows, key=lambda r: r.total_comp)
    worst = min(rows, key=lambda r: r.total_comp)
    return {
        "count": len(rows),
        "avg_base": round(fmean(bases)),
        "median_base": round(median(bases)),
        "low_base": bases[0],
        "high_base": bases[-1],
        "avg_total": round(fmean(totals)),
        "low_total": totals[0],
        "high_total": totals[-1],
        "avg_signing": round(fmean(r.signing_bonus for r in rows)),
        "avg_equity": round(fmean(r.equity for r in rows)),
        "avg_performance": round(fmean(r.performance for r in rows)),
        "avg_benefits": round(fmean(len(r.benefits) for r in rows), 1),
        "best_id": best.interview_id,
        "worst_id": worst.interview_id,
    }


def offer_groups(rows: list[Offer], buckets: list[tuple[str, str]], key_of) -> list[dict]:
    groups = []
    for key, label in buckets:
        group = [r for r in rows if key_of(r) == key]
        if not group:
            continue
        bases = sorted(r.base_salary for r in group)
        groups.append(
            {
                "key": key,
                "label": label,
                "offers": len(group),
                "avg_base": round(fmean(bases)),
                "low_base": bases[0],
                "high_base": bases[-1],
                "span": bases[-1] - bases[0],
                "avg_total": round(fmean(r.total_comp for r in group)),
                "avg_performance": round(fmean(r.performance for r in group)),
            }
        )
    return groups


def offer_benefits(rows: list[Offer]) -> list[dict]:
    counted = Counter(b.key for r in rows for b in r.benefits)
    total = len(rows) or 1
    return [{"key": key, "label": label, "offers": counted.get(key, 0), "rate": round(100 * counted.get(key, 0) / total)} for key, label in offer.ladder()]


def offer_activity(rows: list[Offer]) -> list[dict]:
    months: dict[str, list[int]] = {}
    for r in rows:
        months.setdefault(r.created_at.strftime("%Y-%m"), []).append(r.base_salary)
    return [{"month": m, "offers": len(v), "avg_base": round(fmean(v))} for m, v in sorted(months.items())]


def offer_board(rows: list[Offer]) -> dict:
    return {
        "summary": offer_summary(rows),
        "offers": rows,
        "by_level": offer_groups(rows, [(s, levels.label(s)) for s in levels.LEVELS], lambda o: o.band),
        "by_tier": offer_groups(rows, [(key, label) for key, _, label in offer.TIERS], lambda o: o.tier),
        "benefits": offer_benefits(rows),
        "activity": offer_activity(rows),
    }


@api.get("/interviews/{interview_id}/offer", response_model=Offer)
async def get_interview_offer(interview_id: str, user: CurrentUser) -> dict:
    row = await fetchrow(OFFER_SQL, interview_id, user.sub)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No offer for this interview")
    return offer_row(row)


@api.get("/usage")
async def get_usage(user: CurrentUser) -> dict:
    state = await billing.usage_state(user)
    tier = billing.tier_from(user, entitled=state["premium_until"] is not None)
    byok_enabled = state["byok"] and byok.enabled()
    chat = billing.chat_turn_limit(tier, byok=byok_enabled)
    used = state["turns"]
    return {
        "tier": tier,
        f"chat_turns_per_day_{tier}": chat,
        "chat_turns_used_today": used,
        "chat_turns_remaining_today": max(0, chat - used),
        "byok": byok_enabled,
        "resume_limit": billing.resume_limit(tier),
        "billing_mode": payments.BILLING_MODE,
        "premium_until": state["premium_until"] if tier == "premium" else None,
    }


# BYOK LLM provider; app/byok.py owns the policy.


@api.get("/settings/llm", response_model=LLMProvider)
async def get_llm_provider(user: CurrentUser) -> dict:
    return await byok.public_view(user)


@api.put("/settings/llm", response_model=LLMProvider)
async def put_llm_provider(body: LLMProviderUpdate, user: CurrentUser) -> dict:
    await byok.save(user.sub, body.base_url, body.model, body.api_key)
    return await byok.public_view(user)


@api.delete("/settings/llm", status_code=status.HTTP_204_NO_CONTENT)
async def delete_llm_provider(user: CurrentUser) -> None:
    await byok.clear(user.sub)


@api.post("/settings/llm/test")
async def test_llm_provider(user: CurrentUser) -> dict:
    return await byok.test(user)


@api.post("/billing/checkout")
async def billing_checkout(user: CurrentUser) -> dict:
    return await payments.start_upgrade(user)


@api.post("/billing/cancel", response_model=dict)
async def billing_cancel(user: CurrentUser) -> dict:
    await payments.cancel_upgrade(user)
    return {"ok": True}


@api.post("/billing/webhook")
async def billing_webhook(request: Request) -> PlainTextResponse:
    raw = await request.body()
    if not payments.verify_signature(raw, request.headers.get("paymongo-signature", "")):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid signature")
    await payments.handle_webhook_event(json.loads(raw))
    return PlainTextResponse("ok")


# No PayMongo equivalent of `stripe listen`, and a tunnel for local webhooks is friction we do not want.
# Guarded like the no-Clerk fallback: unreachable with APP_ENV=production.
@api.post("/billing/webhook/simulate")
async def billing_webhook_simulate(event: dict) -> PlainTextResponse:
    if APP_ENV not in ("development", "test"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
    await payments.handle_webhook_event(event)
    return PlainTextResponse("ok")


async def _chat_session(interview_id: str, user: CurrentUser) -> tuple[dict, list, int, Dials]:
    interview = await fetchrow(
        f"""
        SELECT {INTERVIEW_COLS},
               (SELECT r.text FROM resumes r WHERE r.id = interviews.resume_id) AS resume_text,
               (SELECT coalesce(jsonb_agg(jsonb_build_object('role', m.role, 'content', m.content) ORDER BY m.created_at), '[]')
                  FROM messages m WHERE m.interview_id = interviews.id) AS transcript
        FROM interviews WHERE id = $1 AND owner_id = $2
        """,
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
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This hardcore run is over: one vague or wrong answer ended it. Press Finish for the feedback.")

    prior_rows = interview["transcript"]
    # Interviewer turns already asked, which selects the arc phase. Derived from the transcript, not stored.
    asked = sum(1 for r in prior_rows if r["role"] == "assistant")
    dials = Dials(**{k: interview[k] for k in DIAL_FIELDS})
    # Once the arc is spent the interview is over: refuse before spending a chat credit or a model call.
    # The sign-off was the previous turn, so this is what makes it final.
    if llm.is_interview_finished(asked, dials):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This interview has asked all of its questions. Press Finish to get your feedback, or start a new interview at a deeper level.",
        )
    return interview, prior_rows, asked, dials


def _lockout_detail(tier: str, byok: bool, limit: int) -> str:
    if not byok:
        return "Daily chat-turn credits reached. Try again after midnight UTC, or upgrade to Pro."
    pro = billing.chat_turn_limit("premium", byok=True)
    return f"Daily chat-turn limit reached ({limit} turns/day on your own provider). Try again after midnight UTC." + (f" Pro raises it to {pro}." if tier == "free" else "")


CHAT_TURN_SQL = f"""
        WITH spend AS (
            {billing.SPEND_TURN_SQL}
        ), repaired AS (
            DELETE FROM messages
            WHERE interview_id = $5::uuid
              AND $6::bool
              AND id = (SELECT id FROM messages WHERE interview_id = $5::uuid ORDER BY created_at DESC, id DESC LIMIT 1)
              AND EXISTS (SELECT 1 FROM spend)
        ), stored AS (
            INSERT INTO messages (interview_id, role, content)
            SELECT $5::uuid, 'user', $4 FROM spend
            RETURNING id::text
        )
        SELECT id FROM stored
        """


async def _spend_chat_turn(user: CurrentUser, config: llm.LLMConfig, tier: str) -> None:
    limit = billing.chat_turn_limit(tier, byok=config.byok)
    if not await billing.spend_chat_turn(user.sub, limit):
        raise HTTPException(status_code=status.HTTP_402_PAYMENT_REQUIRED, detail=_lockout_detail(tier, config.byok, limit))


async def _spend_and_store_turn(user: CurrentUser, config: llm.LLMConfig, tier: str, interview_id: str, content: str, repair: bool) -> str:
    limit = billing.chat_turn_limit(tier, byok=config.byok)
    row = await fetchrow(CHAT_TURN_SQL, user.sub, billing.utc_day(), limit, content, interview_id, repair)
    if row is None:
        raise HTTPException(status_code=status.HTTP_402_PAYMENT_REQUIRED, detail=_lockout_detail(tier, config.byok, limit))
    return row["id"]


async def _reply_frames(
    history: list[ChatMessage],
    interview_id: str,
    config: llm.LLMConfig,
    asked: int,
    on_error: Callable[[], Awaitable[None]] | None = None,
) -> AsyncIterator[str]:
    collected: list[str] = []
    turn_started = time.perf_counter()
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
        # AI HERE: `chars` stands in for tokens; the provider reports usage only when asked.
        log.info("llm.chat.completed", interview_id=interview_id, model=config.model, asked=asked, chars=len(reply), latency_ms=round((time.perf_counter() - turn_started) * 1000, 1))
    except Exception as exc:
        # Model or DB failure while the turn is in flight: whatever the caller wrote first must not
        # outlive it, or the next send duplicates it (see the reply path's trailing-user-turn repair).
        log.warning("llm.chat.failed", interview_id=interview_id, model=config.model, byok=config.byok, provider=llm.provider_host(config), asked=asked, reason=type(exc).__name__, latency_ms=round((time.perf_counter() - turn_started) * 1000, 1))
        if on_error:
            await on_error()
        # The client shows this verbatim: an unreachable provider is the one failure its owner can
        # fix themselves, and "ConnectError" is not that sentence.
        yield f"event: error\ndata: {llm.unreachable_detail(exc, config) or str(exc)}\n\n"
        return
    yield "event: done\ndata: {}\n\n"


@api.post("/interviews/{interview_id}/chat/kickoff")
async def chat_kickoff(interview_id: str, user: CurrentUser, config: LLMConfigDep, chat: ChatLLMDep, tier: TierDep) -> StreamingResponse:
    interview, _transcript, asked, dials = await _chat_session(interview_id, user)
    if asked:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This interview has already opened.")
    await _spend_chat_turn(user, config, tier)
    history = [
        ChatMessage(role="system", content=llm.system_prompt(interview["role"], interview["level"], interview["topic"], asked=asked, dials=dials, resume=interview["resume_text"] or "")),
    ]

    async def _stream_events():
        async for frame in _reply_frames(history, interview_id, chat, asked):
            yield frame

    return StreamingResponse(_stream_events(), media_type="text/event-stream")


@api.post("/interviews/{interview_id}/chat/stream")
async def chat_stream(
    interview_id: str,
    body: ChatTurn,
    user: CurrentUser,
    config: LLMConfigDep,
    chat: ChatLLMDep,
    tier: TierDep,
) -> StreamingResponse:
    interview, prior_rows, asked, dials = await _chat_session(interview_id, user)

    # A trailing user turn means an earlier attempt died before its reply landed, so this send REPLACES it,
    # past the guards only. The stale row leaves the history too, or the model sees the answer twice.
    repair = bool(prior_rows and prior_rows[-1]["role"] == "user")
    user_msg_id = await _spend_and_store_turn(user, config, tier, interview_id, body.content, repair)
    if repair:
        prior_rows = prior_rows[:-1]

    async def _discard_turn() -> None:
        if not user_msg_id:
            return
        try:
            await asyncio.shield(
                fetchrow(
                    "DELETE FROM messages WHERE id = $1 AND interview_id = $2 AND (SELECT status FROM interviews WHERE id = $2) = 'in_progress'",
                    user_msg_id,
                    interview_id,
                )
            )
        except BaseException:
            log.warning("chat.turn_rollback_failed", interview_id=interview_id)

    history = [
        ChatMessage(role="system", content=llm.system_prompt(interview["role"], interview["level"], interview["topic"], asked=asked, dials=dials, resume=interview["resume_text"] or "")),
        *[ChatMessage(role=r["role"], content=r["content"]) for r in prior_rows],
        ChatMessage(role="user", content=body.content),
    ]

    async def _stream_events():
        # Judged before the interviewer replies: one failing answer ends the run, and the mode promises
        # never to spend a question on someone already out. The last answer counts too.
        if dials.hardcore:
            turn = sum(1 for m in history if m.role == "user")
            question = next((m["content"] for m in reversed(prior_rows) if m["role"] == "assistant"), "")
            move = await llm.judge_answer(question, body.content, config, turn)
            if move:
                await fetchrow("UPDATE messages SET move_class = $2, comment = $3 WHERE id = $1", user_msg_id, move.cls, move.comment)
            if move and move.cls in rating.FAIL_CLASSES:
                await fetchrow("UPDATE interviews SET failed_turn = $2, failed_class = $3, updated_at = now() WHERE id = $1", interview_id, turn, move.cls)
                shout = await llm.fail_shout(question, body.content, move.cls, config)
                # Persisted like any other reply, or a reload ends on the candidate's own answer with no
                # callout. Best-effort: a DB hiccup must cost the stored line, not the shout.
                try:
                    await fetchrow(
                        "INSERT INTO messages (interview_id, role, content) VALUES ($1, 'assistant', $2) RETURNING id",
                        interview_id,
                        shout,
                    )
                except Exception as exc:
                    log.warning("chat.shout_persist_failed", interview_id=interview_id, reason=type(exc).__name__)
                yield f"event: message\ndata: {shout}\n\n"
                # `failed` tells the client WHY the run ended (the arc being spent is the other ending).
                yield f'event: done\ndata: {{"closing": true, "failed": {{"turn": {turn}, "class": "{move.cls}"}}}}\n\n'
                return

        # Generated like any other turn, so it spends a chat turn. The canned line guards the case where
        # the model asks a question the API would refuse (llm.closing_line).
        if llm.is_closing_turn(asked, dials):
            closing = await llm.closing_line(history, chat)
            await fetchrow(
                "INSERT INTO messages (interview_id, role, content) VALUES ($1, 'assistant', $2) RETURNING id",
                interview_id,
                closing,
            )
            yield f"event: message\ndata: {closing}\n\n"
            # Tells the client the run is over in the same frame it renders the sign-off.
            yield 'event: done\ndata: {"closing": true}\n\n'
            return

        try:
            async for frame in _reply_frames(history, interview_id, chat, asked, on_error=_discard_turn):
                yield frame
        except BaseException:
            # Client went away (CancelledError/GeneratorExit): same rollback, nobody left to notify.
            await _discard_turn()
            raise

    return StreamingResponse(_stream_events(), media_type="text/event-stream")


async def _require_interview_owned(interview_id: str, owner_id: str) -> None:
    row = await fetchrow("SELECT 1 FROM interviews WHERE id = $1 AND owner_id = $2", interview_id, owner_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")


async def _upsert_feedback(interview_id: str, scores: dict, verdict: str, tips: list, decision: str | None = None, certainty: int | None = None, accuracy: int | None = None) -> None:
    # `accuracy` is COALESCEd, not overwritten: it derives from the stored message classes, so a raw POST
    # /feedback must not wipe a grade an earlier pass earned.
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


async def _sync_offer(interview_id: str) -> None:
    row = await fetchrow(
        "SELECT i.role, i.level, f.scores, f.accuracy, f.decision FROM interviews i JOIN feedback f ON f.interview_id = i.id WHERE i.id = $1 AND i.status = 'completed'",
        interview_id,
    )
    if row is None:
        return
    if row["decision"] not in HIRING_DECISIONS:
        await fetchrow("DELETE FROM offers WHERE interview_id = $1", interview_id)
        return
    priced = offer.terms(row["role"], row["level"], row["scores"] or {}, row["accuracy"])
    if priced is None:
        return
    await fetchrow(
        "INSERT INTO offers (interview_id, title, band, base_salary, signing_bonus, equity, performance, benefits) "
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8) "
        "ON CONFLICT (interview_id) DO UPDATE SET title = EXCLUDED.title, band = EXCLUDED.band, base_salary = EXCLUDED.base_salary, "
        "signing_bonus = EXCLUDED.signing_bonus, equity = EXCLUDED.equity, performance = EXCLUDED.performance, "
        "benefits = EXCLUDED.benefits, created_at = now()",
        interview_id,
        priced.title,
        priced.band,
        priced.base_salary,
        priced.signing_bonus,
        priced.equity,
        priced.performance,
        priced.benefits,
    )


def _questions_by_turn(history_rows: list[asyncpg.Record]) -> dict[int, str]:
    questions: dict[int, str] = {}
    asked = ""
    turn = 0
    for r in history_rows:
        if r["role"] == "assistant":
            asked = r["content"]
        elif r["role"] == "user":
            turn += 1
            questions[turn] = asked
    return questions


async def _persist_moves(interview_id: str, candidate_ids: list[str], moves: dict[int, rating.Move]) -> list[str]:
    graded = {turn: m for turn, m in moves.items() if isinstance(turn, int) and 1 <= turn <= len(candidate_ids)}
    if not graded:
        return []
    turn_numbers = range(1, len(candidate_ids) + 1)
    await fetch(
        "UPDATE messages SET move_class = u.move_class, comment = u.comment FROM unnest($2::text[], $3::text[], $4::text[]) AS u(id, move_class, comment) WHERE messages.id = u.id::uuid AND messages.interview_id = $1 RETURNING messages.id",
        interview_id,
        candidate_ids,
        [graded[t].cls if t in graded else None for t in turn_numbers],
        [graded[t].comment if t in graded else None for t in turn_numbers],
    )
    return [m.cls for m in graded.values()]


async def _reconcile_hardcore_moves(interview_id: str, history_rows: list[asyncpg.Record], candidate_rows: list[asyncpg.Record], config: llm.LLMConfig) -> list[str]:
    judged: list[rating.Move | None] = [rating.Move(r["move_class"], r["comment"]) if r["move_class"] else None for r in candidate_rows]
    holes = [n for n, m in enumerate(judged, 1) if m is None or not m.comment]
    if not holes:
        return [m.cls for m in judged if m]
    questions = _questions_by_turn(history_rows)
    fill: dict[int, rating.Move] = {}
    for n in holes:
        got = await llm.judge_answer(questions.get(n, ""), candidate_rows[n - 1]["content"], config, n)
        if got:
            fill[n] = got
    merged: dict[int, rating.Move] = {}
    for n, m in enumerate(judged, 1):
        f = fill.get(n)
        cls = (m.cls if m else None) or (f.cls if f else None)
        if cls:
            merged[n] = rating.Move(cls, (m.comment if m else None) or (f.comment if f else None))
    return await _persist_moves(interview_id, [r["id"] for r in candidate_rows], merged) or [m.cls for m in judged if m]


async def _auto_generate_and_persist_feedback(interview_id: str, config: llm.LLMConfig) -> dict | None:
    for attempt in range(COMPLETE_MAX_FEEDBACK_ATTEMPTS):
        row = await _generate_and_persist_feedback(interview_id, config)
        if row is not None:
            return row
        if attempt < COMPLETE_MAX_FEEDBACK_ATTEMPTS - 1:
            await _backoff_sleep(COMPLETE_FEEDBACK_BACKOFF_MS)
    return None


async def _generate_and_persist_feedback(interview_id: str, config: llm.LLMConfig) -> dict | None:
    with telemetry.span("feedback.generate") as current:
        row = await _run_feedback_pipeline(interview_id, config)
        current.set_attribute("feedback.outcome", "ok" if row is not None else "error")
        return row


async def _run_feedback_pipeline(interview_id: str, config: llm.LLMConfig) -> dict | None:
    # The `, id` tiebreak keeps the order stable: llm numbers candidate turns off this exact list.
    history_rows = await fetch(
        "SELECT id::text, role, content, move_class, comment FROM messages WHERE interview_id = $1 ORDER BY created_at, id",
        interview_id,
    )
    history = [ChatMessage(role=r["role"], content=r["content"]) for r in history_rows]
    # Dials come from the interview, not the caller: regenerate_feedback has no body to trust. The
    # attached resume comes with them (same scalar-subquery reason as chat_stream).
    row = await fetchrow(f"SELECT {', '.join(DIAL_FIELDS)}, level, failed_turn, failed_class, (SELECT r.text FROM resumes r WHERE r.id = interviews.resume_id) AS resume_text FROM interviews WHERE id = $1", interview_id)
    dials = Dials(**{k: row[k] for k in DIAL_FIELDS}) if row else None
    failure = (row["failed_turn"], row["failed_class"]) if row and row["failed_turn"] else None
    # A hardcore run was already judged turn by turn as it was answered (chat_stream), so its
    # annotation pass would only re-litigate verdicts the candidate was told about.
    hardcore = bool(dials and dials.hardcore)
    summary = await llm.generate_feedback(history, dials, config, failure=failure, annotate=not hardcore, resume=(row["resume_text"] or "") if row else "", level=(row["level"] or "any") if row else "any")
    if summary is None:
        return None
    candidate_rows = [r for r in history_rows if r["role"] == "user"]
    candidate_ids = [r["id"] for r in candidate_rows]
    if hardcore:
        classes = await _reconcile_hardcore_moves(interview_id, history_rows, candidate_rows, config)
    else:
        classes = await _persist_moves(interview_id, candidate_ids, summary.moves)
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
    await _sync_offer(interview_id)
    return dict(await _feedback_row(interview_id))


async def _raise_start_error(interview_id: str, owner_id: str) -> None:
    # Distinguish "foreign/not found" (404) from "already started" (409).
    row = await fetchrow("SELECT status FROM interviews WHERE id = $1 AND owner_id = $2", interview_id, owner_id)
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Interview not found")
    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Interview is not pending")


async def _raise_finish_error(interview_id: str, owner_id: str) -> None:
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
