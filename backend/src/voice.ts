import { strict as assert } from "node:assert";
import { config } from "./env.ts";
import type { VoiceCapability, VoiceTranscript } from "./models.ts";
import { log } from "./observability.ts";

export type Speech = { audio: Uint8Array; media_type: string };

// httpx capped connect at 10s and read at 60s; fetch has one signal for the whole call, so the widest
// phase is what an unreachable host can burn.
const TIMEOUT_MS = 60_000;

// Container magic bytes. Whisper needs a real container, and the browser's Content-Type is not proof of
// one (Safari and Chrome disagree, and either can be spoofed). Same reasoning as resumes.hasPdfHeader.
const CONTAINERS: [number[], number][] = [
    [[0x1a, 0x45, 0xdf, 0xa3], 0],
    [[0x4f, 0x67, 0x67, 0x53], 0],
    [[0x52, 0x49, 0x46, 0x46], 0],
    [[0x66, 0x74, 0x79, 0x70], 4],
    [[0x49, 0x44, 0x33], 0],
];

export class VoiceError extends Error {
    constructor(detail: string) {
        super(detail);
        this.name = "VoiceError";
    }
}

export function capability(): VoiceCapability {
    const configured = Boolean(config.cloudflareAccountId && config.cloudflareApiToken);
    return { tts: configured, stt: configured, tts_model: config.cloudflareTtsModel, stt_model: config.cloudflareSttModel };
}

function hasContainer(data: Uint8Array): boolean {
    return CONTAINERS.some(([magic, offset]) => magic.every((byte, index) => data[offset + index] === byte));
}

function endpoint(model: string): string {
    return `https://api.cloudflare.com/client/v4/accounts/${config.cloudflareAccountId}/ai/run/${model}`;
}

function failure(payload: unknown): string | null {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
    const body = payload as { success?: unknown; errors?: unknown };
    if (body.success ?? true) return null;
    const first = Array.isArray(body.errors) ? body.errors[0] : undefined;
    const message = typeof first === "object" && first !== null ? (first as { message?: unknown }).message : undefined;
    return typeof message === "string" && message !== "" ? message : "Workers AI refused the request";
}

function ttsBody(model: string, text: string): Record<string, string> {
    if (model.includes("aura")) return { text, speaker: config.cloudflareTtsSpeaker };
    return { prompt: text, lang: "en" };
}

// Keyed on the voice that would say the line, so a replay costs no neurons, and bounded in bytes: a
// clip's size tracks its text and the pod is 256Mi. The opener is generated per run, so the first line
// is always a miss.
const cache = new Map<string, Speech>();

function cacheKey(text: string): string {
    return JSON.stringify([config.cloudflareTtsModel, config.cloudflareTtsSpeaker, text]);
}

function cached(key: string): Speech | undefined {
    const hit = cache.get(key);
    if (hit !== undefined) {
        cache.delete(key);
        cache.set(key, hit);
    }
    return hit;
}

function remember(key: string, speech: Speech): void {
    cache.set(key, speech);
    // Oldest first, and the newest line is never the one evicted: a clip larger than the whole budget
    // is still worth serving, it just empties the cache.
    while (cache.size > 1 && [...cache.values()].reduce((total, item) => total + item.audio.length, 0) > config.voiceTtsCacheBytes) {
        const oldest = cache.keys().next();
        if (oldest.done) return;
        cache.delete(oldest.value);
    }
}

let active = 0;
const waiting: (() => void)[] = [];

// Concurrent upstream calls. The pod is one replica and each call holds its audio in memory, so a burst
// is a burst of held bytes: unbounded, that is an OOMKill (a full outage) rather than a slow take.
async function withSlot<T>(work: () => Promise<T>): Promise<T> {
    if (active >= config.voiceConcurrency) await new Promise<void>((release) => waiting.push(release));
    else active += 1;
    try {
        return await work();
    } finally {
        const next = waiting.shift();
        if (next) next();
        else active -= 1;
    }
}

type Reply = { status: number; media_type: string; bytes: Uint8Array };

async function call(model: string, body: unknown): Promise<Reply> {
    if (!(config.cloudflareAccountId && config.cloudflareApiToken)) throw new VoiceError("Voice is not configured on this server yet.");
    return await withSlot(async () => {
        try {
            const response = await fetch(endpoint(model), {
                method: "POST",
                headers: { authorization: `Bearer ${config.cloudflareApiToken}` },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            const bytes = new Uint8Array(await response.arrayBuffer());
            return { status: response.status, media_type: response.headers.get("content-type") ?? "", bytes };
        } catch (error) {
            // The visitor gets one sentence; the log gets the class, never the audio or the token.
            log.warning("voice.unreachable", { model, error: error instanceof Error ? error.name : typeof error });
            throw new VoiceError("The voice service did not answer. Type your answer instead.");
        }
    });
}

function payloadOf(reply: Reply): unknown {
    return JSON.parse(Buffer.from(reply.bytes).toString("utf8") || "null");
}

function audioOf(reply: Reply): Speech {
    const media_type = reply.media_type.split(";")[0].trim();
    // Aura-1 measured: raw `audio/mpeg`, which is the browser's easiest case to decode.
    if (media_type.startsWith("audio/")) return { audio: reply.bytes, media_type };
    const payload = payloadOf(reply);
    const message = failure(payload);
    if (message !== null) throw new VoiceError(`The voice model refused that line: ${message}`);
    const audio = typeof payload === "object" && payload !== null ? (payload as { result?: { audio?: unknown } }).result?.audio : undefined;
    if (typeof audio !== "string" || audio === "") throw new VoiceError("The voice model returned no audio.");
    const encoded = audio.startsWith("data:") ? audio.slice(audio.indexOf(",") + 1) : audio;
    return { audio: Buffer.from(encoded, "base64"), media_type: "audio/mpeg" };
}

function round1(ms: number): number {
    return Math.round(ms * 10) / 10;
}

export async function speak(text: string): Promise<Speech> {
    if (text.length > config.voiceMaxTtsChars) throw new VoiceError(`That line is longer than ${config.voiceMaxTtsChars} characters.`);
    const key = cacheKey(text);
    const hit = cached(key);
    if (hit !== undefined) {
        log.info("voice.tts.completed", { chars: text.length, latency_ms: 0, engine: "cloud", bytes: hit.audio.length, speaker: config.cloudflareTtsSpeaker, cached: true });
        return hit;
    }
    const started = performance.now();
    const reply = await call(config.cloudflareTtsModel, ttsBody(config.cloudflareTtsModel, text));
    if (reply.status !== 200) throw new VoiceError(statusMessage(reply.status));
    const speech = audioOf(reply);
    log.info("voice.tts.completed", { chars: text.length, latency_ms: round1(performance.now() - started), engine: "cloud", bytes: speech.audio.length, speaker: config.cloudflareTtsSpeaker, cached: false });
    remember(key, speech);
    return speech;
}

export async function transcribe(data: Uint8Array, transcription = "transcribe"): Promise<VoiceTranscript> {
    if (data.length > config.voiceMaxUploadBytes) throw new VoiceError(`That recording is larger than ${Math.floor(config.voiceMaxUploadBytes / (1024 * 1024))} MB.`);
    if (!hasContainer(data)) throw new VoiceError("That recording is not in a format the transcription service reads.");
    const started = performance.now();
    const reply = await call(config.cloudflareSttModel, { audio: Buffer.from(data).toString("base64"), task: transcription });
    if (reply.status !== 200) throw new VoiceError(statusMessage(reply.status));
    const payload = payloadOf(reply);
    const message = failure(payload);
    if (message !== null) throw new VoiceError(`The transcription model refused that clip: ${message}`);
    const body = typeof payload === "object" && payload !== null ? (payload as { result?: unknown }) : {};
    const result = "result" in body ? body.result : payload;
    const fields = typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
    // The non-turbo `whisper` model answers with the text alone; the turbo model answers with an object.
    const text = typeof result === "string" ? result : typeof fields.text === "string" ? fields.text : "";
    const segments = Array.isArray(fields.segments) ? (fields.segments as Record<string, unknown>[]) : [];
    const info = typeof fields.transcription_info === "object" && fields.transcription_info !== null ? (fields.transcription_info as Record<string, unknown>) : {};
    const usage = typeof fields.usage === "object" && fields.usage !== null ? (fields.usage as Record<string, unknown>) : {};
    log.info("voice.stt.completed", {
        bytes: data.length,
        latency_ms: round1(performance.now() - started),
        engine: "cloud",
        chars: text.length,
        // `transcription_info` carries the audio seconds and the detected language, which is what makes a
        // run's cost and a mis-detected language readable out of Loki.
        audio_s: info.duration ?? null,
        language: info.language ?? null,
        // Measured, not estimated: the response reports the neurons it spent. TTS returns raw audio, so its
        // cost stays an estimate from characters.
        neurons: usage.neurons ?? null,
    });
    return { text: text.trim(), segments, language: String(info.language ?? "") };
}

function statusMessage(code: number): string {
    if (code === 401 || code === 403) {
        log.warning("voice.unauthorized", { status: code });
        return "Voice is not authorised on this server. Type your answer instead.";
    }
    if (code === 429) {
        // The free daily allocation is spent (or a rate limit tripped): it resets at 00:00 UTC.
        log.warning("voice.quota_exhausted", { status: code });
        return "The voice service has hit its daily limit. Type your answer, or come back tomorrow.";
    }
    return "The voice service is unavailable right now. Type your answer instead.";
}

// One framework-free self-check (AGENTS rule 5): this branch decides whether the provider sees a
// sentence or a 400, and it is the one a model swap would silently flip.
assert.deepEqual(ttsBody("@cf/deepgram/aura-1", "hi"), { text: "hi", speaker: config.cloudflareTtsSpeaker });
assert.deepEqual(ttsBody("@cf/myshell-ai/melotts", "hi"), { prompt: "hi", lang: "en" });
assert.equal(failure({ success: false, errors: [{ code: 7000, message: "No more neurons" }] }), "No more neurons");
assert.equal(failure({ success: true, result: { text: "hi" } }), null);
