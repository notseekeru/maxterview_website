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

// --- types (mirror backend app/models.py) ---

export interface Interview {
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
    created_at: string;
}

// Mirror GET /usage (MONETIZATION §3). The only quota is a daily GLOBAL chat-turn
// credit shared across ALL of the owner's interviews (plus `dev` for the no-Clerk
// identity); the dynamic dial key is addressed via `chatTurns(usage)` below.

export type Tier = "free" | "premium" | "dev";

export interface Usage {
    tier: Tier;
    chat_turns_per_day_free?: number;
    chat_turns_per_day_premium?: number;
    chat_turns_per_day_dev?: number;
}

export function chatTurns(usage: Usage): number {
    return usage[`chat_turns_per_day_${usage.tier}`] ?? 0;
}

// --- interviews ---

export async function createInterview(role: string, topic = "", level: string = "any"): Promise<Interview> {
    const { data } = await api.post<Interview>("/interviews", { role, topic, level });
    return data;
}

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

export async function createCheckoutSession(): Promise<string> {
    const { data } = await api.post<{ url: string }>("/billing/checkout");
    return data.url;
}

export async function openBillingPortal(): Promise<string> {
    const { data } = await api.post<{ url: string }>("/billing/portal");
    return data.url;
}

// --- SSE chat stream ---
// The backend streams SSE deltas; we consume them with native fetch streaming.

export type StreamEvent = { kind: "message"; content: string } | { kind: "done" } | { kind: "error"; message: string };

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
    else if (eventName === "done") onEvent({ kind: "done" });
    else onEvent({ kind: "message", content: data });
}
