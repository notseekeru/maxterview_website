from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, computed_field

from app import dials, levels, rating, resumes, review, voice

# Unpacked from the canonical levels vocabulary, so API, DB CHECK, prompt and frontend cannot drift.
Level = Literal[*levels.LEVELS]

CompanySize = Literal[*dials.COMPANY_SIZES]
Cynicism = Literal[*dials.CYNICISM]
Depth = Literal[*dials.DEPTHS]

# Hire/reject SPECTRUM, left to right. Shared by API validation, FEEDBACK_JSON_SCHEMA, DB CHECK (migration 0006) and the frontend badge. `certainty` is the separate axis: how well the transcript evidences the decision.
DECISIONS: tuple[str, ...] = ("reject", "lean_reject", "lean_hire", "hire")
Decision = Literal[*DECISIONS]
# The hiring end of that spectrum: the only calls that extend an offer. Spelled once, because the hire-rate column and the offer gate must agree on what counts as a hire.
HIRING_DECISIONS: tuple[str, ...] = ("hire", "lean_hire")
# Chess-style review vocabulary, spelled once in app/rating.py (migration 0010's CHECK and the frontend labels derive from it).
MoveClass = Literal[*rating.MOVE_CLASSES]
Grade = Literal[*rating.GRADES]


class ClerkUser(BaseModel):
    sub: str
    email: str | None = None
    name: str | None = None
    session_id: str | None = None
    tier: str = "free"


class Dials(BaseModel):
    company_size: CompanySize = "any"
    cynicism: Cynicism = "neutral"
    brutally_honest: bool = False
    human_mode: bool = True
    # Every answer judged as given; a FAIL_CLASSES rating ends the run on the spot. See main.chat_stream.
    hardcore: bool = False
    depth: Depth = "standard"


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

    # The arc this run follows, so the client renders phases instead of restating their shape.
    @computed_field
    @property
    def plan(self) -> list[str]:
        return list(dials.plan_phases(self.depth))


class TemplateCreate(InterviewCreate):
    name: str = Field(min_length=1, max_length=60)


class InterviewTemplate(TemplateCreate):
    id: str
    owner_id: str
    created_at: datetime
    updated_at: datetime


class ResumeSummary(BaseModel):
    id: str
    name: str
    page_count: int
    chars: int
    created_at: datetime
    updated_at: datetime


class Resume(ResumeSummary):
    text: str


class ResumeCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    text: str = Field(min_length=1, max_length=resumes.MAX_CHARS)


class LatexSource(BaseModel):
    text: str = Field(min_length=1, max_length=resumes.MAX_CHARS)


class ResumeExtract(BaseModel):
    text: str
    pages: int
    truncated: bool


Call = Literal[*review.CALLS]
SectionCall = Literal[*review.SECTION_CALLS]
LineCall = Literal[*review.LINE_CALLS]


class ReviewLevel(BaseModel):
    level: Level
    call: Call
    # What on the page decides the call, then the one edit that would raise it.
    thinks: str
    move: str


class ReviewSection(BaseModel):
    # The block as the resume names it: a resume's own headings are the only reliable section labels.
    name: str = Field(min_length=1, max_length=review.NAME_MAX)
    call: SectionCall
    note: str


class ReviewRewrite(BaseModel):
    # The line as it stands, and the line that replaces it. A bracketed slot marks the one fact only
    # the candidate can supply: the reviewer never invents one to fill it.
    source: str
    rewrite: str


class ReviewLine(BaseModel):
    # A claim-bearing line, quoted as written so the editor can find it and paint it.
    text: str
    call: LineCall


class ReviewRewriteRequest(BaseModel):
    source: str = Field(min_length=1, max_length=review.LINE_MAX)


class ResumeReview(BaseModel):
    verdict: str
    levels: list[ReviewLevel]
    sections: list[ReviewSection]
    # Defaulted: reviews stored before these passes carry neither key.
    rewrites: list[ReviewRewrite] = Field(default_factory=list)
    lines: list[ReviewLine] = Field(default_factory=list)
    # True when the resume text changed after this review read it: the page still shows it, because the
    # advice is the work the candidate would otherwise lose, and the marks simply stop matching.
    stale: bool = False
    created_at: datetime

    @computed_field
    @property
    def reads_at(self) -> str | None:
        return review.reads_at((level.level, level.call) for level in self.levels)


class VoiceCapability(BaseModel):
    tts: bool
    stt: bool
    tts_model: str = ""
    stt_model: str = ""


class VoiceText(BaseModel):
    text: str = Field(min_length=1, max_length=voice.MAX_TTS_CHARS)


class VoiceTranscript(BaseModel):
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


class AccuracyPoint(BaseModel):
    created_at: datetime
    accuracy: int


class DashboardDims(BaseModel):
    total: int
    completed: int
    rated: int
    avg_accuracy: float
    accuracy_trend: list[AccuracyPoint]
    decided: int
    hiring: int
    avg_certainty: int | None = None
    week_runs: int
    prior_week_runs: int
    week_finished: int
    prior_week_finished: int
    streak: int
    last_run_days: int | None = None
    delta_accuracy: float | None = None
    delta_hire: float | None = None
    daily_runs: list[int]
    daily_finished: list[int]
    hire_spark: list[float]
    count: int
    # Runs behind `recent`, never more than RECENT_WINDOW. Sent so the radar labels the series with the real window.
    recent_n: int
    averages: dict
    recent: dict


class AnalyticsRun(BaseModel):
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
    week: str
    started: int
    completed: int


class AnalyticsDial(BaseModel):
    key: str
    label: str
    runs: int
    rated: int
    avg_accuracy: float | None = None
    hire_rate: int | None = None


class OfferSummary(BaseModel):
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
    avg_benefits: float = 0.0
    best_id: str | None = None
    worst_id: str | None = None


class OfferBenefit(BaseModel):
    key: str
    label: str
    value: str


class Offer(BaseModel):
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
        return self.base_salary + self.equity


class OfferGroup(BaseModel):
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
    key: str
    label: str
    offers: int
    # Out of every offer, so a rung nobody cleared reads 0%.
    rate: int


class OfferMonth(BaseModel):
    month: str
    offers: int
    avg_base: int


class OffersAnalytics(BaseModel):
    summary: OfferSummary
    # Newest first, archived runs included: an issued offer does not stop existing when the run is tidied off the list.
    offers: list[Offer]
    # Both comparisons bucket the PRICED band, not the run's target level: `any` prices as mid, and a level row holding nothing would chart a dial nobody turned.
    by_level: list[OfferGroup]
    by_tier: list[OfferGroup]
    benefits: list[OfferBenefitStat]
    activity: list[OfferMonth]


class Analytics(BaseModel):
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
    offers: OffersAnalytics


class ChatMessage(BaseModel):
    role: str
    content: str


class FeedbackSummary(BaseModel):
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


# BYOK provider settings; app/byok.py owns the policy.


class LLMProviderUpdate(BaseModel):
    base_url: str = Field(min_length=1, max_length=300)
    model: str = Field(min_length=1, max_length=200)
    api_key: str = Field(default="", max_length=500)


class SystemLLM(BaseModel):
    configured: bool
    base_url: str = ""
    model: str = ""


class ClientError(BaseModel):
    message: str = Field(min_length=1, max_length=300)
    route: str = Field(default="", max_length=200)
    # React's component names from an ErrorBoundary crash: the only stack that survives minification.
    component_stack: str = Field(default="", max_length=1000)


class LLMProvider(BaseModel):
    enabled: bool
    byok: bool
    base_url: str = ""
    model: str = ""
    key_hint: str | None = None
    system: SystemLLM
