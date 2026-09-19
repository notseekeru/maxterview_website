import asyncio
import json
import os
import time
from contextlib import asynccontextmanager
from typing import Annotated

import asyncpg
import structlog
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request, Response, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse

from app import API_PREFIX, billing, byok, dials, levels, llm, payments, rating, resumes
from app.auth import CLERK_ENABLED, get_current_user
from app.db import close_pool, fetch, fetchrow, init_pool
from app.logs import RequestContextMiddleware, configure_logging
from app.models import Analytics, ChatMessage, ChatTurn, ClerkUser, ClientError, Dials, Feedback, FeedbackCreate, Interview, InterviewCreate, InterviewDimensions, InterviewTemplate, LLMProvider, LLMProviderUpdate, Message, Resume, ResumeCreate, ResumeExtract, ResumeSummary, TemplateCreate
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


# Before anything can log: one chain for structlog and stdlib (uvicorn, unhandled tracebacks) alike.
configure_logging()

app = FastAPI(title="maxterview", lifespan=lifespan)

# AI HERE: /api is owned here (matches diagram), not by the dev proxy or the ingress — every layer
# passes the path through unchanged. Upgrade path: per-router prefixes if an admin/internal split lands.
api = APIRouter(prefix=API_PREFIX)

# Added first => innermost, so CORS stays outermost and its headers are still on a 429.
app.add_middleware(ClientRateLimitMiddleware)
if CORS_ALLOW_ORIGINS:
    app.add_middleware(CORSMiddleware, allow_origins=CORS_ALLOW_ORIGINS, allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

# Added last => outermost: it therefore sees the 429s and CORS rejections the inner layers return,
# and it is the layer that stamps X-Request-ID on every response.
app.add_middleware(RequestContextMiddleware)


@api.get("/health")
async def health() -> dict:
    # No DB call — CD smoke runs with a dummy DATABASE_URL and no Postgres.
    return {"status": "ok"}


@api.post("/client-errors", status_code=status.HTTP_204_NO_CONTENT)
async def client_errors(body: ClientError) -> Response:
    """Browser errors from the ANONYMOUS pages, where no Sentry SDK is loaded. Message and path only:
    no stack (nothing here could symbolicate it), no query string (ids and tokens live there). The
    per-client rate limit is the abuse ceiling and the field caps are the size ceiling."""
    log.info("browser.error", message=body.message, route=body.route)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# --- interviews (all scoped to owner_id, D4) ---


# The interview dressing dials, as pydantic field names. Identical in the DB, so one tuple serves
# the `Dials(**row)` build, the columns of every interview read, and nothing can drift between them.
DIAL_FIELDS = ("company_size", "cynicism", "brutally_honest", "human_mode", "hardcore", "mix_chitchat", "mix_behavioural", "mix_technical")

# Interview row columns for every SELECT/RETURNING that builds an `Interview`. Shared because
# `Interview` fills an absent field from its default, so a query that forgets a dial would answer
# 200 with a WRONG value ('neutral' for a run created skeptical) rather than an error.
INTERVIEW_COLS = "id::text, owner_id, role, level, topic, resume_id::text, status, created_at, updated_at, failed_turn, failed_class, archived_at, " + ", ".join(DIAL_FIELDS)


@api.get("/interviews", response_model=list[Interview])
async def list_interviews(user: CurrentUser) -> list[dict]:
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
    # The attached resume is proven to be the caller's IN THE INSERT (the `WHERE` below), not by a
    # pre-check: a foreign or deleted id yields no row, which is the same one round trip and cannot
    # race a delete between the two statements. None row here means exactly that — this path has no
    # cap to confuse it with.
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
    """Set/clear `archived_at`, returning the row so the caller can update in place.

    Archive is a list-hiding flag, not a status: the run keeps whatever lifecycle it had, still comes
    back from GET /interviews, and still counts in the dashboard stats. That is the whole difference
    from delete, which destroys it (see models.Interview.archived_at)."""
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


# --- interview templates (saved create-interview presets, owner-scoped, D4) ---

# Per-owner ceiling: presets render as one chip row above the create form.
TEMPLATE_CAP = 20

TEMPLATE_COLS = "id::text, owner_id, name, role, level, topic, resume_id::text, created_at, updated_at, " + ", ".join(DIAL_FIELDS)

# Dials are appended after each template statement's own prefix, generated from these bases rather
# than hand-counted: a hole in the numbering (a dropped or skipped placeholder) makes Postgres parse
# fine and asyncpg fail at bind with "could not determine data type of parameter $n".
# CREATE: $1..$6 = owner_id, name, role, level, topic, resume_id. UPDATE: $1..$7 = id, owner_id, then
# the same five. Two bases, because the two statements do NOT share a prefix.
TEMPLATE_CREATE_DIAL_PARAM = 7
TEMPLATE_UPDATE_DIAL_PARAM = 8

# The built-ins every owner is given once: full create bodies, so a new account's first click starts
# a run. After seeding they are ordinary rows - renameable, updatable, deletable like any other.
DEFAULT_TEMPLATES: tuple[TemplateCreate, ...] = (
    TemplateCreate(name="The Killer", role="Software Engineer", company_size="5k+", cynicism="skeptical", brutally_honest=True, human_mode=False, hardcore=True, mix_behavioural=1),
    TemplateCreate(name="The Griller", role="Software Engineer", company_size="201-1k", cynicism="skeptical", brutally_honest=True),
    TemplateCreate(name="The Chiller", role="Software Engineer", company_size="1-10", cynicism="kind", mix_chitchat=2, mix_behavioural=1, mix_technical=2),
)
# Rows as plain dicts: the asyncpg jsonb codec encodes them (a pre-dumped STRING would arrive as a
# JSON scalar, and jsonb_to_recordset would refuse it).
DEFAULT_TEMPLATES_ROWS = [t.model_dump(mode="json") for t in DEFAULT_TEMPLATES]

# One statement: the marker insert only returns a row the first time (ON CONFLICT), and the presets
# are only inserted when it does, so a later read is a no-op and a deleted default stays deleted.
# The three arrive as ONE jsonb parameter with their column types declared in the recordset
# signature: a 3x14 VALUES list would mean hand-counting 42 placeholders, and a hole in that
# numbering fails at bind, not at parse (see the DIAL_PARAM constants above).
# `ordinality` is the array position, microsecond-staggered onto created_at so the row order matches
# the order declared above (the list is newest-first, and all three would otherwise share one
# transaction timestamp and come back in whatever order Postgres liked).
SEED_DEFAULTS_SQL = f"""
        WITH seed AS (
            INSERT INTO template_seeds (owner_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING owner_id
        )
        INSERT INTO interview_templates (owner_id, name, role, level, topic, resume_id, {", ".join(DIAL_FIELDS)}, created_at)
        SELECT $1, d.name, d.role, d.level, d.topic, d.resume_id, {", ".join(f"d.{f}" for f in DIAL_FIELDS)}, now() - (d.ordinality * interval '1 microsecond')
        FROM seed, ROWS FROM (jsonb_to_recordset($2::jsonb) AS (name text, role text, level text, topic text, resume_id uuid, company_size text, cynicism text, brutally_honest boolean, human_mode boolean, hardcore boolean, mix_chitchat smallint, mix_behavioural smallint, mix_technical smallint)) WITH ORDINALITY AS d
        """


@api.get("/templates", response_model=list[InterviewTemplate])
async def list_templates(user: CurrentUser) -> list[dict]:
    # The seed rides the read every client already makes on mount: there is no signup hook to hang it
    # on (identity is Clerk's), and the marker makes the repeat cost one no-op statement.
    await fetchrow(SEED_DEFAULTS_SQL, user.sub, DEFAULT_TEMPLATES_ROWS)
    rows = await fetch(
        f"SELECT {TEMPLATE_COLS} FROM interview_templates WHERE owner_id = $1 ORDER BY created_at DESC",
        user.sub,
    )
    return [dict(r) for r in rows]


@api.post("/templates", response_model=InterviewTemplate, status_code=status.HTTP_201_CREATED)
async def create_template(
    body: TemplateCreate,
    user: CurrentUser,
) -> dict:
    # Cap AND resume ownership checked inside the INSERT: one round trip, no pre-count race. The
    # caller cannot tell which condition returned no row, so the message names the cap (the only one
    # an honest client can hit — a foreign resume id is caught here too, as a 404).
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
    """Full replace, not a merge: the caller holds every field of the preset it is editing."""
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


# --- resumes (the library; an interview/preset holds `resume_id`, nothing else references one) ---

# No `text` in the list projection: `MAX_CHARS` per row is the per-row fan-out the rate-budget
# guardrail bans, and the editor only ever opens one. `chars` is computed from the column, so there is
# no stored length to keep in step with an edit.
RESUME_COLS = "id::text, owner_id, name, page_count, created_at, updated_at, length(text) AS chars"
RESUME_COLS_WITH_TEXT = RESUME_COLS + ", text"


def _resume_name(raw: str | None, fallback: str = "Untitled resume") -> str:
    """The display name, from a filename stem on the upload path and as typed on the paste path.

    The filename is attacker-controlled and is used as TEXT ONLY — never as a path, never to decide
    anything. It gets the same hygiene as the body (which also caps it at the column's 80), so a name
    cannot carry control characters or a zero-width join into the UI.
    """
    stem = (raw or "").replace("\\", "/").rsplit("/", 1)[-1]
    if stem.lower().endswith(".pdf"):
        stem = stem[:-4]
    return resumes.sanitize(stem, 80).strip() or fallback


def _resume_body(text: str) -> str:
    """The text a resume is allowed to hold, or 422. Shared by both write paths and the extract route's
    successor, so a pasted resume cannot skip the hygiene an extracted one gets."""
    body = resumes.sanitize(text, resumes.MAX_CHARS)
    if not body:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="There is no text to save. Paste some, or upload a PDF with selectable text.")
    return body


def _resume_cap_error(tier: str, cap: int) -> HTTPException:
    """402 when the CAP is what free-ness costs you — the UI already turns 402 into its upgrade notice
    — and 409 when a paid owner simply hit the ceiling (nothing to sell them)."""
    if tier == "free":
        return HTTPException(status_code=status.HTTP_402_PAYMENT_REQUIRED, detail=f"The free plan includes {cap} resume. Delete it to import another, or upgrade to premium for {billing.PREMIUM_RESUMES}.")
    return HTTPException(status_code=status.HTTP_409_CONFLICT, detail=f"You already have {cap} resumes, the maximum. Delete one to import another.")


async def _insert_resume(owner_id: str, tier: str, name: str, text: str, page_count: int = 0) -> dict:
    """The one write path for both import routes (PDF extract, paste).

    Ownership is not a question here — the row is being created — but the tier cap is checked INSIDE
    the INSERT, so two imports racing cannot both pass a count taken a moment earlier."""
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
    """PDF in, text out. Persists NOTHING: a hostile document runs inside this call and leaves no row,
    no transaction and no attachable id behind — which is the whole reason the parse and the write are
    two endpoints.

    `read(MAX_BYTES + 1)` is what bounds what WE allocate: asking for one byte more than the cap
    detects "too big" without ever holding the whole file. It does not bound what Starlette already
    spooled while parsing the form (a part over 1MB goes to a temp file on disk — the pod needs a
    writable /tmp), and nothing upstream caps the request body itself.
    """
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
    """Save. The paste path and the second half of the PDF import are the same request: the browser
    posts text it already has, so `page_count` is 0 there and provenance only."""
    return await _insert_resume(user.sub, await billing.resolve_tier(user), body.name, body.text)


@api.put("/resumes/{resume_id}", response_model=Resume)
async def update_resume(
    resume_id: str,
    body: ResumeCreate,
    user: CurrentUser,
) -> dict:
    """Full replace, like presets: the editor holds every field it is writing. This is also the fix for
    a bad extraction — paste the corrected text over it."""
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


# --- dashboard stats (aggregates, not per-row reads) ---

# The dashboard radar, as ONE row. It used to be a GET /feedback per rated run (N HTTP requests, 2N SQL
# round trips, a payload growing with history) to average `scores` client-side; the reader wants the
# averages, the newest run, and the count, so the server answers with exactly that. `runs` is the same
# population the client filtered for (finished AND scored: accuracy lives on feedback, not interviews),
# jsonb_each_text skips a dimension a run never scored, and ROUND(...,1) matches the UI's rounding.
DIMENSIONS_SQL = """
WITH runs AS (
    SELECT i.created_at, f.scores
    FROM interviews i
    JOIN feedback f ON f.interview_id = i.id
    WHERE i.owner_id = $1
      AND i.status = 'completed'
      AND f.accuracy IS NOT NULL
)
SELECT
    (SELECT count(*) FROM runs) AS count,
    (SELECT coalesce((SELECT scores FROM runs ORDER BY created_at DESC LIMIT 1), '{}'::jsonb)) AS latest,
    (SELECT coalesce(jsonb_object_agg(d, avg_val), '{}'::jsonb)
       FROM (SELECT s.dim AS d, ROUND(avg(s.value::numeric), 1) AS avg_val
               FROM runs, jsonb_each_text(runs.scores) AS s(dim, value)
              GROUP BY s.dim) per_dim) AS averages
"""


@api.get("/stats/dimensions", response_model=InterviewDimensions)
async def get_interview_dimensions(user: CurrentUser) -> dict:
    # /stats, not /interviews/dimensions: /interviews/{interview_id} is declared above, so a literal
    # sibling would be matched as an id and 500 on UUID parsing.
    # AI HERE: the RESPONSE is flat whatever the history, but the query still aggregates this owner's
    # feedback rows per request. Upgrade path if it ever gets hot: a rollup table or a short-TTL cache
    # keyed by owner. The window is all-time on purpose - trimming it is a product call, not a perf one.
    row = await fetchrow(DIMENSIONS_SQL, user.sub)
    assert row is not None  # three scalar subqueries and no FROM: always exactly one row
    return dict(row)


# --- analytics (the deep-dive page; same one-aggregate rule as the dashboard above) ---

# Every run this owner ever created, newest first, with its review joined. `archived_at` is NOT
# filtered: the dashboard counts archived runs on purpose, and a page that silently dropped them would
# disagree with the numbers one route over. `moves` is pre-aggregated so the response carries no
# per-turn rows.
ANALYTICS_RUNS_SQL = (
    """
SELECT i.id::text, i.role, i.level, i.status, i.created_at,
       """
    + ", ".join(f"i.{c}" for c in DIAL_FIELDS)
    + """,
       f.accuracy, f.decision, f.certainty, f.scores, i.failed_class,
       (SELECT count(*) FROM messages m WHERE m.interview_id = i.id AND m.role = 'user') AS turns,
       (SELECT coalesce(jsonb_object_agg(mc.cls, mc.n), '{}'::jsonb)
          FROM (SELECT m.move_class AS cls, count(*) AS n FROM messages m
                 WHERE m.interview_id = i.id AND m.move_class IS NOT NULL GROUP BY m.move_class) mc) AS moves
FROM interviews i
LEFT JOIN feedback f ON f.interview_id = i.id
WHERE i.owner_id = $1
ORDER BY i.created_at DESC
"""
)

# Created vs completed runs per ISO week, over the last 12 weeks; weeks with no runs are absent
# rather than zero-filled. date_trunc('week') is Monday-based, which the frontend's label assumes.
ANALYTICS_ACTIVITY_SQL = """
SELECT to_char(date_trunc('week', created_at), 'YYYY-MM-DD') AS week,
       count(*) AS started,
       count(*) FILTER (WHERE status = 'completed') AS completed
FROM interviews
WHERE owner_id = $1 AND created_at >= now() - interval '12 weeks'
GROUP BY 1 ORDER BY 1
"""

# Dial breakdowns, one row per (dial, value), over the COMPLETED runs only: an in-progress run has no
# outcome to attribute to its dials. `runs` and `rated` are separate on purpose - a dial whose runs
# were never scored reports avg_accuracy NULL, not a 0% that reads as failure.
ANALYTICS_DIALS_SQL = """
WITH runs AS (
    SELECT i.level, i.cynicism, i.company_size, i.hardcore, i.human_mode, i.brutally_honest,
           i.mix_chitchat, i.mix_behavioural, i.mix_technical, f.accuracy, f.decision
    FROM interviews i
    LEFT JOIN feedback f ON f.interview_id = i.id
    WHERE i.owner_id = $1 AND i.status = 'completed'
), labelled AS (
    SELECT 'level' AS dial, level AS value, accuracy, decision FROM runs
    UNION ALL SELECT 'cynicism', cynicism, accuracy, decision FROM runs
    UNION ALL SELECT 'company_size', company_size, accuracy, decision FROM runs
    UNION ALL SELECT 'mix', CASE WHEN mix_technical >= mix_behavioural AND mix_technical >= mix_chitchat THEN 'technical'
                                 WHEN mix_behavioural >= mix_chitchat THEN 'behavioural' ELSE 'chitchat' END, accuracy, decision FROM runs
    UNION ALL SELECT 'hardcore', CASE WHEN hardcore THEN 'hardcore' ELSE 'standard' END, accuracy, decision FROM runs
    UNION ALL SELECT 'honesty', CASE WHEN brutally_honest THEN 'brutally_honest' ELSE 'diplomatic' END, accuracy, decision FROM runs
    UNION ALL SELECT 'register', CASE WHEN human_mode THEN 'human' ELSE 'corporate' END, accuracy, decision FROM runs
)
SELECT dial, value, count(*) AS runs, count(accuracy) AS rated,
       ROUND(avg(accuracy)::numeric, 1) AS avg_accuracy,
       -- Denominated on DECIDED runs (count(decision)), not all rated ones: an undecided run is not
       -- a miss. NULL when nothing was decided, so the UI can say "—" instead of 0%.
       (100.0 * count(*) FILTER (WHERE decision IN ('hire', 'lean_hire')) / nullif(count(decision), 0))::int AS hire_rate
FROM labelled
GROUP BY dial, value
"""

# Streak: consecutive UTC days with activity, counting back from today. A day's rank and its age
# (gap) move together, so `gap - rn` is constant across a consecutive run and shifts the moment one is
# missing: -1 while the run includes today, 0 when the newest day is yesterday. Both count, so a
# streak does not read 0 for the whole of a day the candidate is still practising in.
ANALYTICS_STREAK_SQL = """
WITH days AS (
    SELECT DISTINCT (created_at AT TIME ZONE 'UTC')::date AS d FROM interviews WHERE owner_id = $1
), ranked AS (
    SELECT d, (CURRENT_DATE - d) AS gap, row_number() OVER (ORDER BY d DESC) AS rn FROM days
)
SELECT count(*) FROM ranked WHERE gap - rn IN (-1, 0)
"""


@api.get("/stats/analytics", response_model=Analytics)
async def get_analytics(user: CurrentUser) -> dict:
    # Four statements, not one: the runs list, the weekly activity and the dial breakdown each filter
    # a different population (all runs / all runs / completed only), and folding them together would
    # cost more to read than the extra round trips cost to run.
    # AI HERE: each statement re-scans this owner's full history, and the response carries one row per
    # run. Fine at a personal history's size. Upgrade path, in order: aggregate the per-day series
    # server-side (the charts only need day buckets, not every run), cap the run log to the most recent
    # N with the rest behind a cursor, then a rollup table or a short-TTL cache keyed by owner. The
    # all-time window is a product call, not a perf one, so none of that trims what is shown.
    run_rows = await fetch(ANALYTICS_RUNS_SQL, user.sub)
    activity = await fetch(ANALYTICS_ACTIVITY_SQL, user.sub)
    dial_rows = await fetch(ANALYTICS_DIALS_SQL, user.sub)
    streak = await fetchrow(ANALYTICS_STREAK_SQL, user.sub)

    runs = []
    move_classes = dict.fromkeys(rating.MOVE_CLASSES, 0)
    total_turns = 0
    hardcore_failures = 0
    for r in run_rows:
        moves = r["moves"]
        for cls in rating.MOVE_CLASSES:
            move_classes[cls] += moves.get(cls, 0)
        total_turns += r["turns"]
        hardcore_failures += 1 if r["failed_class"] else 0
        runs.append({**dict(r), "dials": {k: r[k] for k in DIAL_FIELDS}, "scores": r["scores"] or {}, "grade": rating.grade(r["accuracy"], failed=r["failed_class"] is not None)})

    return {
        "runs": runs,
        "activity": [dict(a) for a in activity],
        "move_classes": move_classes,
        "dials": dial_groups(dial_rows),
        "total_turns": total_turns,
        "streak_days": streak["count"] if streak else 0,
        "hardcore_failures": hardcore_failures,
    }


# Every dial the page breaks down, in render order: key -> (value slug -> label). The vocabularies
# come from app/dials.py and app/levels.py, so a new slug shows up here before its label does rather
# than vanishing from the page; `mix` and the two booleans are DERIVED buckets the SQL above computes.
# No group TITLE: headings are presentation the page owns (lib/moveClasses.ts labels are the
# precedent). This table owns ORDER + labels.
ANALYTICS_DIALS: tuple[tuple[str, dict[str, str]], ...] = (
    ("level", {s: levels.label(s) for s in levels.LEVELS}),
    ("cynicism", dict(zip(dials.CYNICISM, ("Kind", "Neutral", "Skeptical"), strict=True))),
    ("company_size", dict(zip(dials.COMPANY_SIZES, ("Any", "1-10", "11-50", "51-200", "201-1k", "1k-5k", "5k+"), strict=True))),
    ("mix", {"technical": "Technical-heavy", "behavioural": "Behavioural-heavy", "chitchat": "Chitchat-heavy"}),
    ("hardcore", {"hardcore": "Hardcore", "standard": "Standard"}),
    ("honesty", {"brutally_honest": "Brutally honest", "diplomatic": "Diplomatic"}),
    ("register", {"human": "Human", "corporate": "Corporate"}),
)


def dial_groups(rows: list[asyncpg.Record]) -> dict[str, list[dict]]:
    """Bucket the flat (dial, value) aggregate rows into the page's dial groups.

    Vocabulary order, not whatever order Postgres grouped in: a bar chart that reshuffles between
    loads is unreadable. A value this file does not know (a slug added to the DB ahead of it) is
    appended unlabelled rather than dropped - the page then shows a number it cannot name, which is
    a bug report, instead of a silent hole.
    """
    seen = {}
    for r in rows:
        seen.setdefault(r["dial"], {})[r["value"]] = {"runs": r["runs"], "rated": r["rated"], "avg_accuracy": r["avg_accuracy"], "hire_rate": r["hire_rate"]}
    groups = {}
    for key, labels in ANALYTICS_DIALS:
        values = seen.pop(key, {})
        ordered = [v for v in labels if v in values] + [v for v in values if v not in labels]
        groups[key] = [{"key": v, "label": labels.get(v, v), **values[v]} for v in ordered]
    return groups


# --- usage ---


@api.get("/usage")
async def get_usage(user: CurrentUser, config: LLMConfigDep) -> dict:
    """Cheap quota status: tier + the daily GLOBAL chat-turn dial (per owner, all interviews)."""
    tier = await billing.resolve_tier(user)
    # BYOK trades the tier cap for the flat BYOK ceiling (chat_stream gates on this same number), so
    # `chat` is this owner's effective limit - the UI computes `limit - remaining` and would otherwise
    # show a negative `used` (lib/api.ts).
    chat = billing.chat_turn_limit(None if config.byok else tier)
    used = await billing.chat_turns_used(user.sub)
    return {
        "tier": tier,
        f"chat_turns_per_day_{tier}": chat,
        "chat_turns_used_today": used,
        "chat_turns_remaining_today": max(0, chat - used),
        # BYOK: the turns run on the owner's provider account, so the TIER quota is not what gates
        # them; the ceiling above is, and the UI says which payer this is.
        "byok": config.byok,
        # Storage, not a meter: the resume library's ceiling. `used` is the list length the resume page
        # already has, so this is the only number it needs from here.
        "resume_limit": billing.resume_limit(tier),
        # How money becomes premium, plus when the paid time lapses. Period mode does not
        # auto-renew, so the UI must show the expiry and must not offer a cancel that cancels
        # nothing (`billing_mode` is what tells the two apart).
        "billing_mode": payments.BILLING_MODE,
        "premium_until": await billing.premium_until(user.sub) if tier == "premium" else None,
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


# --- billing (PayMongo: upgrade / cancel / webhook) ---


@api.post("/billing/checkout")
async def billing_checkout(user: CurrentUser) -> dict:
    """Start the premium upgrade; returns the provider's hosted payment URL (a Maya redirect)."""
    return {"url": await payments.start_upgrade(user)}


@api.post("/billing/cancel", response_model=dict)
async def billing_cancel(user: CurrentUser) -> dict:
    """Stop future billing. PayMongo has no billing portal, so this is our cancel path."""
    await payments.cancel_upgrade(user)
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
    # The resume comes back with the interview. A correlated scalar subquery rather than a JOIN because
    # INTERVIEW_COLS is deliberately unqualified and `resumes` has `id`/`owner_id` too - a join would
    # make every one of those columns ambiguous.
    interview = await fetchrow(
        f"SELECT {INTERVIEW_COLS}, (SELECT r.text FROM resumes r WHERE r.id = interviews.resume_id) AS resume_text FROM interviews WHERE id = $1 AND owner_id = $2",
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

    # BYOK pays the provider, not us, so the TIER cap is not the gate - the flat billing.BYOK_CHAT_TURNS
    # ceiling is, and the turn is metered either way: `byok` is self-asserted, and a waived + unmetered
    # cap is a free ride on whoever's GPU the owner's base_url names (BYOK.md). tier=None IS that BYOK
    # signal, which is what keeps resolve_tier out of this path: nothing else here needs the tier.
    tier = None if config.byok else await billing.resolve_tier(user)
    if await billing.chat_turn_remaining(tier, user.sub) == 0:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=(f"Daily chat-turn limit reached ({billing.BYOK_CHAT_TURNS} turns/day on your own provider). Try again after midnight UTC." if config.byok else "Daily chat-turn credits reached. Try again after midnight UTC, or upgrade to premium."),
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
        ChatMessage(role="system", content=llm.system_prompt(interview["role"], interview["level"], interview["topic"], asked=asked, dials=dials, resume=interview["resume_text"] or "")),
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
            # The one number an access log cannot give: what a turn cost in wall-clock and in output.
            # AI HERE: tokens are not requested (the provider only reports usage when the payload asks
            # via stream_options.include_usage), so `chars` stands in; add the payload key when exact
            # cost accounting is needed.
            log.info("llm.chat.completed", interview_id=interview_id, model=config.model, turn=asked, chars=len(reply), latency_ms=round((time.perf_counter() - turn_started) * 1000, 1))
        except Exception as exc:
            # Model or DB failure while the turn is in flight: the user's row must not outlive it, or
            # the next send duplicates the answer (see the repair above).
            log.warning("llm.chat.failed", interview_id=interview_id, model=config.model, turn=asked, reason=type(exc).__name__, latency_ms=round((time.perf_counter() - turn_started) * 1000, 1))
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
    # Dials come from the interview, not the caller: regenerate_feedback has no body to trust. The
    # attached resume comes with them (same scalar-subquery reason as chat_stream).
    row = await fetchrow(f"SELECT {', '.join(DIAL_FIELDS)}, failed_turn, failed_class, (SELECT r.text FROM resumes r WHERE r.id = interviews.resume_id) AS resume_text FROM interviews WHERE id = $1", interview_id)
    dials = Dials(**{k: row[k] for k in DIAL_FIELDS}) if row else None
    failure = (row["failed_turn"], row["failed_class"]) if row and row["failed_turn"] else None
    # A hardcore run was already judged turn by turn as it was answered (chat_stream), so its
    # annotation pass would only re-litigate verdicts the candidate was told about.
    hardcore = bool(dials and dials.hardcore)
    summary = await llm.generate_feedback(history, dials, config, failure=failure, annotate=not hardcore, resume=(row["resume_text"] or "") if row else "")
    if summary is None:
        return None
    candidate_ids = [r["id"] for r in history_rows if r["role"] == "user"]
    if hardcore:
        classes = [r["move_class"] for r in history_rows if r["role"] == "user"]
        # The live judge can return None on a turn (verdict unavailable -> stored NULL) and a hardcore run
        # skips the moves pass, so without this the review scores a run it never finished judging and the
        # failure net below has nothing to see. Backfill ONLY the missed turns - the verdicts the candidate
        # was already told about are never re-litigated, they just travel back through the write.
        if None in classes:
            backfill = await llm.classify_turns(history, config)
            merged = {n: cls or backfill.get(n) for n, cls in enumerate(classes, 1) if cls or backfill.get(n)}
            classes = await _persist_move_classes(interview_id, candidate_ids, merged) or classes
    else:
        classes = await _persist_move_classes(interview_id, candidate_ids, summary.moves)
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
