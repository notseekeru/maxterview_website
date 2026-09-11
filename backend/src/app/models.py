from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app import levels

# Level slugs accepted on create, unpacked from the canonical levels vocabulary so the
# API, DB CHECK, prompt, and frontend can never drift (see app/levels.py).
Level = Literal[*levels.LEVELS]

# Post-interview hire/reject SPECTRUM, left to right. Canonical slugs shared by the API
# validation, the LLM JSON schema (llm.FEEDBACK_JSON_SCHEMA), the DB CHECK (migration
# 0006), and the frontend badge. `certainty` (0-100) is the SEPARATE axis: how well the
# transcript evidences the decision, not how positive it is.
DECISIONS: tuple[str, ...] = ("reject", "lean_reject", "lean_hire", "hire")
Decision = Literal[*DECISIONS]


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


class InterviewCreate(BaseModel):
    role: str = Field(min_length=1, max_length=200)
    topic: str = Field(default="", max_length=500)
    level: Level = "any"


class Interview(BaseModel):
    id: str
    owner_id: str
    role: str
    level: str = "any"
    topic: str = ""
    status: str
    created_at: datetime
    updated_at: datetime
    score: float | None = None
    verdict: str | None = None
    decision: Decision | None = None
    certainty: int | None = None


# --- messages ---


class Message(BaseModel):
    id: str
    interview_id: str
    role: str
    content: str
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
    created_at: datetime


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


class ChatTurn(BaseModel):
    interview_id: str
    content: str
