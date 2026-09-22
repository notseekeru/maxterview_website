/** Voice I/O around the turn that already exists (VOICE.md, M16).
 *
 * The applicant's speech becomes text in the answer box, the interviewer's reply is read aloud, and
 * the transcript stays the graded artifact: nothing in here touches the dials, the question arc, the
 * judge, the grader or the chat meter.
 *
 * One engine: Workers AI, through the backend. The browser's own voice was removed deliberately. It
 * is not only that it fails (Chromium on Linux needs `--enable-speech-dispatcher` and a loadable
 * libspeechd, and Brave refuses recognition outright): it sounds like what it is, a screen reader,
 * and an interviewer that talks like one destroys the illusion the feature exists to create. Quality
 * is the reason (VOICE.md V1).
 */

// --- speaking: sentence chunks, one at a time, in order ---

/** A chunk ceiling that keeps the first sentence audible while the rest of the reply is still
 *  generating, and bounds a single MeloTTS request. */
const CHUNK_CHARS = 140;

/** A sentence end: `.!?` plus any closing punctuation, or a newline. Not a real segmenter, so an
 *  abbreviation or a decimal splits a chunk in two. Audible as nothing, because the queue is
 *  serialized and the pieces play back to back in one voice.
 *  AI HERE: swap in a segmenter only if a mis-split ever becomes audible. */
const BREAK = /[.!?]+["')\]]*\s|\n+/g;

/** `[chunks worth speaking now, text held back]`. Held text is the whole contract: a boundary is
 *  what lets the first sentence be heard before the reply has finished streaming. */
export function takeChunks(text: string, atEnd: boolean): [string[], string] {
    const out: string[] = [];
    let rest = text;
    for (;;) {
        BREAK.lastIndex = 0;
        const m = BREAK.exec(rest);
        const ends = m ? m.index + m[0].length : -1;
        if (ends > 0 && ends <= CHUNK_CHARS) {
            const chunk = rest.slice(0, ends).trim();
            if (chunk) out.push(chunk);
            rest = rest.slice(ends);
            continue;
        }
        if (rest.length > CHUNK_CHARS) {
            // No sentence end within reach: cut at the last word that fits, so one long clause is
            // heard now instead of the whole reply being heard late.
            const cut = Math.max(rest.lastIndexOf(" ", CHUNK_CHARS), 1);
            const chunk = rest.slice(0, cut).trim();
            if (chunk) out.push(chunk);
            rest = rest.slice(cut);
            continue;
        }
        break;
    }
    if (atEnd) {
        const tail = rest.trim();
        if (tail) out.push(tail);
        rest = "";
    }
    return [out, rest];
}

if (import.meta.env.DEV) {
    const [spoken, held] = takeChunks("One. Two", false);
    console.assert(spoken.length === 1 && spoken[0] === "One." && held === "Two", "voice: the chunker stopped holding text back", spoken, held);
    // A clause with no sentence end in it: every chunk still respects the ceiling, and nothing is
    // dropped or said twice between what is spoken and what is held back.
    const [wrapped, tail] = takeChunks("x ".repeat(2 * CHUNK_CHARS), false);
    console.assert(wrapped.every((c) => c.length <= CHUNK_CHARS) && `${wrapped.join("")}${tail}`.replace(/\s+/g, "") === "x".repeat(2 * CHUNK_CHARS), "voice: long unbroken text lost or duplicated a chunk", wrapped.length, tail.length);
}

/** One voice, one line at a time. Resolves when the line has been heard, or immediately once the
 *  signal aborts. Implementations must never overlap two lines (VOICE.md gotcha 9). */
export interface Speaker {
    speak(text: string, signal: AbortSignal): Promise<void>;
}

export interface VoiceReader {
    /** Feed the stream: every complete sentence is sent to be spoken as soon as it lands. */
    push(delta: string): void;
    /** The stream ended: speak the remainder. */
    flush(): void;
    /** Cancel from here on. Audio outlives the component that asked for it, so this is not optional
     *  on unmount or a route change (VOICE.md gotcha 5). */
    stop(): void;
}

export function createReader(speaker: Speaker): VoiceReader {
    let buf = "";
    let queue: Promise<void> = Promise.resolve();
    const ctl = new AbortController();

    const enqueue = (text: string) => {
        const { signal } = ctl;
        queue = queue.then(() => (signal.aborted ? undefined : speaker.speak(text, signal))).catch(() => undefined);
    };

    return {
        push(delta) {
            if (ctl.signal.aborted) return;
            const [chunks, rest] = takeChunks(buf + delta, false);
            buf = rest;
            for (const chunk of chunks) enqueue(chunk);
        },
        flush() {
            if (ctl.signal.aborted) return;
            const [chunks, rest] = takeChunks(buf, true);
            buf = rest;
            for (const chunk of chunks) enqueue(chunk);
        },
        stop() {
            ctl.abort();
            buf = "";
        },
    };
}

// --- the cloud voice ---

/** Play one decoded clip to completion. Every terminal state resolves, including a decode failure and
 *  a refused autoplay: an utterance that never resolves wedges the queue behind it, and the queue is
 *  the whole feature. The blob URL is revoked by the caller once this settles. */
function play(url: string, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
        const el = new Audio(url);
        const finish = () => {
            signal.removeEventListener("abort", onAbort);
            el.onended = null;
            el.onerror = null;
            resolve();
        };
        function onAbort() {
            el.pause();
            finish();
        }
        el.onended = finish;
        el.onerror = finish;
        signal.addEventListener("abort", onAbort, { once: true });
        void el.play().catch(finish);
    });
}

/** The cloud speaker. `fetchAudio` is injected rather than imported so this file stays free of the API
 *  client, and so the reader can be driven by a plain function in a test. */
export function cloudSpeaker(fetchAudio: (text: string, signal: AbortSignal) => Promise<Blob>): Speaker {
    return {
        async speak(text, signal) {
            const blob = await fetchAudio(text, signal);
            const url = URL.createObjectURL(blob);
            try {
                await play(url, signal);
            } finally {
                URL.revokeObjectURL(url);
            }
        },
    };
}

// --- listening ---

/** What the recorder reports. One channel: the take started, how loud it is, and how it ended. */
export interface TranscriptionSink {
    /** Held words, once, when the take ends. The answer box is the confirm step (VOICE.md V5). */
    onWords(text: string): void;
    /** 0..1 microphone level for the meter. Called while the take runs; rAF stops in a background tab,
     *  so a hidden tab shows a frozen meter rather than a stalled one. */
    onLevel(level: number): void;
    /** The take is over. `error` is written for the applicant, null on a clean end. */
    onEnd(error: string | null): void;
}

export interface Transcriber {
    start(): void;
    /** The applicant pressed stop. The clip is uploaded and the words arrive through the sink. */
    stop(): void;
    /** Unmount, navigation: drop the microphone and throw the clip away. */
    cancel(): void;
}

/** Why a take cannot run at all here, or null when it can. Checked before the microphone is asked for,
 *  because a refusal at that point costs a permission prompt for nothing. */
export function micBlockedReason(): string | null {
    if (!window.isSecureContext) return "Microphone capture needs HTTPS (localhost counts). Type your answer instead.";
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return "This browser cannot record audio. Type your answer instead.";
    return null;
}

/** Containers to offer the recorder, most preferred first, and the one the browser picks is what gets
 *  uploaded: Safari does not produce what Chrome and Firefox do (VOICE.md gotcha 2), and the backend
 *  sniffs the container rather than trusting this. */
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

export function pickRecordingType(): string | undefined {
    if (typeof MediaRecorder === "undefined") return undefined;
    return RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

/** Root-mean-square of one analyser frame, scaled to 0..1. Speech sits well below full scale, so the
 *  curve is deliberately generous: a meter that only moves on a shout is not feedback. */
function levelOf(analyser: AnalyserNode, frame: Uint8Array<ArrayBuffer>): number {
    analyser.getByteTimeDomainData(frame);
    let sum = 0;
    for (const sample of frame) sum += ((sample - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / frame.length) * 4);
}

export function cloudTranscriber(upload: (clip: Blob) => Promise<string>, sink: TranscriptionSink): Transcriber {
    let recorder: MediaRecorder | null = null;
    let stream: MediaStream | null = null;
    let chunks: Blob[] = [];
    let meter = 0;
    let settled = false;

    const release = () => {
        cancelAnimationFrame(meter);
        meter = 0;
        for (const track of stream?.getTracks() ?? []) track.stop();
        stream = null;
        recorder = null;
    };

    const finish = (error: string | null) => {
        if (settled) return;
        settled = true;
        release();
        sink.onLevel(0);
        sink.onEnd(error);
    };

    /** The clip is uploaded and discarded server-side, so the words arrive a second or two after the
     *  applicant stops (VOICE.md step 2). `upload` rejects with a message written for the applicant:
     *  this file stays API-free, and the caller owns that translation. */
    const deliver = async (clip: Blob) => {
        try {
            sink.onWords(await upload(clip));
            finish(null);
        } catch (e: unknown) {
            finish(e instanceof Error && e.message ? e.message : "The recording could not be transcribed. Try again, or type your answer.");
        }
    };

    return {
        start() {
            const blocked = micBlockedReason();
            if (blocked) {
                finish(blocked);
                return;
            }
            void (async () => {
                try {
                    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
                } catch (e: unknown) {
                    finish(permissionMessage(e));
                    return;
                }
                if (settled) return; // cancelled while the prompt was up
                const mediaType = pickRecordingType();
                try {
                    recorder = new MediaRecorder(stream, mediaType ? { mimeType: mediaType } : undefined);
                } catch {
                    finish("This browser's recorder refused the microphone. Type your answer instead.");
                    return;
                }
                recorder.ondataavailable = (e) => {
                    if (e.data.size) chunks.push(e.data);
                };
                recorder.onerror = () => finish("The recording stopped early. Try again, or type your answer.");
                recorder.onstop = () => {
                    const clip = new Blob(chunks, { type: recorder?.mimeType || mediaType || "audio/webm" });
                    chunks = [];
                    if (!clip.size) {
                        finish("Nothing was recorded, so nothing was added to your answer. Try again, or type it.");
                        return;
                    }
                    void deliver(clip);
                };
                recorder.start();
                // The level meter is the reason the applicant can trust the microphone is live at all:
                // nothing is transcribed on the client, so silence and a dead mic look identical.
                const ctx = new AudioContext();
                const analyser = ctx.createAnalyser();
                analyser.fftSize = 1024;
                ctx.createMediaStreamSource(stream).connect(analyser);
                const frame = new Uint8Array(analyser.fftSize);
                const tick = () => {
                    sink.onLevel(levelOf(analyser, frame));
                    meter = requestAnimationFrame(tick);
                };
                meter = requestAnimationFrame(tick);
            })();
        },
        stop() {
            // Stop the tracks with the recorder: a live microphone after the take is a lit indicator
            // for nothing (VOICE.md gotcha 8).
            recorder?.stop();
            if (!recorder) finish(null);
            for (const track of stream?.getTracks() ?? []) track.stop();
        },
        cancel() {
            settled = true;
            chunks = [];
            try {
                recorder?.stop();
            } catch {
                undefined; // already stopped: nothing to release
            }
            release();
        },
    };
}

/** The two permission failures are different problems with different fixes (VOICE.md gotcha 3). */
function permissionMessage(e: unknown): string {
    const name = (e as { name?: string })?.name;
    if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access is blocked. Allow it in this site's settings, then reload the page.";
    if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found. Check which input your system has selected, then reload the page.";
    if (name === "NotReadableError") return "The microphone is held by another application. Close it, then reload the page.";
    return "The microphone could not be opened. Type your answer instead.";
}

// --- the visitor's choice, per browser ---

const PREF_KEY = "maxterview.voice";

/** Voice is off until asked for. The click that turns it on is also the gesture that lets audio play,
 *  which is what stops the autoplay policy from eating the first sentence. */
export function readVoicePref(): boolean {
    try {
        return localStorage.getItem(PREF_KEY) === "on";
    } catch {
        return false; // private mode, or storage denied: off is the safe default
    }
}

export function writeVoicePref(on: boolean): void {
    try {
        localStorage.setItem(PREF_KEY, on ? "on" : "off");
    } catch {
        undefined; // the choice just does not outlive the tab
    }
}
