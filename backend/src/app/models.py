from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, computed_field

from app import dials, levels, rating, resumes, voice

# Unpacked from the canonical levels vocabulary, so API, DB CHECK, prompt and frontend cannot drift.
Level = Literal[*levels.LEVELS]

# Unpacked from app/dials.py, same anti-drift rule as Level.
CompanySize = Literal[*dials.COMPANY_SIZES]
Cynicism = Literal[*dials.CYNICISM]

# Hire/reject SPECTRUM, left to right. Shared by API validation, FEEDBACK_JSON_SCHEMA, DB CHECK (migration 0006) and the frontend badge. `certainty` is the separate axis: how well the transcript evidences the decision.
DECISIONS: tuple[str, ...] = ("reject", "lean_reject", "lean_hire", "hire")
Decision = Literal[*DECISIONS]
# The hiring end of that spectrum: the only calls that extend an offer. Spelled once, because the hire-rate column and the offer gate must agree on what counts as a hire.
HIRING_DECISIONS: tuple[str, ...] = ("hire", "lean_hire")
# Chess-style review vocabulary, spelled once in app/rating.py (migration 0010's CHECK and the frontend labels derive from it).
MoveClass = Literal[*rating.MOVE_CLASSES]
Grade = Literal[*rating.GRADES]


class ClerkUser(BaseModel):
    """Authenticated identity. `sub` is the Clerk user id, scopes every query. `tier` is the monetization seam (D10): free/premium, `dev` only for the no-Clerk fallback identity."""

    sub: str
    email: str | None = None
    name: str | None = None
    session_id: str | None = None
    tier: str = "free"


class Dials(BaseModel):
    """Dressing knobs, shared by create + response so they cannot drift. Defaults are what an unspecified interview always got: neutral, human-sounding, two behavioural questions, as much technical ground as the mix allows. `brutally_honest` also reaches the grader."""

    company_size: CompanySize = "any"
    cynicism: Cynicism = "neutral"
    brutally_honest: bool = False
    human_mode: bool = True
    # Every answer judged as given; a FAIL_CLASSES rating ends the run on the spot. See main.chat_stream.
    hardcore: bool = False
    mix_chitchat: int = Field(default=0, ge=0, le=dials.MIX_MAX)
    mix_behavioural: int = Field(default=2, ge=0, le=dials.MIX_MAX)
    mix_technical: int = Field(default=dials.MIX_MAX, ge=0, le=dials.MIX_MAX)


class InterviewCreate(Dials):
    role: str = Field(min_length=1, max_length=200)
    topic: str = Field(default="", max_length=500)
    level: Level = "any"
    # `UUID` here, `str` out: a malformed id 422s before the handler. Ownership is enforced in the INSERT, never by a pre-check.
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
    # 0-100 move-review accuracy (NOT a 1-10 average) plus letter grade; null until graded.
    accuracy: int | None = None
    # Hardcore outcome: the turn that ended the run and its class. `grade` is F for any run with a failure.
    failed_turn: int | None = None
    failed_class: MoveClass | None = None
    verdict: str | None = None
    decision: Decision | None = None
    certainty: int | None = None
    # Set = hidden from the history list, NOTHING else: still returned by GET /interviews and still in the dashboard stats. Reversible on purpose.
    archived_at: datetime | None = None

    @computed_field
    @property
    def grade(self) -> Grade | None:
        return rating.grade(self.accuracy, failed=self.failed_turn is not None)


class TemplateCreate(InterviewCreate):
    """Saved preset: a create body plus a name. Inherits `resume_id` so a preset saved from a resume-tailored setup cannot silently forget the resume."""

    name: str = Field(min_length=1, max_length=60)


class InterviewTemplate(TemplateCreate):
    id: str
    owner_id: str
    created_at: datetime
    updated_at: datetime


class ResumeSummary(BaseModel):
    """One library row, WITHOUT its text. A list carrying every resume body would be the per-row fan-out the rate-budget guardrail bans. `chars` explains a truncated import without fetching text."""

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
    """Write body for both import paths: pasted text, and extracted text from a PDF. `max_length` is imported from the same constant the extractor caps at and the DB CHECK enforces. Bounds the JSON body a client may hand us, not what FastAPI already buffered."""

    name: str = Field(min_length=1, max_length=80)
    text: str = Field(min_length=1, max_length=resumes.MAX_CHARS)


class ResumeExtract(BaseModel):
    """What a PDF gave us, before anyone decided to keep it. `truncated` covers the page cap, the character cap and unreadable pages: all three mean not the whole document."""

    text: str
    pages: int
    truncated: bool


class VoiceCapability(BaseModel):
    """What this server can actually do, so the chat surface gates its controls on the truth rather than on a button that 503s."""

    tts: bool
    stt: bool
    tts_model: str = ""
    stt_model: str = ""


class VoiceText(BaseModel):
    """One line to speak. The client chunks at sentence boundaries, capping each at 140 characters, so this is a ceiling on a caller: what stands between a hostile body and the daily neuron budget."""

    text: str = Field(min_length=1, max_length=voice.MAX_TTS_CHARS)


class VoiceTranscript(BaseModel):
    """One take's text, plus the segment timings Whisper returns and the detected language. Nothing persisted: the text joins the answer box and the chat turn saves it. Timings unused today."""

    text: str
    segments: list[dict] = Field(default_factory=list)
    language: str = ""


class Message(BaseModel):
    id: str
    interview_id: str
    role: str
    content: str
    # This turn's annotation. None on interviewer/system turns and on ungraded runs.
    move_class: MoveClass | None = None
    # The annotator's note: why it got that class and what to fix. None wherever move_class is None.
    comment: str | None = None
    created_at: datetime


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
    # Carried from the interview row so the review can shout about a hardcore failure without re-deriving it.
    failed_turn: int | None = None
    failed_class: MoveClass | None = None
    # Rebuilds already charged to this run; the tier's allowance is app/billing.py::redo_limit.
    redos: int = 0
    created_at: datetime

    @computed_field
    @property
    def grade(self) -> Grade | None:
        return rating.grade(self.accuracy, failed=self.failed_turn is not None)


class InterviewDimensions(BaseModel):
    """The radar in one aggregate: per-dim averages over rated runs, the same over the newest few, and the run counts behind each. Flat in size on purpose."""

    count: int
    # Runs behind `recent`, never more than RECENT_WINDOW. Sent so the radar labels the series with the real window.
    recent_n: int
    averages: dict
    recent: dict


class AnalyticsRun(BaseModel):
    """One run as the analytics page reads it: pending, in-progress and finished all appear. Tiny on purpose: the charts need the history's shape, not the transcripts."""

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
    # Carried so the run log can show what produced each row, and a surprising dial average can be traced back.
    dials: Dials = Field(default_factory=Dials)
    # NULL on an ungraded run: no review legitimately means no dimensions, and `{}` is what not assessed reads as.
    scores: dict = Field(default_factory=dict)
    # `moves` holds only the turns that got a class, so a run can report fewer moves than turns.
    turns: int = 0
    moves: dict[str, int] = Field(default_factory=dict)


class AnalyticsActivityWeek(BaseModel):
    """One ISO week. `started` counts every run created, `completed` the subset that finished. The gap is runs begun and dropped, which is why the bars sit side by side."""

    week: str
    started: int
    completed: int


class AnalyticsDial(BaseModel):
    """One value of one create-dial. Averaged over the runs that SCORED: a dial whose runs are all unrated reports `rated: 0` and a null accuracy, never 0%."""

    key: str
    label: str
    runs: int
    rated: int
    avg_accuracy: float | None = None
    hire_rate: int | None = None


class OfferSummary(BaseModel):
    """Headline numbers over every offer issued. Means with the median beside them: a handful of offers means one top-of-band letter drags the mean. `best_id`/`worst_id` name the runs behind the extremes. Every field defaults to 0 so the page branches on `count` alone."""

    count: int = 0
    avg_base: int = 0
    median_base: int = 0
    low_base: int = 0
    high_base: int = 0
    avg_total: int = 0
    low_total: int = 0
    high_total: int = 0
    avg_signing: int = 0
    avg_equity: int = 0
    avg_performance: int = 0
    # Benefits per offer, so the ladder filling up is a number rather than a feeling.
    avg_benefits: float = 0.0
    best_id: str | None = None
    worst_id: str | None = None


class OfferBenefit(BaseModel):
    """One granted benefit with the letter's own wording. app/offer.py writes both, so the frontend renders a benefit rather than composing one."""

    key: str
    label: str
    value: str


class Offer(BaseModel):
    """One issued offer joined to the run and review that earned it. `band_low`/`band_high` are the edges `base_salary` sits in, so the frontend owns no copy of the rate card."""

    interview_id: str
    role: str
    level: str
    title: str
    band: str
    band_low: int
    band_high: int
    base_salary: int
    signing_bonus: int
    equity: int
    performance: int
    # Slug and label come from app/offer.py tier(); the frontend owns only the tone.
    tier: str
    tier_label: str
    benefits: list[OfferBenefit] = Field(default_factory=list)
    # Joined from the review. Null when the feedback row is gone: a data-repair case, not a state.
    accuracy: int | None = None
    grade: Grade | None = None
    decision: Decision | None = None
    # When the letter was priced, which is also the date on the page.
    created_at: datetime
    starts_on: date

    @computed_field
    @property
    def total_comp(self) -> int:
        """Annual, deliberately WITHOUT the signing bonus: averaging a one-time payment into a yearly
        number is how a $20k bonus reads as a $20k raise."""
        return self.base_salary + self.equity


class OfferGroup(BaseModel):
    """One bucket of a comparison: the offers under it and their spread. `span` precomputed because the page draws a RANGE bar, the only honest way to show a two-offer average."""

    key: str
    label: str
    offers: int
    avg_base: int
    low_base: int
    high_base: int
    span: int
    avg_total: int
    avg_performance: int


class OfferBenefitStat(BaseModel):
    """One rung of the benefit ladder. The FULL ladder comes back, unearned rungs at 0: a rung that vanished would read as a rung that does not exist."""

    key: str
    label: str
    offers: int
    # Out of every offer, so a rung nobody cleared reads 0%.
    rate: int


class OfferMonth(BaseModel):
    """One calendar month of the offer trend, oldest first."""

    month: str
    offers: int
    avg_base: int


class OffersAnalytics(BaseModel):
    """The offers half of the payload. Its own model because the page renders it as its own section, and GET /interviews/{id}/offer reuses models.Offer."""

    summary: OfferSummary
    # Newest first, archived runs included: an issued offer does not stop existing when the run is tidied off the list.
    offers: list[Offer]
    # Both comparisons bucket the PRICED band, not the run's target level: `any` prices as mid, and a level row holding nothing would chart a dial nobody turned.
    by_level: list[OfferGroup]
    by_tier: list[OfferGroup]
    benefits: list[OfferBenefitStat]
    activity: list[OfferMonth]


class Analytics(BaseModel):
    """Everything /stats/analytics answers, in one bounded payload: aggregate server-side, never fan out per run. All-time on purpose, a window is a product call."""

    runs: list[AnalyticsRun]
    activity: list[AnalyticsActivityWeek]
    # Every class present (0 when unused) so the chart renders a fixed axis without filling gaps.
    move_classes: dict[str, int]
    # Dial name -> its values, in the vocabulary's own order.
    dials: dict[str, list[AnalyticsDial]]
    total_turns: int
    # Consecutive UTC days ending today (or yesterday: a streak dies at midnight, not at 24h) with at least one run created.
    streak_days: int
    hardcore_failures: int
    # Nested rather than spread because the offline halves of the page do not need it, and the chat's review fetches its letter from its own route.
    offers: OffersAnalytics


class ChatMessage(BaseModel):
    role: str
    content: str


class FeedbackSummary(BaseModel):
    """Structured LLM output (PRD 4.4). decision/certainty stay None when the model omitted or drifted: an undecided run is honest, a fabricated verdict is not."""

    scores: dict = Field(default_factory=dict)
    verdict: str
    tips: list = Field(default_factory=list)
    decision: Decision | None = None
    certainty: int | None = Field(default=None, ge=0, le=100)
    # 1-based candidate turn -> its annotation; empty when the model would not classify.
    moves: dict[int, rating.Move] = Field(default_factory=dict)


class ChatTurn(BaseModel):
    interview_id: str
    # The candidate's turn is the one unbounded blob reaching the model, so cap it. Keep in step with frontend MAX_TURN_CHARS: the two drifted once.
    content: str = Field(min_length=1, max_length=8000)


# --- BYOK provider settings (app/byok.py; see BYOK.md) ---


class LLMProviderUpdate(BaseModel):
    """Write from the settings panel. `api_key` empty = keep the stored key, so base URL and model stay editable without re-pasting."""

    base_url: str = Field(min_length=1, max_length=300)
    model: str = Field(min_length=1, max_length=200)
    api_key: str = Field(default="", max_length=500)


class SystemLLM(BaseModel):
    """The deployment's own provider, shown so System default says which model you would get."""

    configured: bool
    base_url: str = ""
    model: str = ""


class ClientError(BaseModel):
    """Browser-error beacon, sent from every page. Capped: unauthenticated input heading straight for the log pipeline."""

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
