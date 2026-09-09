from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app import levels

# Level slugs accepted on create, unpacked from the canonical levels vocabulary so the
# API, DB CHECK, prompt, and frontend can never drift (see app/levels.py).
Level = Literal[*levels.LEVELS]


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
    # Optional score/verdict for the interview-list view (US5): null if no feedback yet.
    score: float | None = None
    verdict: str | None = None


# --- messages ---


class Message(BaseModel):
    id: str
    interview_id: str
    role: str  # user | assistant | system
    content: str
    created_at: datetime


# --- feedback ---


class FeedbackCreate(BaseModel):
    """Payload to write a feedback row (scored by the LLM feedback generator)."""

    scores: dict = Field(default_factory=dict)
    verdict: str = Field(min_length=1, max_length=2000)
    tips: list = Field(default_factory=list)


class Feedback(BaseModel):
    id: str
    interview_id: str
    scores: dict
    verdict: str
    tips: list
    created_at: datetime


# --- LLM context / feedback / chat-turn payloads ---


class ChatMessage(BaseModel):
    """One message in the conversation context sent to the LLM."""

    role: str  # user | assistant | system
    content: str


class FeedbackSummary(BaseModel):
    """Structured LLM output for interview feedback (PRD §4.4)."""

    scores: dict = Field(default_factory=dict)
    verdict: str
    tips: list = Field(default_factory=list)


class ChatTurn(BaseModel):
    """One user turn in a simulated interview; the SSE endpoint streams the assistant reply."""

    interview_id: str
    content: str
