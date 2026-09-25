from datetime import date, datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, computed_field

from app import dials, levels, rating, resumes, voice

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
# The hiring end of that spectrum: the only calls that extend an offer (app/offer.py prices the letter,
# main._sync_offer decides whether one exists at all). Spelled once because the hire-rate column on the
# analytics page and the offer gate have to agree on what counts as a hire.
HIRING_DECISIONS: tuple[str, ...] = ("hire", "lean_hire")
# Chess-style review vocabulary, spelled once in app/rating.py (migration 0010's CHECK and the
# frontend labels derive from the same words).
MoveClass = Literal[*rating.MOVE_CLASSES]
Grade = Literal[*rating.GRADES]


class ClerkUser(BaseModel):
    """Authenticated identity — `sub` is the Clerk user id, scopes every query.

    `tier` is the monetization seam (D10): free/premium; `dev` applies for the
    no-Clerk dev-fallback identity. Resolved by `billing.resolve_tier`."""

    sub: str
    email: str | None = None
    name: str | None = None
    session_id: str | None = None
    tier: str = "free"


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
    # Hardcore: every answer is judged as it is given, and a failing class (rating.FAIL_CLASSES) ends
    # the run on the spot with a shout, then the feedback in caps. See main.chat_stream.
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


class VoiceCapability(BaseModel):
    """What this server can actually do, so the chat surface gates its controls on the truth rather than
    on a button that 503s. One engine means one boolean pair, not a preference."""

    tts: bool
    stt: bool
    tts_model: str = ""
    stt_model: str = ""


class VoiceText(BaseModel):
    """One line to speak. The client chunks at sentence boundaries and caps each chunk at 140
    characters, so this is a ceiling on a caller rather than a limit anyone meets: it is what stands
    between a hostile body and the daily neuron budget. Imported from app/voice.py, never restated."""

    text: str = Field(min_length=1, max_length=voice.MAX_TTS_CHARS)


class VoiceTranscript(BaseModel):
    """One take's text, plus the segment timings Whisper actually returns (start/end per phrase) and the
    language it detected. Nothing here is persisted: the text joins the answer box, and the chat turn
    is what saves it. Timings are unused today; they are what pace and pause numbers will read."""

    text: str
    segments: list[dict] = Field(default_factory=list)
    language: str = ""


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


class InterviewDimensions(BaseModel):
    """The dashboard radar in one aggregate (main.get_interview_dimensions): per-dimension averages
    over the rated runs, the same averages over just the newest few, and the run counts behind each.

    Flat in size on purpose - the radar wanted a couple dozen numbers, not one Feedback per run."""

    count: int
    # Runs behind `recent`; never more than main.RECENT_WINDOW. Sent so the radar can label the series
    # with the real window instead of owning a second copy of the number.
    recent_n: int
    averages: dict
    recent: dict


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


class OfferSummary(BaseModel):
    """Headline numbers over every offer this owner has been issued.

    Means, with the median beside them: a personal history is a handful of offers, and one top-of-band
    letter drags a two-offer mean somewhere the candidate never was. `best_id`/`worst_id` name the runs
    behind the extremes so the letter view can open the actual letter.

    Every field defaults to 0 so the empty case is `OfferSummary(count=0)` and the page branches on
    `count` alone."""

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
    # Benefits per offer, so "the ladder is filling up" is a number rather than a feeling.
    avg_benefits: float = 0.0
    best_id: str | None = None
    worst_id: str | None = None


class OfferBenefit(BaseModel):
    """One granted benefit, with the letter's own wording for what it is worth. app/offer.py writes
    both, so the frontend renders a benefit instead of composing one."""

    key: str
    label: str
    value: str


class Offer(BaseModel):
    """One issued offer, joined to the run and review that earned it: one page-ready row.

    `band_low`/`band_high` are the edges of the band `base_salary` sits in, so the letter can show
    where the offer landed without the frontend owning a second copy of the rate card."""

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
    # Slug + label come from app/offer.py's tier(); the frontend owns only the tone it paints them in.
    tier: str
    tier_label: str
    benefits: list[OfferBenefit] = Field(default_factory=list)
    # Joined from the review, so an offer can be read against the interview behind it. Null when the
    # feedback row is gone (the offer is priced from it, so this is a data-repair case, not a state).
    accuracy: int | None = None
    grade: Grade | None = None
    decision: Decision | None = None
    # When the letter was priced, which is also the date on the page (no second copy of it).
    created_at: datetime
    starts_on: date

    @computed_field
    @property
    def total_comp(self) -> int:
        """Annual, deliberately WITHOUT the signing bonus: averaging a one-time payment into a yearly
        number is how a $20k bonus reads as a $20k raise."""
        return self.base_salary + self.equity


class OfferGroup(BaseModel):
    """One bucket of a comparison (by level, by tier): the offers under it and their spread.

    `span` is `high - low` precomputed because the page draws a RANGE bar: a transparent low bar with
    the span stacked on it, which is the only honest way to show a two-offer average as a range."""

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
    """One rung of the benefit ladder across every offer: how many cleared it.

    The FULL ladder comes back, unearned rungs included at 0: the climb is the point, and a rung that
    silently vanished would read as a rung that does not exist."""

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
    """The offers half of the analytics payload: what the simulated letters say.

    Its own model rather than flat fields on Analytics because the analytics page renders it as its own
    section, and because the per-run letter (GET /interviews/{id}/offer) reuses models.Offer."""

    summary: OfferSummary
    # Newest first, archived runs included - an offer already issued does not stop existing because the
    # run was tidied off the history list.
    offers: list[Offer]
    # Both comparisons bucket the PRICED band, not the run's target level: `any` prices as mid, and a
    # level row holding nothing would be a chart of a dial nobody turned.
    by_level: list[OfferGroup]
    by_tier: list[OfferGroup]
    benefits: list[OfferBenefitStat]
    activity: list[OfferMonth]


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
    # The letters themselves. Nested rather than spread over this model because the offline halves of
    # the page (practice, decisions, runs) do not need any of it, and the chat's review fetches the
    # one letter it shows from its own route.
    offers: OffersAnalytics


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
