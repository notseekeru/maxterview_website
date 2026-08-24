import axios, { type AxiosError } from "axios";

// The Vite dev proxy (and prod nginx) forward /api/... to the backend, stripping the
// /api prefix so backend routes at root (/interviews) are hit.
const BASE = `${import.meta.env.VITE_API_BASE ?? "/api"}`;

export const api = axios.create({
    baseURL: BASE,
    withCredentials: true, // send __session cookie for Clerk auth
});

// M10: a 402 signals a quota lockout (daily interview cap or chat-turn cap).
export function isQuotaError(e: unknown): boolean {
    return (e as AxiosError)?.response?.status === 402;
}

// --- types (mirror backend app/models.py) ---

export interface Interview {
    id: string;
    owner_id: string;
    role: string;
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

// Mirror GET /usage (MONETIZATION §3).
export interface Usage {
    tier: "free" | "premium";
    daily_interviews_remaining: number; // -1 when unlimited
    daily_interviews_unlimited: boolean;
    [key: string]: string | boolean | number;
}

// --- interviews ---

export async function createInterview(role: string, topic = ""): Promise<Interview> {
    const { data } = await api.post<Interview>("/interviews", { role, topic });
    return data;
}

export async function listInterviews(): Promise<Interview[]> {
    const { data } = await api.get<Interview[]>("/interviews");
    return data;
}

export async function getInterview(id: string): Promise<Interview> {
    const { data } = await api.get<Interview>(`/interviews/${id}`);
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

export async function getFeedback(id: string): Promise<Feedback> {
    const { data } = await api.get<Feedback>(`/interviews/${id}/feedback`);
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
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    const data = dataLines.join("\n");

    if (eventName === "error") onEvent({ kind: "error", message: data });
    else if (eventName === "done") onEvent({ kind: "done" });
    else onEvent({ kind: "message", content: data });
}
