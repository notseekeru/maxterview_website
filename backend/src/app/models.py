from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, computed_field

from app import dials, levels, rating

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


class Interview(Dials):
    id: str
    owner_id: str
    role: str
    level: str = "any"
    topic: str = ""
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
    """A saved preset: a create body plus a name (inherits, so it cannot hold a knob a create rejects)."""

    name: str = Field(min_length=1, max_length=60)


class InterviewTemplate(TemplateCreate):
    id: str
    owner_id: str
    created_at: datetime
    updated_at: datetime


# --- messages ---


class Message(BaseModel):
    id: str
    interview_id: str
    role: str
    content: str
    # This turn's annotation (chess-style). None on interviewer/system turns and on ungraded runs.
    move_class: MoveClass | None = None
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
    # 1-based candidate turn -> move class; empty when the model would not classify.
    moves: dict[int, str] = Field(default_factory=dict)


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


class LLMProvider(BaseModel):
    """BYOK status as the UI sees it: NEVER the key, only its last 4 characters as a hint."""

    enabled: bool
    byok: bool
    base_url: str = ""
    model: str = ""
    key_hint: str | None = None
    system: SystemLLM
