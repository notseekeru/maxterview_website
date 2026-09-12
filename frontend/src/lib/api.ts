import axios, { type AxiosError } from "axios";

import { markAuthGate401 } from "./authHealth";

// The Vite dev proxy (and prod nginx) forward /api/... to the backend, stripping the
// /api prefix so backend routes at root (/interviews) are hit.
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
    score?: number | null;
    verdict?: string | null;
    decision?: Decision | null;
    certainty?: number | null;
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
    mix_chitchat: number;
    mix_behavioural: number;
    mix_technical: number;
}

export interface InterviewInput extends InterviewDials {
    role: string;
    topic?: string;
    level: string;
}

// The dials arrive together (the create form owns them), so one object beats nine positional args
// where swapping two same-typed numbers would compile and silently change the interview.
export async function createInterview(input: InterviewInput): Promise<Interview> {
    const { data } = await api.post<Interview>("/interviews", input);
    return data;
}

export interface Message {
    id: string;
    interview_id: string;
    role: "user" | "assistant" | "system";
    content: string;
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
    created_at: string;
}

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
    chat_turns_per_day_free?: number;
    chat_turns_per_day_premium?: number;
    chat_turns_per_day_dev?: number;
    /** Turns run on the owner's own provider key, so the daily cap is not enforced. */
    byok?: boolean;
}

export function chatTurns(usage: Usage): number {
    return usage[`chat_turns_per_day_${usage.tier}`] ?? 0;
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

// POST /interviews/{id}/feedback/generate: (re)run two-stage scoring for a COMPLETED
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

// Both hit our billing surface: /billing/checkout returns a URL we must follow (the Maya page for
// the subscription's first payment — PayMongo has no hosted subscribe page), and there is no
// provider portal, so cancelling is our own endpoint.
export async function startSubscription(): Promise<string> {
    const { data } = await api.post<{ url: string }>("/billing/checkout");
    return data.url;
}

export async function cancelSubscription(): Promise<void> {
    await api.post("/billing/cancel");
}

// --- BYOK: per-user LLM provider (settings panel; mirrors backend app/byok.py, BYOK.md) ---

export interface LLMProviderStatus {
    /** False when the deployment has no BYOK_ENCRYPTION_KEY: the form is read-only then. */
    enabled: boolean;
    byok: boolean;
    base_url: string;
    model: string;
    /** Last 4 characters of the saved key, so the user can tell WHICH key is stored. */
    key_hint: string | null;
    system: { configured: boolean; base_url: string; model: string };
}

export interface LLMProviderInput {
    base_url: string;
    model: string;
    /** Omit/empty to keep the key already stored (base URL and model stay editable). */
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
export const MAX_TURN_CHARS = 4000;

export type StreamEvent = { kind: "message"; content: string } | { kind: "done"; closing?: boolean } | { kind: "error"; message: string };

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
        // `closing` marks the sign-off turn: the server will refuse anything after it, so the UI can
        // end the run now instead of letting the user type into a 409.
        let closing = false;
        try {
            closing = Boolean((JSON.parse(data || "{}") as { closing?: unknown }).closing);
        } catch {
            closing = false;
        }
        onEvent({ kind: "done", closing });
    } else onEvent({ kind: "message", content: data });
}
