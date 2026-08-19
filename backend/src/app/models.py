from datetime import datetime

from pydantic import BaseModel, Field


class ClerkUser(BaseModel):
    """Authenticated identity — `sub` is the Clerk user id, scopes every query (D4).

    `tier` is a monetization seam (D10): free/premium. Used for gating post-MVP;
    billing engine itself is phase 2 (M10), not built in MVP.
    """

    sub: str
    email: str | None = None
    name: str | None = None
    session_id: str | None = None
    tier: str = "free"


# --- interviews ---


class InterviewCreate(BaseModel):
    role: str = Field(min_length=1, max_length=200)
    topic: str = Field(default="", max_length=500)


class Interview(BaseModel):
    id: str
    owner_id: str
    role: str
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
    """Payload to write a feedback row (M6 LLM handler calls this after generating scores)."""

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


# --- SSE stub payload (M6 wires the real LLM stream) ---


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
