import axios, { type AxiosError } from "axios";

import { markAuthGate401 } from "./authHealth";

// The Vite dev proxy (and prod nginx) forward /api/... to the backend unchanged: the app serves
// its own routes under that prefix (backend `API_PREFIX`), so nothing is stripped on the way.
const BASE = `${import.meta.env.VITE_API_BASE ?? "/api"}`;

export const api = axios.create({
    baseURL: BASE,
    withCredentials: true, // send __session cookie for Clerk auth
});

// Surface the backend-auth-gated-but-browser-can't-login mismatch to the shell: on a
// 401 whose detail is exactly the backend's `Missing credentials`, tell authHealth.
api.interceptors.response.use(
    (r) => r,
    (err) => {
        const d = err.response?.data as { detail?: string } | undefined;
        if (err.response?.status === 401 && d?.detail === "Missing credentials") markAuthGate401();
        return Promise.reject(err);
    },
);

// Axios rejects with the status nested at `response.status` (not top level); this
// normalizes it so callers can branch on it the way the SSE errors already allow.
export function httpStatus(e: unknown): number | undefined {
    return (e as AxiosError)?.response?.status ?? (e as { status?: number })?.status;
}

// M10: a 402 signals a quota lockout (daily chat-turn cap).
export function isQuotaError(e: unknown): boolean {
    return (e as AxiosError)?.response?.status === 402;
}

// FastAPI errors carry a human-readable `detail`; the backend writes those strings for this
// UI (e.g. 409 "Nothing to score yet: …"), so prefer it over a generic message.
export function apiDetail(e: unknown, fallback: string | null = null): string | null {
    const d = (e as AxiosError<{ detail?: string }>)?.response?.data?.detail;
    return typeof d === "string" && d ? d : fallback;
}

// --- types (mirror backend app/models.py) ---

export interface Interview extends InterviewDials {
    id: string;
    owner_id: string;
    role: string;
    level: string;
    topic?: string;
    status: "pending" | "in_progress" | "completed";
    created_at: string;
    updated_at: string;
    /** Derived 0-100 move-review accuracy, null until the run is graded. */
    accuracy?: number | null;
    /** Letter grade for `accuracy`, banded server-side (app/rating.py); F for any hardcore failure. */
    grade?: Grade | null;
    /** Hardcore: the turn that ended the run and what it was called. Null on a clean (or non-hardcore) run. */
    failed_turn?: number | null;
    failed_class?: MoveClass | null;
    verdict?: string | null;
    decision?: Decision | null;
    certainty?: number | null;
    /** The attached resume, null when the run was created without one (or its resume was deleted:
     *  the FK is ON DELETE SET NULL). */
    resume_id?: string | null;
    /** Set = hidden from the history list (NOT from the API or the stats). See archiveInterview. */
    archived_at?: string | null;
}

// Interview dressing dials (mirrors backend app/models.Dials + app/dials.py). The mix sliders are
// QUESTION BUDGETS over the arc opening -> chitchat -> behavioural -> technical -> wrap-up, so 0
// skips that kind rather than silencing it.
export type CompanySize = "any" | "1-10" | "11-50" | "51-200" | "201-1k" | "1k-5k" | "5k+";
export type Cynicism = "kind" | "neutral" | "skeptical";

export interface InterviewDials {
    company_size: CompanySize;
    cynicism: Cynicism;
    /** Names weaknesses as they appear, and leads the feedback with them. */
    brutally_honest: boolean;
    /** Human register (contractions, no AI/corporate vocabulary); off = businesslike. */
    human_mode: boolean;
    /** One wrong answer (move class mistake/blunder) ends the run on the spot, and `failed_turn`
     *  records which one. Feedback for a failed run is an ALL CAPS rejection, graded F. */
    hardcore: boolean;
    mix_chitchat: number;
    mix_behavioural: number;
    mix_technical: number;
}

export interface InterviewInput extends InterviewDials {
    role: string;
    topic?: string;
    level: string;
    /** The attached resume (null/absent = none). Ownership is checked server-side in the INSERT. */
    resume_id?: string | null;
}

// The dials arrive together (the create form owns them), so one object beats nine positional args
// where swapping two same-typed numbers would compile and silently change the interview.
export async function createInterview(input: InterviewInput): Promise<Interview> {
    const { data } = await api.post<Interview>("/interviews", input);
    return data;
}

// Saved create-interview presets (mirrors backend models.InterviewTemplate).
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

// --- resumes (the library; an interview or preset holds `resume_id`) ---

/** One row of the library, WITHOUT its text: the list stays bounded, and the editor fetches one. */
export interface ResumeSummary {
    id: string;
    name: string;
    /** Pages the import read; 0 for a pasted resume. */
    page_count: number;
    chars: number;
    created_at: string;
    updated_at: string;
}

export interface Resume extends ResumeSummary {
    text: string;
}

export interface ResumeInput {
    name: string;
    text: string;
}

/** What a PDF gave us before anyone decided to keep it. `truncated` is true for the page cap, the
 *  character cap, and unreadable pages alike - the UI only has to say "not the whole document". */
export interface ResumeExtract {
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

/** Parse a PDF server-side and hand back the text. Persists NOTHING: the caller decides to save. */
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

// The dashboard radar's aggregate (mirrors backend models.InterviewDimensions): per-dimension
// averages over the rated runs, the newest run's scores, and how many runs those cover. One request
// and a payload that does not grow with history, where per-run Feedback reads used to be fetched to
// average client-side.
export interface InterviewDimensions {
    count: number;
    averages: Record<string, number>;
    latest: Record<string, number>;
}

export async function getInterviewDimensions(): Promise<InterviewDimensions> {
    const { data } = await api.get<InterviewDimensions>("/stats/dimensions");
    return data;
}

// The analytics page's single aggregate (mirrors backend models.Analytics). One request over the
// whole history, like the dashboard's radar: the payload is bounded, so no per-run fan-out.
export interface AnalyticsRun {
    id: string;
    role: string;
    level: string;
    /** Lifecycle state. The run log shows unfinished runs, so it must label them. */
    status: "pending" | "in_progress" | "completed";
    /** ISO timestamp in UTC. Chart buckets are UTC days on purpose: the streak tile and the daily
     *  quota reset are both UTC, so local-time buckets would disagree with the tile above them. */
    created_at: string;
    accuracy?: number | null;
    grade?: Grade | null;
    decision?: Decision | null;
    certainty?: number | null;
    failed_class?: MoveClass | null;
    /** The create dials that produced this run (drives the log's Dials column). */
    dials: InterviewDials;
    /** 1-10 dimension scores; empty when the run was never scored. */
    scores: Record<string, number>;
    /** Candidate turns in the run. */
    turns: number;
    /** Move class -> turns the reviewer classed so. A run can have fewer moves than turns. */
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
    /** Runs that were actually scored; `avgAccuracy` covers only these. */
    rated: number;
    /** Null when nothing under this value was scored (NOT 0, which would read as failure). */
    avg_accuracy?: number | null;
    /** Over DECIDED runs only; null when nothing was decided. */
    hire_rate?: number | null;
}

export interface Analytics {
    /** Newest first, every run ever created (archived and unfinished included). */
    runs: AnalyticsRun[];
    activity: AnalyticsActivityWeek[];
    move_classes: Record<MoveClass, number>;
    /** Dial name -> its values, in the vocabulary's own order. */
    dials: Record<string, AnalyticsDial[]>;
    total_turns: number;
    streak_days: number;
    hardcore_failures: number;
}

export async function getAnalytics(): Promise<Analytics> {
    const { data } = await api.get<Analytics>("/stats/analytics");
    return data;
}

export interface Message {
    id: string;
    interview_id: string;
    role: "user" | "assistant" | "system";
    content: string;
    /** The reviewer's annotation on this candidate turn (null on interviewer turns, ungraded runs). */
    move_class?: MoveClass | null;
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
    /** Hardcore: the turn that ended the run and what it was called (drives the FAILED banner). */
    failed_turn?: number | null;
    failed_class?: MoveClass | null;
    created_at: string;
}

// Chess-style answer review (mirrors backend app/rating.py). `move_class` is the model's verdict on
// ONE candidate turn; accuracy and grade are DERIVED from those classes server-side, so this side
// never averages or bands anything itself.
export type MoveClass = "brilliant" | "great" | "good" | "book" | "inaccuracy" | "mistake" | "blunder";
export type Grade = "S" | "A" | "B" | "C" | "D" | "F";

// Post-interview hire/reject spectrum (mirrors backend app/models.DECISIONS, ordered
// left to right). `certainty` (0-100) is the SEPARATE axis: how well the transcript
// evidences the decision, not how positive it is. Both are null for a run the model
// could not decide, and for feedback written before the columns existed.
export type Decision = "reject" | "lean_reject" | "lean_hire" | "hire";

// Mirror GET /usage (MONETIZATION §3). The only quota is a daily GLOBAL chat-turn
// credit shared across ALL of the owner's interviews (plus `dev` for the no-Clerk
// identity); the dynamic dial key is addressed via `chatTurns(usage)` below.

export type Tier = "free" | "premium" | "dev";

export interface Usage {
    tier: Tier;
    /** The caller's EFFECTIVE daily cap: their tier's, or the flat, higher BYOK ceiling when
     *  `byok` is set. The server reports only the caller's own tier key, so a page may never
     *  assume another tier's number from here (see lib/plans.ts for marketing). */
    chat_turns_per_day_free?: number;
    chat_turns_per_day_premium?: number;
    chat_turns_per_day_dev?: number;
    /** Turns already spent today (UTC) against the daily global cap. */
    chat_turns_used_today?: number;
    chat_turns_remaining_today?: number;
    /** Turns run on the owner's own provider key: the TIER cap is swapped for the higher BYOK
     *  ceiling above, never waived, and the turns are still metered. */
    byok?: boolean;
    /** How a payment becomes premium: `period` = one-time top-up with no auto-renew. */
    billing_mode?: "period" | "subscription";
    /** ISO timestamp when the paid time lapses; period mode never renews itself, so hiding this
     *  leaves the user to discover the downgrade by hitting the cap. */
    premium_until?: string | null;
    /** How many resumes this tier may keep. Storage, not a meter: nothing is spent by importing one. */
    resume_limit?: number;
}

export function chatTurns(usage: Usage): number {
    return usage[`chat_turns_per_day_${usage.tier}`] ?? 0;
}

/** Today's counter for the caller's own tier, or null when the server did not report it. */
export function turnsToday(usage: Usage): { limit: number; used: number; remaining: number } | null {
    const limit = chatTurns(usage);
    const remaining = usage.chat_turns_remaining_today;
    if (!limit || typeof remaining !== "number") return null;
    return { limit, used: usage.chat_turns_used_today ?? limit - remaining, remaining };
}

// --- interviews ---

export async function listInterviews(): Promise<Interview[]> {
    const { data } = await api.get<Interview[]>("/interviews");
    return data;
}

export async function startInterview(id: string): Promise<Interview> {
    const { data } = await api.post<Interview>(`/interviews/${id}/start`);
    return data;
}

export async function completeInterview(id: string): Promise<Interview> {
    const { data } = await api.post<Interview>(`/interviews/${id}/complete`);
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

// Authoritative status for one interview. Needed because POST /start 409s for BOTH
// in_progress and completed runs, so the error alone can't tell a live run from a
// finished one.
export async function getInterview(id: string): Promise<Interview> {
    const { data } = await api.get<Interview>(`/interviews/${id}`);
    return data;
}

export async function getFeedback(id: string): Promise<Feedback> {
    const { data } = await api.get<Feedback>(`/interviews/${id}/feedback`);
    return data;
}

// POST /interviews/{id}/feedback/generate: (re)run the review for a COMPLETED
// interview whose feedback is absent (real-mode scoring failed on /complete). 404 => not
// found; 409 => not completed; 503 => model unavailable right now (retry later).
export async function regenerateFeedback(id: string): Promise<Feedback> {
    const { data } = await api.post<Feedback>(`/interviews/${id}/feedback/generate`);
    return data;
}

// --- M10 usage + billing ---

export async function getUsage(): Promise<Usage> {
    const { data } = await api.get<Usage>("/usage");
    return data;
}

// Both hit our billing surface: /billing/checkout returns a URL we must follow (PayMongo's Maya page
// — no hosted upgrade page exists), and with no provider portal, stopping a renewal is our endpoint.
// Which mode is live is the server's decision (`GET /usage`).
export async function startUpgrade(): Promise<string> {
    const { data } = await api.post<{ url: string }>("/billing/checkout");
    return data.url;
}

export async function cancelUpgrade(): Promise<void> {
    await api.post("/billing/cancel");
}

// --- BYOK: per-user LLM provider (settings panel; mirrors backend app/byok.py, BYOK.md) ---

export interface LLMProviderStatus {
    /** False when the deployment has no BYOK_ENCRYPTION_KEY: the form is read-only then. */
    enabled: boolean;
    byok: boolean;
    base_url: string;
    model: string;
    /** Last 4 characters of the saved key, so the user can tell WHICH key is stored. Null = no key
     *  saved (a self-hosted endpoint that authenticates nothing). */
    key_hint: string | null;
    system: { configured: boolean; base_url: string; model: string };
}

export interface LLMProviderInput {
    base_url: string;
    model: string;
    /** Omit/empty to keep the stored key. An endpoint that needs no auth (Ollama, llama.cpp) can be
     *  saved keyless — an empty key just means no Authorization header. */
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

// Probes the SAVED provider with a 1-token completion. Returns the backend's short reason
// ("the provider rejected the API key (401)"), never a raw provider body.
export async function testLLMProvider(): Promise<{ ok: boolean; detail: string }> {
    const { data } = await api.post<{ ok: boolean; detail: string }>("/settings/llm/test");
    return data;
}

// --- SSE chat stream ---
// The backend streams SSE deltas; we consume them with native fetch streaming.

// M11: the backend caps a chat turn (models.ChatTurn); the UI enforces the same bound so the
// candidate never types past it and meets a raw 422.
export const MAX_TURN_CHARS = 8000;

export type StreamEvent = { kind: "message"; content: string } | { kind: "done"; closing?: boolean; failed?: { turn: number; class: MoveClass } } | { kind: "error"; message: string };

export async function streamChat(interviewId: string, content: string, onEvent: (e: StreamEvent) => void, { signal }: { signal?: AbortSignal } = {}): Promise<void> {
    const res = await fetch(`${BASE}/interviews/${interviewId}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ interview_id: interviewId, content }),
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

            // SSE events are separated by blank lines; we batch process complete frames.
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
        // `closing` marks the end of the run: either the arc is spent or hardcore failed the candidate
        // (`failed` carries which), and the server refuses anything after it, so the UI ends the run
        // now instead of letting the user type into a 409.
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
