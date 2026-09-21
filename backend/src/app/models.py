from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, computed_field

from app import dials, levels, rating, resumes

# Level slugs accepted on create, unpacked from the canonical levels vocabulary so the
# API, DB CHECK, prompt, and frontend can never drift (see app/levels.py).
Level = Literal[*levels.LEVELS]

# Interview dressing dials, unpacked from app/dials.py (same anti-drift rule as Level).
CompanySize = Literal[*dials.COMPANY_SIZES]
Cynicism = Literal[*dials.CYNICISM]

# Post-interview hire/reject SPECTRUM, left to right. Canonical slugs shared by the API
# validation, the LLM JSON schema (llm.FEEDBACK_JSON_SCHEMA), the DB CHECK (migration
# 0006), and the frontend badge. `certainty` (0-100) is the SEPARATE axis: how well the
# transcript evidences the decision, not how positive it is.
DECISIONS: tuple[str, ...] = ("reject", "lean_reject", "lean_hire", "hire")
Decision = Literal[*DECISIONS]
# Chess-style review vocabulary, spelled once in app/rating.py (migration 0010's CHECK and the
# frontend labels derive from the same words).
MoveClass = Literal[*rating.MOVE_CLASSES]
Grade = Literal[*rating.GRADES]


class ClerkUser(BaseModel):
    """Authenticated identity — `sub` is the Clerk user id, scopes every query (D4).

    `tier` is the monetization seam (D10): free/premium; `dev` applies for the
    no-Clerk dev-fallback identity. Resolved by `billing.resolve_tier`."""

    sub: str
    email: str | None = None
    name: str | None = None
    session_id: str | None = None
    tier: str = "free"


# --- interviews ---


class Dials(BaseModel):
    """The interview's dressing knobs, shared by create + response so they cannot drift.

    Defaults are what an unspecified interview has always got: neutral, human-sounding, two
    behavioural questions and as much technical ground as the mix allows. `skeptical` raises
    the interviewer's evidence bar, `brutally_honest` also reaches the grader (see llm.py).
    """

    company_size: CompanySize = "any"
    cynicism: Cynicism = "neutral"
    brutally_honest: bool = False
    human_mode: bool = True
    # Hardcore: every answer is judged as it is given, and one `mistake`/`blunder` ends the run on
    # the spot (llm.FAIL_MESSAGE) with the feedback shouting in caps. See main.chat_stream.
    hardcore: bool = False
    mix_chitchat: int = Field(default=0, ge=0, le=dials.MIX_MAX)
    mix_behavioural: int = Field(default=2, ge=0, le=dials.MIX_MAX)
    mix_technical: int = Field(default=dials.MIX_MAX, ge=0, le=dials.MIX_MAX)


class InterviewCreate(Dials):
    role: str = Field(min_length=1, max_length=200)
    topic: str = Field(default="", max_length=500)
    level: Level = "any"
    # The attach point (`resumes` below). `UUID` here, `str` on the way out: a malformed id is a 422
    # before the handler, and every id the API returns is text like `Interview.id`. Ownership is
    # enforced in the same statement as the INSERT, never by a pre-check.
    resume_id: UUID | None = None


class Interview(Dials):
    id: str
    owner_id: str
    role: str
    level: str = "any"
    topic: str = ""
    resume_id: str | None = None
    status: str
    created_at: datetime
    updated_at: datetime
    # Derived 0-100 move-review accuracy (NOT a 1-10 average) + its letter grade; null until graded.
    accuracy: int | None = None
    # Hardcore outcome: the turn that ended the run and what it was called, set when it happens.
    # `grade` is F for any run with a failure, however high its accuracy got before it.
    failed_turn: int | None = None
    failed_class: MoveClass | None = None
    verdict: str | None = None
    decision: Decision | None = None
    certainty: int | None = None
    # Archive: set = hidden from the history list, and NOTHING else. Still returned by
    # GET /interviews and still counted in the dashboard stats on purpose - unlike delete it is
    # reversible, and it exists to tidy the list, not to rewrite your record.
    archived_at: datetime | None = None

    @computed_field
    @property
    def grade(self) -> Grade | None:
        return rating.grade(self.accuracy, failed=self.failed_turn is not None)


# --- interview templates ---


class TemplateCreate(InterviewCreate):
    """A saved preset: a create body plus a name (inherits, so it cannot hold a knob a create rejects).

    Inherits `resume_id` on purpose: a preset saved from a resume-tailored setup that forgot the
    resume would silently interview against nothing."""

    name: str = Field(min_length=1, max_length=60)


class InterviewTemplate(TemplateCreate):
    id: str
    owner_id: str
    created_at: datetime
    updated_at: datetime


# --- resumes ---


class ResumeSummary(BaseModel):
    """One row of the resume library, WITHOUT its text.

    Deliberately tiny: `text` is up to MAX_CHARS, and a list that carried every resume body would be
    the per-row fan-out the rate-budget guardrail bans. `chars` is what the UI needs to explain a
    truncated import without fetching the text."""

    id: str
    name: str
    page_count: int
    chars: int
    created_at: datetime
    updated_at: datetime


class Resume(ResumeSummary):
    """One resume with its text: the editor's read, never the list's."""

    text: str


class ResumeCreate(BaseModel):
    """The write body for BOTH import paths: the pasted text, and the extracted text from a PDF.

    `max_length` is the same constant the extractor caps at and the DB CHECK enforces, imported rather
    than restated so the three cannot drift (the app/levels.py rule). It bounds the JSON body a client
    may hand us; note none of these caps bound what FastAPI has already buffered."""

    name: str = Field(min_length=1, max_length=80)
    text: str = Field(min_length=1, max_length=resumes.MAX_CHARS)


class ResumeExtract(BaseModel):
    """What a PDF gave us, before anyone decided to keep it. `truncated` covers the page cap, the
    character cap, and unreadable pages alike: all three mean "this is not the whole document"."""

    text: str
    pages: int
    truncated: bool


# --- messages ---


class Message(BaseModel):
    id: str
    interview_id: str
    role: str
    content: str
    # This turn's annotation (chess-style). None on interviewer/system turns and on ungraded runs.
    move_class: MoveClass | None = None
    # The annotator's note on that turn: why it got that class and what to fix. None wherever
    # move_class is None, and on turns the annotator classed without writing a usable note.
    comment: str | None = None
    created_at: datetime


# --- feedback ---


class FeedbackCreate(BaseModel):
    scores: dict = Field(default_factory=dict)
    verdict: str = Field(min_length=1, max_length=2000)
    tips: list = Field(default_factory=list)
    decision: Decision | None = None
    certainty: int | None = Field(default=None, ge=0, le=100)


class Feedback(BaseModel):
    id: str
    interview_id: str
    scores: dict
    verdict: str
    tips: list
    decision: Decision | None = None
    certainty: int | None = None
    accuracy: int | None = None
    # Carried from the interview row (main.get_feedback joins it) so the review can shout about a
    # hardcore failure without re-deriving it from the classes.
    failed_turn: int | None = None
    failed_class: MoveClass | None = None
    created_at: datetime

    @computed_field
    @property
    def grade(self) -> Grade | None:
        return rating.grade(self.accuracy, failed=self.failed_turn is not None)


# --- dashboard stats ---


class InterviewDimensions(BaseModel):
    """The dashboard radar in one aggregate (main.get_interview_dimensions): per-dimension averages
    over the rated runs, the newest run's scores, and how many runs those averages cover.

    Flat in size on purpose - the reader wanted 17 numbers, not one Feedback per run."""

    count: int
    averages: dict
    latest: dict


class AnalyticsRun(BaseModel):
    """One interview this owner created, as the analytics page reads it: pending, in-progress and
    finished runs all appear, because the page's activity strip and run log are about the practice
    history, not only the graded slice. Deliberately tiny: the charts need the shape of the history,
    not the transcripts behind it."""

    id: str
    role: str
    level: str
    status: str
    created_at: datetime
    accuracy: int | None = None
    grade: Grade | None = None
    decision: Decision | None = None
    certainty: int | None = None
    failed_class: MoveClass | None = None
    # The create knobs, carried so the run log can show what produced each row (and so a surprising
    # dial average above can be traced to the runs behind it). Dials has the vocabulary + defaults.
    dials: Dials = Field(default_factory=Dials)
    # NULL on an ungraded run (feedback.scores is NOT NULL, but the LEFT JOIN has no row): a run with
    # no review legitimately has no dimensions, and an empty dict is what "not assessed" reads as.
    scores: dict = Field(default_factory=dict)
    # Candidate turns in the run, and how the reviewer classed each one. `moves` holds only the
    # turns that got a class, so a run can legitimately report fewer moves than `turns`.
    turns: int = 0
    moves: dict[str, int] = Field(default_factory=dict)


class AnalyticsActivityWeek(BaseModel):
    """One ISO week of the activity chart. `started` counts every run created that week, `completed`
    the subset that finished: the gap between the two bars is runs begun and dropped, which is why
    they are drawn side by side rather than stacked."""

    week: str
    started: int
    completed: int


class AnalyticsDial(BaseModel):
    """One value of one create-dial, with the outcome of the runs created under it.

    Averaged over the runs that SCORED, same denominator honesty as the dashboard: a dial whose
    runs are all unrated reports `rated: 0` and a null accuracy, never a 0% that reads as failure."""

    key: str
    label: str
    runs: int
    rated: int
    avg_accuracy: float | None = None
    hire_rate: int | None = None


class Analytics(BaseModel):
    """Everything /stats/analytics answers, in one bounded payload (models.InterviewDimensions for
    the dashboard radar is the precedent: aggregate server-side, never fan out per run).

    All-time on purpose - a window is a product call, and the activity strip already shows WHEN."""

    runs: list[AnalyticsRun]
    activity: list[AnalyticsActivityWeek]
    # Move-class slug -> annotated-turn count across every run. Every class is present (0 when
    # unused) so the chart can render a fixed-strength-to-weakness axis without filling gaps.
    move_classes: dict[str, int]
    # Dial name -> its values, in the vocabulary's own order (app/dials.py, app/levels.py).
    dials: dict[str, list[AnalyticsDial]]
    total_turns: int
    # Consecutive UTC days ending today (or yesterday - a streak dies at midnight, not at 24h) with
    # at least one run created.
    streak_days: int
    hardcore_failures: int


# --- LLM context / feedback / chat-turn payloads ---


class ChatMessage(BaseModel):
    role: str
    content: str


class FeedbackSummary(BaseModel):
    """Structured LLM output for interview feedback (PRD §4.4).

    decision/certainty stay None when the model omitted or drifted the field: an undecided
    run is honest, a fabricated verdict is not."""

    scores: dict = Field(default_factory=dict)
    verdict: str
    tips: list = Field(default_factory=list)
    decision: Decision | None = None
    certainty: int | None = Field(default=None, ge=0, le=100)
    # 1-based candidate turn -> its annotation; empty when the model would not classify.
    moves: dict[int, rating.Move] = Field(default_factory=dict)


class ChatTurn(BaseModel):
    interview_id: str
    # The candidate's turn is the one unbounded blob that reaches the model, so cap it. Keep in step
    # with frontend/src/lib/api.ts MAX_TURN_CHARS — the two drifted once (12000 vs 4000).
    content: str = Field(min_length=1, max_length=8000)


# --- BYOK provider settings (app/byok.py; see BYOK.md) ---


class LLMProviderUpdate(BaseModel):
    """Write from the settings panel. `api_key` empty = keep the stored key, so base URL and
    model can be edited without re-pasting the secret."""

    base_url: str = Field(min_length=1, max_length=300)
    model: str = Field(min_length=1, max_length=200)
    api_key: str = Field(default="", max_length=500)


class SystemLLM(BaseModel):
    """The deployment's own provider, shown so "System default" says which model you'd get."""

    configured: bool
    base_url: str = ""
    model: str = ""


class ClientError(BaseModel):
    """Browser-error beacon, sent from every page. Capped because this is unauthenticated input
    heading straight for the log pipeline."""

    message: str = Field(min_length=1, max_length=300)
    route: str = Field(default="", max_length=200)
    # React's component names from an ErrorBoundary crash: the only stack that survives minification.
    component_stack: str = Field(default="", max_length=1000)


class LLMProvider(BaseModel):
    """BYOK status as the UI sees it: NEVER the key, only its last 4 characters as a hint."""

    enabled: bool
    byok: bool
    base_url: str = ""
    model: str = ""
    key_hint: str | None = None
    system: SystemLLM
