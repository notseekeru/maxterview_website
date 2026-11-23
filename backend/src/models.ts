import { z } from "zod";
import { COMPANY_SIZES, CYNICISM, DEPTHS } from "./dials.ts";
import { config } from "./env.ts";
import { LEVELS } from "./levels.ts";
import { GRADES, MOVE_CLASSES } from "./rating.ts";
import { CALLS, LINE_CALLS, LINE_MAX, NAME_MAX, SECTION_CALLS } from "./review.ts";

// Unpacked from the canonical vocabularies, so route, DB CHECK, prompt and frontend cannot drift.
export const Level = z.enum(LEVELS);
export type Level = z.infer<typeof Level>;

export const CompanySize = z.enum(COMPANY_SIZES);
export type CompanySize = z.infer<typeof CompanySize>;

export const Cynicism = z.enum(CYNICISM);
export type Cynicism = z.infer<typeof Cynicism>;

export const Depth = z.enum(DEPTHS);
export type Depth = z.infer<typeof Depth>;

// Hire/reject SPECTRUM, left to right. Shared by API validation, FEEDBACK_JSON_SCHEMA, DB CHECK (migration
// 0006) and the frontend badge. `certainty` is the separate axis: how well the transcript evidences the decision.
export const DECISIONS = ["reject", "lean_reject", "lean_hire", "hire"] as const;
export const Decision = z.enum(DECISIONS);
export type Decision = z.infer<typeof Decision>;

// The hiring end of that spectrum: the only calls that extend an offer. Spelled once, because the
// hire-rate column and the offer gate must agree on what counts as a hire.
export const HIRING_DECISIONS = ["hire", "lean_hire"] as const;

export const MoveClass = z.enum(MOVE_CLASSES);
export type MoveClass = z.infer<typeof MoveClass>;

export const Grade = z.enum(GRADES);
export type Grade = z.infer<typeof Grade>;

export const Call = z.enum(CALLS);
export type Call = z.infer<typeof Call>;

export const SectionCall = z.enum(SECTION_CALLS);
export type SectionCall = z.infer<typeof SectionCall>;

export const LineCall = z.enum(LINE_CALLS);
export type LineCall = z.infer<typeof LineCall>;

// Python serialized `datetime` as RFC 3339 with the offset; `Z` and `+00:00` both round-trip through new Date().
const DateTime = z.iso.datetime({ offset: true });

const Int = z.int();

// Python read resumes.MAX_CHARS and voice.MAX_TTS_CHARS once at import; both are config values, read here once for the same reason.
const ResumeText = z.string().min(1).max(config.resumeMaxChars);

export const ClerkUser = z.object({
    sub: z.string(),
    email: z.string().nullable().default(null),
    name: z.string().nullable().default(null),
    session_id: z.string().nullable().default(null),
    tier: z.string().default("free"),
});
export type ClerkUser = z.infer<typeof ClerkUser>;

export const Dials = z.object({
    company_size: CompanySize.default("any"),
    cynicism: Cynicism.default("neutral"),
    brutally_honest: z.boolean().default(false),
    human_mode: z.boolean().default(true),
    // Every answer judged as given; a FAIL_CLASSES rating ends the run on the spot. See main.send_turn.
    hardcore: z.boolean().default(false),
    depth: Depth.default("standard"),
});
export type Dials = z.infer<typeof Dials>;

export const InterviewCreate = Dials.extend({
    role: z.string().min(1).max(200),
    topic: z.string().max(500).default(""),
    level: Level.default("any"),
    // `uuid` in, `string` out: a malformed id 422s before the handler. Ownership is enforced in the INSERT, never by a pre-check.
    resume_id: z.uuid().nullable().default(null),
});
export type InterviewCreate = z.infer<typeof InterviewCreate>;

export const Interview = Dials.extend({
    id: z.string(),
    owner_id: z.string(),
    role: z.string(),
    level: z.string().default("any"),
    topic: z.string().default(""),
    resume_id: z.string().nullable().default(null),
    status: z.string(),
    created_at: DateTime,
    updated_at: DateTime,
    // 0-100 move-review accuracy (NOT a 1-10 average) plus letter grade; null until graded.
    accuracy: Int.nullable().default(null),
    // Hardcore outcome: the turn that ended the run and its class. `grade` is F for any run with a failure.
    failed_turn: Int.nullable().default(null),
    failed_class: MoveClass.nullable().default(null),
    verdict: z.string().nullable().default(null),
    decision: Decision.nullable().default(null),
    certainty: Int.nullable().default(null),
    // Set = hidden from the history list, NOTHING else: still returned by GET /interviews and still in the dashboard stats.
    archived_at: DateTime.nullable().default(null),
    grade: Grade.nullable(),
    plan: z.array(z.string()),
});
export type Interview = z.infer<typeof Interview>;

export const TemplateCreate = InterviewCreate.extend({
    name: z.string().min(1).max(60),
});
export type TemplateCreate = z.infer<typeof TemplateCreate>;

export const InterviewTemplate = TemplateCreate.extend({
    id: z.string(),
    owner_id: z.string(),
    created_at: DateTime,
    updated_at: DateTime,
});
export type InterviewTemplate = z.infer<typeof InterviewTemplate>;

export const ResumeSummary = z.object({
    id: z.string(),
    name: z.string(),
    page_count: Int,
    chars: Int,
    created_at: DateTime,
    updated_at: DateTime,
});
export type ResumeSummary = z.infer<typeof ResumeSummary>;

export const Resume = ResumeSummary.extend({
    text: z.string(),
});
export type Resume = z.infer<typeof Resume>;

export const ResumeCreate = z.object({
    name: z.string().min(1).max(80),
    text: ResumeText,
});
export type ResumeCreate = z.infer<typeof ResumeCreate>;

export const LatexSource = z.object({
    text: ResumeText,
});
export type LatexSource = z.infer<typeof LatexSource>;

export const ResumeExtract = z.object({
    text: z.string(),
    pages: Int,
    truncated: z.boolean(),
});
export type ResumeExtract = z.infer<typeof ResumeExtract>;

export const ReviewLevel = z.object({
    level: Level,
    call: Call,
    // What on the page decides the call, then the one edit that would raise it.
    thinks: z.string(),
    move: z.string(),
});
export type ReviewLevel = z.infer<typeof ReviewLevel>;

export const ReviewSection = z.object({
    // The block as the resume names it: a resume's own headings are the only reliable section labels.
    name: z.string().min(1).max(NAME_MAX),
    call: SectionCall,
    note: z.string(),
});
export type ReviewSection = z.infer<typeof ReviewSection>;

export const ReviewRewrite = z.object({
    // The line as it stands, and the line that replaces it. A bracketed slot marks the one fact only
    // the candidate can supply: the reviewer never invents one to fill it.
    source: z.string(),
    rewrite: z.string(),
});
export type ReviewRewrite = z.infer<typeof ReviewRewrite>;

export const ReviewLine = z.object({
    // A claim-bearing line, quoted as written so the editor can find it and paint it.
    text: z.string(),
    call: LineCall,
});
export type ReviewLine = z.infer<typeof ReviewLine>;

export const ReviewRewriteRequest = z.object({
    source: z.string().min(1).max(LINE_MAX),
});
export type ReviewRewriteRequest = z.infer<typeof ReviewRewriteRequest>;

export const ResumeReview = z.object({
    verdict: z.string(),
    levels: z.array(ReviewLevel),
    sections: z.array(ReviewSection),
    // Defaulted: reviews stored before these passes carry neither key.
    rewrites: z.array(ReviewRewrite).default([]),
    lines: z.array(ReviewLine).default([]),
    // True when the resume text changed after this review read it: the page still shows it, because the
    // advice is the work the candidate would otherwise lose, and the marks simply stop matching.
    stale: z.boolean().default(false),
    created_at: DateTime,
    reads_at: Level.nullable(),
});
export type ResumeReview = z.infer<typeof ResumeReview>;

export const VoiceCapability = z.object({
    tts: z.boolean(),
    stt: z.boolean(),
    tts_model: z.string().default(""),
    stt_model: z.string().default(""),
});
export type VoiceCapability = z.infer<typeof VoiceCapability>;

export const VoiceText = z.object({
    text: z.string().min(1).max(config.voiceMaxTtsChars),
});
export type VoiceText = z.infer<typeof VoiceText>;

export const VoiceTranscript = z.object({
    text: z.string(),
    segments: z.array(z.record(z.string(), z.unknown())).default([]),
    language: z.string().default(""),
});
export type VoiceTranscript = z.infer<typeof VoiceTranscript>;

// One classed turn: `cls` is a MoveClass the annotator coerced, `comment` its note. Python's NamedTuple,
// which the port reads as an object because a JSON array of two fields is unreadable at the call site.
export const Move = z.object({
    cls: z.string(),
    comment: z.string().nullable().default(null),
});
export type Move = z.infer<typeof Move>;

export const Message = z.object({
    id: z.string(),
    interview_id: z.string(),
    role: z.string(),
    content: z.string(),
    // This turn's annotation. None on interviewer/system turns and on ungraded runs.
    move_class: MoveClass.nullable().default(null),
    comment: z.string().nullable().default(null),
    created_at: DateTime,
});
export type Message = z.infer<typeof Message>;

export const FeedbackCreate = z.object({
    scores: z.record(z.string(), z.number()).default({}),
    verdict: z.string().min(1).max(2000),
    tips: z.array(z.string()).default([]),
    decision: Decision.nullable().default(null),
    certainty: Int.min(0).max(100).nullable().default(null),
});
export type FeedbackCreate = z.infer<typeof FeedbackCreate>;

export const Feedback = z.object({
    id: z.string(),
    interview_id: z.string(),
    scores: z.record(z.string(), z.number()),
    verdict: z.string(),
    tips: z.array(z.string()),
    decision: Decision.nullable().default(null),
    certainty: Int.nullable().default(null),
    accuracy: Int.nullable().default(null),
    // Carried from the interview row so the review can shout about a hardcore failure without re-deriving it.
    failed_turn: Int.nullable().default(null),
    failed_class: MoveClass.nullable().default(null),
    // Rebuilds already charged to this run; the tier's allowance is app/billing.py::redo_limit.
    redos: Int.default(0),
    created_at: DateTime,
    grade: Grade.nullable(),
});
export type Feedback = z.infer<typeof Feedback>;

export const AccuracyPoint = z.object({
    created_at: DateTime,
    accuracy: Int,
});
export type AccuracyPoint = z.infer<typeof AccuracyPoint>;

export const DashboardDims = z.object({
    total: Int,
    completed: Int,
    rated: Int,
    avg_accuracy: z.number(),
    accuracy_trend: z.array(AccuracyPoint),
    decided: Int,
    hiring: Int,
    avg_certainty: Int.nullable().default(null),
    week_runs: Int,
    prior_week_runs: Int,
    week_finished: Int,
    prior_week_finished: Int,
    streak: Int,
    last_run_days: Int.nullable().default(null),
    delta_accuracy: z.number().nullable().default(null),
    delta_hire: z.number().nullable().default(null),
    daily_runs: z.array(Int),
    daily_finished: z.array(Int),
    hire_spark: z.array(z.number()),
    count: Int,
    // Runs behind `recent`, never more than RECENT_WINDOW. Sent so the radar labels the series with the real window.
    recent_n: Int,
    averages: z.record(z.string(), z.number()),
    recent: z.record(z.string(), z.number()),
});
export type DashboardDims = z.infer<typeof DashboardDims>;

export const AnalyticsRun = z.object({
    id: z.string(),
    role: z.string(),
    level: z.string(),
    status: z.string(),
    created_at: DateTime,
    accuracy: Int.nullable().default(null),
    grade: Grade.nullable().default(null),
    decision: Decision.nullable().default(null),
    certainty: Int.nullable().default(null),
    failed_class: MoveClass.nullable().default(null),
    // Carried so the run log can show what produced each row, and a surprising dial average can be traced back.
    dials: Dials.prefault({}),
    // NULL on an ungraded run: no review legitimately means no dimensions, and `{}` is what not assessed reads as.
    scores: z.record(z.string(), z.number()).default({}),
    // `moves` holds only the turns that got a class, so a run can report fewer moves than turns.
    turns: Int.default(0),
    moves: z.record(z.string(), Int).default({}),
});
export type AnalyticsRun = z.infer<typeof AnalyticsRun>;

export const AnalyticsActivityWeek = z.object({
    week: z.string(),
    started: Int,
    completed: Int,
});
export type AnalyticsActivityWeek = z.infer<typeof AnalyticsActivityWeek>;

export const AnalyticsDial = z.object({
    key: z.string(),
    label: z.string(),
    runs: Int,
    rated: Int,
    avg_accuracy: z.number().nullable().default(null),
    hire_rate: Int.nullable().default(null),
});
export type AnalyticsDial = z.infer<typeof AnalyticsDial>;

export const OfferSummary = z.object({
    count: Int.default(0),
    avg_base: Int.default(0),
    median_base: Int.default(0),
    low_base: Int.default(0),
    high_base: Int.default(0),
    avg_total: Int.default(0),
    low_total: Int.default(0),
    high_total: Int.default(0),
    avg_signing: Int.default(0),
    avg_equity: Int.default(0),
    avg_performance: Int.default(0),
    avg_benefits: z.number().default(0),
    best_id: z.string().nullable().default(null),
    worst_id: z.string().nullable().default(null),
});
export type OfferSummary = z.infer<typeof OfferSummary>;

export const OfferBenefit = z.object({
    key: z.string(),
    label: z.string(),
    value: z.string(),
});
export type OfferBenefit = z.infer<typeof OfferBenefit>;

// One rung of the benefits ladder; `threshold` is the performance floor that grants it.
export interface Rung {
    key: string;
    label: string;
    threshold: number;
    value: string;
}

export const Offer = z.object({
    interview_id: z.string(),
    role: z.string(),
    level: z.string(),
    title: z.string(),
    band: z.string(),
    band_low: Int,
    band_high: Int,
    base_salary: Int,
    signing_bonus: Int,
    equity: Int,
    performance: Int,
    // Slug and label come from app/offer.py tier(); the frontend owns only the tone.
    tier: z.string(),
    tier_label: z.string(),
    benefits: z.array(OfferBenefit).default([]),
    // Joined from the review. Null when the feedback row is gone: a data-repair case, not a state.
    accuracy: Int.nullable().default(null),
    grade: Grade.nullable().default(null),
    decision: Decision.nullable().default(null),
    // When the letter was priced, which is also the date on the page.
    created_at: DateTime,
    starts_on: z.iso.date(),
    total_comp: Int,
});
export type Offer = z.infer<typeof Offer>;

// What offer.terms() prices: the row's id, dates and review join are filled in by the route, not here.
export type Terms = Pick<Offer, "title" | "band" | "base_salary" | "signing_bonus" | "equity" | "performance" | "benefits">;

export function totalComp(offer: Pick<Offer, "base_salary" | "equity">): number {
    return offer.base_salary + offer.equity;
}

export const OfferGroup = z.object({
    key: z.string(),
    label: z.string(),
    offers: Int,
    avg_base: Int,
    low_base: Int,
    high_base: Int,
    span: Int,
    avg_total: Int,
    avg_performance: Int,
});
export type OfferGroup = z.infer<typeof OfferGroup>;

export const OfferBenefitStat = z.object({
    key: z.string(),
    label: z.string(),
    offers: Int,
    // Out of every offer, so a rung nobody cleared reads 0%.
    rate: Int,
});
export type OfferBenefitStat = z.infer<typeof OfferBenefitStat>;

export const OfferMonth = z.object({
    month: z.string(),
    offers: Int,
    avg_base: Int,
});
export type OfferMonth = z.infer<typeof OfferMonth>;

export const OffersAnalytics = z.object({
    summary: OfferSummary,
    // Newest first, archived runs included: an issued offer does not stop existing when the run is tidied off the list.
    offers: z.array(Offer),
    // Both comparisons bucket the PRICED band, not the run's target level: `any` prices as mid, and a level row holding nothing would chart a dial nobody turned.
    by_level: z.array(OfferGroup),
    by_tier: z.array(OfferGroup),
    benefits: z.array(OfferBenefitStat),
    activity: z.array(OfferMonth),
});
export type OffersAnalytics = z.infer<typeof OffersAnalytics>;

export const Analytics = z.object({
    runs: z.array(AnalyticsRun),
    activity: z.array(AnalyticsActivityWeek),
    // Every class present (0 when unused) so the chart renders a fixed axis without filling gaps.
    move_classes: z.record(z.string(), Int),
    // Dial name -> its values, in the vocabulary's own order.
    dials: z.record(z.string(), z.array(AnalyticsDial)),
    total_turns: Int,
    // Consecutive UTC days ending today (or yesterday: a streak dies at midnight, not at 24h) with at least one run created.
    streak_days: Int,
    hardcore_failures: Int,
    offers: OffersAnalytics,
});
export type Analytics = z.infer<typeof Analytics>;

export const ChatMessage = z.object({
    role: z.string(),
    content: z.string(),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export const FeedbackSummary = z.object({
    scores: z.record(z.string(), z.number()).default({}),
    verdict: z.string(),
    tips: z.array(z.string()).default([]),
    decision: Decision.nullable().default(null),
    certainty: Int.min(0).max(100).nullable().default(null),
    // 1-based candidate turn -> its annotation; empty when the model would not classify.
    moves: z.record(z.string(), Move).default({}),
});
export type FeedbackSummary = z.infer<typeof FeedbackSummary>;

export const ChatTurn = z.object({
    interview_id: z.string(),
    // The candidate's turn is the one unbounded blob reaching the model, so cap it. Keep in step with frontend MAX_TURN_CHARS: the two drifted once.
    content: z.string().min(1).max(8000),
});
export type ChatTurn = z.infer<typeof ChatTurn>;

export const ClientError = z.object({
    message: z.string().min(1).max(300),
    route: z.string().max(200).default(""),
    // React's component names from an ErrorBoundary crash: the only stack that survives minification.
    component_stack: z.string().max(1000).default(""),
});
export type ClientError = z.infer<typeof ClientError>;
