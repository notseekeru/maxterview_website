import axios, { type AxiosError } from "axios";

import { markAuthGate401 } from "./authHealth";

const BASE = `${import.meta.env.VITE_API_BASE ?? "/api"}`;

export const api = axios.create({
    baseURL: BASE,
    withCredentials: true, // send __session cookie for Clerk auth
});

api.interceptors.response.use(
    (r) => r,
    (err) => {
        const d = err.response?.data as { detail?: string } | undefined;
        if (err.response?.status === 401 && d?.detail === "Missing credentials") markAuthGate401();
        return Promise.reject(err);
    },
);

export function httpStatus(e: unknown): number | undefined {
    return (e as AxiosError)?.response?.status ?? (e as { status?: number })?.status;
}

// A 402 signals a quota lockout (daily chat-turn cap).
export function isQuotaError(e: unknown): boolean {
    return (e as AxiosError)?.response?.status === 402;
}

// FastAPI's `detail` is written for this UI, so prefer it over a generic message. A 422 is the
// exception: pydantic sends a LIST of field errors, which a string-only read drops into the fallback.
export function apiDetail(e: unknown, fallback: string | null = null): string | null {
    const d = (e as AxiosError<{ detail?: string | { loc?: (string | number)[]; msg?: string }[] }>)?.response?.data?.detail;
    if (typeof d === "string" && d) return d;
    const first = Array.isArray(d) ? d[0] : undefined;
    if (typeof first?.msg === "string" && first.msg) {
        const field = (first.loc ?? []).filter((p) => p !== "body").join(".");
        return field ? `${field}: ${first.msg}` : first.msg;
    }
    return fallback;
}

export interface Interview extends InterviewDials {
    id: string;
    owner_id: string;
    role: string;
    level: string;
    topic?: string;
    status: "pending" | "in_progress" | "completed";
    created_at: string;
    updated_at: string;
    accuracy?: number | null;
    grade?: Grade | null;
    failed_turn?: number | null;
    failed_class?: MoveClass | null;
    verdict?: string | null;
    decision?: Decision | null;
    certainty?: number | null;
    resume_id?: string | null;
    archived_at?: string | null;
    // The arc this run follows, one entry per interviewer turn. Backend app/dials.py owns it.
    plan: string[];
}

// Dials, mirroring backend app/models.Dials. Depth picks which of the structured interview arcs the run
// follows; the arc itself lives in backend app/llm.py.
export type CompanySize = "any" | "1-10" | "11-50" | "51-200" | "201-1k" | "1k-5k" | "5k+";
export type Cynicism = "kind" | "neutral" | "skeptical";
export type Depth = "screen" | "standard" | "full";

export interface InterviewDials {
    company_size: CompanySize;
    cynicism: Cynicism;
    brutally_honest: boolean;
    human_mode: boolean;
    hardcore: boolean;
    depth: Depth;
}

interface InterviewInput extends InterviewDials {
    role: string;
    topic?: string;
    level: string;
    resume_id?: string | null;
}

export async function createInterview(input: InterviewInput): Promise<Interview> {
    const { data } = await api.post<Interview>("/interviews", input);
    return data;
}

export interface InterviewTemplate extends InterviewInput {
    id: string;
    name: string;
    owner_id: string;
    created_at: string;
    updated_at: string;
}

export type TemplateInput = InterviewInput & { name: string };

export async function listTemplates(): Promise<InterviewTemplate[]> {
    const { data } = await api.get<InterviewTemplate[]>("/templates");
    return data;
}

export async function createTemplate(input: TemplateInput): Promise<InterviewTemplate> {
    const { data } = await api.post<InterviewTemplate>("/templates", input);
    return data;
}

export async function updateTemplate(id: string, input: TemplateInput): Promise<InterviewTemplate> {
    const { data } = await api.put<InterviewTemplate>(`/templates/${id}`, input);
    return data;
}

export async function deleteTemplate(id: string): Promise<void> {
    await api.delete(`/templates/${id}`);
}

// Resumes: an interview or preset holds `resume_id`.

export interface ResumeSummary {
    id: string;
    name: string;
    page_count: number;
    chars: number;
    created_at: string;
    updated_at: string;
}

export interface Resume extends ResumeSummary {
    text: string;
}

interface ResumeInput {
    name: string;
    text: string;
}

interface ResumeExtract {
    text: string;
    pages: number;
    truncated: boolean;
}

export async function listResumes(): Promise<ResumeSummary[]> {
    const { data } = await api.get<ResumeSummary[]>("/resumes");
    return data;
}

export async function getResume(id: string): Promise<Resume> {
    const { data } = await api.get<Resume>(`/resumes/${id}`);
    return data;
}

export async function extractResume(file: File): Promise<ResumeExtract> {
    const form = new FormData();
    form.append("file", file);
    // No manual Content-Type: the browser sets it WITH the multipart boundary, and overriding it
    // without one makes the server reject the body.
    const { data } = await api.post<ResumeExtract>("/resumes/extract", form);
    return data;
}

export async function createResume(input: ResumeInput): Promise<Resume> {
    const { data } = await api.post<Resume>("/resumes", input);
    return data;
}

export async function updateResume(id: string, input: ResumeInput): Promise<Resume> {
    const { data } = await api.put<Resume>(`/resumes/${id}`, input);
    return data;
}

export async function deleteResume(id: string): Promise<void> {
    await api.delete(`/resumes/${id}`);
}

// A review is derived from the resume's text: the server retires it when the text changes, so null
// here means "no review of what is on the page right now".

export type ReviewCall = "passes" | "close" | "fails";
export type SectionCall = "strong" | "fine" | "weak" | "bloat";

interface ReviewLevel {
    level: string;
    call: ReviewCall;
    thinks: string;
    move: string;
}

interface ReviewSection {
    name: string;
    call: SectionCall;
    note: string;
}

export interface ReviewRewrite {
    source: string;
    rewrite: string;
}

export interface ResumeReview {
    verdict: string;
    levels: ReviewLevel[];
    sections: ReviewSection[];
    rewrites: ReviewRewrite[];
    tips: string[];
    reads_at: string | null;
    created_at: string;
}

export async function getResumeReview(id: string): Promise<ResumeReview | null> {
    const { data } = await api.get<ResumeReview | null>(`/resumes/${id}/review`);
    return data;
}

// Costs one chat turn, charged by the server like any other model call.
export async function reviewResume(id: string): Promise<ResumeReview> {
    const { data } = await api.post<ResumeReview>(`/resumes/${id}/review`);
    return data;
}

export interface InterviewDimensions {
    count: number;
    recent_n: number;
    averages: Record<string, number>;
    recent: Record<string, number>;
}

export interface DashboardDims extends InterviewDimensions {
    total: number;
    completed: number;
    rated: number;
    avg_accuracy: number;
    accuracy_trend: { created_at: string; accuracy: number }[];
    decided: number;
    hiring: number;
    avg_certainty: number | null;
    week_runs: number;
    prior_week_runs: number;
    week_finished: number;
    prior_week_finished: number;
    streak: number;
    last_run_days: number | null;
    delta_accuracy: number | null;
    delta_hire: number | null;
    daily_runs: number[];
    daily_finished: number[];
    hire_spark: number[];
}

export async function getDashboardDims(): Promise<DashboardDims> {
    const { data } = await api.get<DashboardDims>("/stats/dashboard");
    return data;
}

export interface AnalyticsRun {
    id: string;
    role: string;
    level: string;
    status: "pending" | "in_progress" | "completed";
    created_at: string;
    accuracy?: number | null;
    grade?: Grade | null;
    decision?: Decision | null;
    certainty?: number | null;
    failed_class?: MoveClass | null;
    dials: InterviewDials;
    scores: Record<string, number>;
    turns: number;
    moves: Partial<Record<MoveClass, number>>;
}

export interface AnalyticsActivityWeek {
    week: string;
    started: number;
    completed: number;
}

export interface AnalyticsDial {
    key: string;
    label: string;
    runs: number;
    rated: number;
    avg_accuracy?: number | null;
    hire_rate?: number | null;
}

export interface Analytics {
    runs: AnalyticsRun[];
    activity: AnalyticsActivityWeek[];
    move_classes: Record<MoveClass, number>;
    dials: Record<string, AnalyticsDial[]>;
    total_turns: number;
    streak_days: number;
    hardcore_failures: number;
    offers: OffersAnalytics;
}

export async function getAnalytics(): Promise<Analytics> {
    const { data } = await api.get<Analytics>("/stats/analytics");
    return data;
}

export interface OfferBenefit {
    key: string;
    label: string;
    value: string;
}

export interface Offer {
    interview_id: string;
    role: string;
    level: string;
    title: string;
    band: string;
    band_low: number;
    band_high: number;
    base_salary: number;
    signing_bonus: number;
    equity: number;
    performance: number;
    tier: string;
    tier_label: string;
    benefits: OfferBenefit[];
    accuracy?: number | null;
    grade?: Grade | null;
    decision?: Decision | null;
    created_at: string;
    starts_on: string;
    total_comp: number;
}

export interface OfferSummary {
    count: number;
    avg_base: number;
    median_base: number;
    low_base: number;
    high_base: number;
    avg_total: number;
    low_total: number;
    high_total: number;
    avg_signing: number;
    avg_equity: number;
    avg_performance: number;
    avg_benefits: number;
    best_id: string | null;
    worst_id: string | null;
}

export interface OfferGroup {
    key: string;
    label: string;
    offers: number;
    avg_base: number;
    low_base: number;
    high_base: number;
    span: number;
    avg_total: number;
    avg_performance: number;
}

export interface OfferBenefitStat {
    key: string;
    label: string;
    offers: number;
    rate: number;
}

export interface OfferMonth {
    month: string;
    offers: number;
    avg_base: number;
}

export interface OffersAnalytics {
    summary: OfferSummary;
    offers: Offer[];
    by_level: OfferGroup[];
    by_tier: OfferGroup[];
    benefits: OfferBenefitStat[];
    activity: OfferMonth[];
}

export async function getOffer(interviewId: string): Promise<Offer> {
    const { data } = await api.get<Offer>(`/interviews/${interviewId}/offer`);
    return data;
}

export interface Message {
    id: string;
    interview_id: string;
    role: "user" | "assistant" | "system";
    content: string;
    move_class?: MoveClass | null;
    comment?: string | null;
    created_at: string;
}

export interface Feedback {
    id: string;
    interview_id: string;
    scores: Record<string, number>;
    verdict: string;
    tips: string[];
    decision?: Decision | null;
    certainty?: number | null;
    accuracy?: number | null;
    grade?: Grade | null;
    failed_turn?: number | null;
    failed_class?: MoveClass | null;
    redos?: number;
    created_at: string;
}

export type MoveClass = "brilliant" | "great" | "good" | "book" | "inaccuracy" | "mistake" | "blunder";
export type Grade = "S" | "A" | "B" | "C" | "D" | "F";

export type Decision = "reject" | "lean_reject" | "lean_hire" | "hire";

// Mirror GET /usage: the daily GLOBAL chat-turn credit across ALL the owner's
// interviews, plus the resume ceiling. Review redos ride on the review itself (Feedback.redos).

export type Tier = "free" | "premium" | "dev";

export interface Usage {
    tier: Tier;
    chat_turns_per_day_free?: number;
    chat_turns_per_day_premium?: number;
    chat_turns_per_day_dev?: number;
    chat_turns_used_today?: number;
    chat_turns_remaining_today?: number;
    byok?: boolean;
    billing_mode?: "period" | "subscription";
    premium_until?: string | null;
    resume_limit?: number;
}

export function chatTurns(usage: Usage): number {
    return usage[`chat_turns_per_day_${usage.tier}`] ?? 0;
}

export function turnsToday(usage: Usage): { limit: number; used: number; remaining: number } | null {
    const limit = chatTurns(usage);
    const remaining = usage.chat_turns_remaining_today;
    if (!limit || typeof remaining !== "number") return null;
    return { limit, used: usage.chat_turns_used_today ?? limit - remaining, remaining };
}

export async function listInterviews(limit: number, offset: number, archived: boolean): Promise<Interview[]> {
    const { data } = await api.get<Interview[]>("/interviews", { params: { limit, offset, archived } });
    return data;
}

export async function startInterview(id: string): Promise<Interview> {
    const { data } = await api.post<Interview>(`/interviews/${id}/start`);
    return data;
}

export async function finishInterview(id: string): Promise<Interview> {
    const { data } = await api.post<Interview>(`/interviews/${id}/finish`);
    return data;
}

export async function deleteInterview(id: string): Promise<void> {
    await api.delete(`/interviews/${id}`);
}

// Archive = hide this run from the history list, reversibly. It is NOT a delete and NOT a status:
// the run keeps counting in the dashboard stats and comes straight back on restore.
export async function archiveInterview(id: string): Promise<Interview> {
    const { data } = await api.post<Interview>(`/interviews/${id}/archive`);
    return data;
}

export async function unarchiveInterview(id: string): Promise<Interview> {
    const { data } = await api.delete<Interview>(`/interviews/${id}/archive`);
    return data;
}

export async function getMessages(id: string): Promise<Message[]> {
    const { data } = await api.get<Message[]>(`/interviews/${id}/messages`);
    return data;
}

// Authoritative status: POST /start 409s for BOTH in_progress and completed runs, so the error alone
// cannot tell a live run from a finished one.
export async function getInterview(id: string): Promise<Interview> {
    const { data } = await api.get<Interview>(`/interviews/${id}`);
    return data;
}

export async function getFeedback(id: string): Promise<Feedback> {
    const { data } = await api.get<Feedback>(`/interviews/${id}/feedback`);
    return data;
}

// POST /interviews/{id}/feedback/generate: (re)run the review for a COMPLETED interview whose feedback
// is absent. 409 => not completed; 503 => model unavailable right now (retry later).
export async function regenerateFeedback(id: string): Promise<Feedback> {
    const { data } = await api.post<Feedback>(`/interviews/${id}/feedback/generate`);
    return data;
}

export async function getUsage(): Promise<Usage> {
    const { data } = await api.get<Usage>("/usage");
    return data;
}

// /billing/checkout answers with a QR to render or a provider URL to follow; with no provider portal,
// stopping a renewal is our own endpoint. Which mode is live is the server's call (`GET /usage`).
export type Checkout = { url?: string; qr?: { image_url: string; expires_at: string } };

export async function startUpgrade(): Promise<Checkout> {
    const { data } = await api.post<Checkout>("/billing/checkout");
    return data;
}

export async function cancelUpgrade(): Promise<void> {
    await api.post("/billing/cancel");
}

// BYOK: per-user LLM provider, mirrors backend app/byok.py.

export interface LLMProviderStatus {
    enabled: boolean;
    byok: boolean;
    base_url: string;
    model: string;
    key_hint: string | null;
    system: { configured: boolean; base_url: string; model: string };
}

interface LLMProviderInput {
    base_url: string;
    model: string;
    api_key?: string;
}

export async function getLLMProvider(): Promise<LLMProviderStatus> {
    const { data } = await api.get<LLMProviderStatus>("/settings/llm");
    return data;
}

export async function saveLLMProvider(input: LLMProviderInput): Promise<LLMProviderStatus> {
    const { data } = await api.put<LLMProviderStatus>("/settings/llm", input);
    return data;
}

export async function clearLLMProvider(): Promise<void> {
    await api.delete("/settings/llm");
}

export async function testLLMProvider(): Promise<{ ok: boolean; detail: string }> {
    const { data } = await api.post<{ ok: boolean; detail: string }>("/settings/llm/test");
    return data;
}

// The backend caps a chat turn (models.ChatTurn); the UI enforces the same bound.
// candidate never types past it and meets a raw 422.
export const MAX_TURN_CHARS = 8000;

// Voice: the only engine is Workers AI, via the backend.

export interface VoiceCapability {
    tts: boolean;
    stt: boolean;
    tts_model: string;
    stt_model: string;
}

export async function getVoiceCapability(): Promise<VoiceCapability> {
    const { data } = await api.get<VoiceCapability>("/voice");
    return data;
}

export async function synthesizeSpeech(text: string, signal?: AbortSignal): Promise<Blob> {
    const { data } = await api.post("/voice/tts", { text }, { responseType: "blob", signal, timeout: 15000 });
    return data as Blob;
}

export async function transcribeAudio(clip: Blob): Promise<VoiceTranscript> {
    const form = new FormData();
    // The field name is the backend's parameter name; the filename is cosmetic, since the container is
    // sniffed from the bytes rather than trusted (app/voice.py).
    form.append("file", clip, `take.${clip.type.includes("mp4") ? "m4a" : clip.type.includes("ogg") ? "ogg" : "webm"}`);
    const { data } = await api.post<VoiceTranscript>("/voice/stt", form);
    return data;
}

interface VoiceTranscript {
    text: string;
    segments: unknown[];
    language: string;
}

export type StreamEvent = { kind: "message"; content: string } | { kind: "done"; closing?: boolean; failed?: { turn: number; class: MoveClass } } | { kind: "error"; message: string };

export async function kickoffInterview(interviewId: string, onEvent: (e: StreamEvent) => void, { signal }: { signal?: AbortSignal } = {}): Promise<void> {
    return streamFrames(`/interviews/${interviewId}/chat/kickoff`, undefined, onEvent, signal);
}

export async function streamChat(interviewId: string, content: string, onEvent: (e: StreamEvent) => void, { signal }: { signal?: AbortSignal } = {}): Promise<void> {
    return streamFrames(`/interviews/${interviewId}/chat/stream`, { interview_id: interviewId, content }, onEvent, signal);
}

async function streamFrames(path: string, body: Record<string, unknown> | undefined, onEvent: (e: StreamEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body ?? {}),
        signal,
    });

    if (!res.ok || !res.body) {
        const err = new Error(`chat stream failed: HTTP ${res.status}`);
        (err as Error & { status?: number }).status = res.status;
        throw err;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let sep = buffer.indexOf("\n\n");
            while (sep !== -1) {
                const frame = buffer.slice(0, sep);
                buffer = buffer.slice(sep + 2);
                dispatchFrame(frame, onEvent);
                sep = buffer.indexOf("\n\n");
            }
        }
    } finally {
        reader.releaseLock();
    }
}

function dispatchFrame(frame: string, onEvent: (e: StreamEvent) => void) {
    let eventName = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, "").replace(/\r$/, ""));
    }
    const data = dataLines.join("\n");

    if (eventName === "error") onEvent({ kind: "error", message: data });
    else if (eventName === "done") {
        // `closing` marks the end of the run: the arc is spent or hardcore failed. The server refuses
        // anything after it, so the UI ends now rather than letting the user type into a 409.
        let closing = false;
        let failed: { turn: number; class: MoveClass } | undefined;
        try {
            const parsed = JSON.parse(data || "{}") as { closing?: unknown; failed?: { turn?: unknown; class?: unknown } };
            closing = Boolean(parsed.closing);
            if (typeof parsed.failed?.turn === "number" && typeof parsed.failed.class === "string") failed = { turn: parsed.failed.turn, class: parsed.failed.class as MoveClass };
        } catch {
            closing = false;
        }
        onEvent({ kind: "done", closing, failed });
    } else onEvent({ kind: "message", content: data });
}
