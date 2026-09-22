/** Voice I/O around the turn that already exists (VOICE.md, M16).
 *
 * The applicant's speech becomes text in the answer box, the interviewer's reply is read aloud, and
 * the transcript stays the graded artifact: nothing in here touches the dials, the question arc, the
 * judge, the grader or the chat meter. One seam, two engines. The browser engine is what ships now
 * and it is also the permanent fallback (V1); the cloud engine (Cloudflare Workers AI, one backend
 * route per direction) implements these same two interfaces and drops in without the chat surface
 * knowing which one it is talking to.
 */

export type VoiceEngine = "browser" | "cloud";

// --- speaking: sentence chunks, one at a time, in order ---

/** A chunk ceiling that keeps the first sentence audible while the rest of the reply is still
 *  generating, and keeps Chrome's long-utterance stall out of reach. */
const CHUNK_CHARS = 140;

/** A sentence end: `.!?` plus any closing punctuation, or a newline. Not a real segmenter, so an
 *  abbreviation or a decimal splits a chunk in two, which is audible as nothing: the queue is
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
    /** Feed the stream: every complete sentence is spoken as soon as it lands. */
    push(delta: string): void;
    /** The stream ended: speak the remainder. */
    flush(): void;
    /** Cancel from here on. An utterance outlives the component that started it, so this is not
     *  optional on unmount or a route change (VOICE.md gotcha 5). */
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

// --- the browser's own voice ---

/** The browser engine. One utterance per chunk, which is also what sidesteps Chrome's stall on long
 *  utterances. The workaround for that is chunking, not a timer. */
export function browserSpeaker(voice: SpeechSynthesisVoice | null): Speaker {
    return {
        speak(text, signal) {
            return new Promise<void>((resolve) => {
                const u = new SpeechSynthesisUtterance(text);
                if (voice) u.voice = voice;
                const finish = () => {
                    signal.removeEventListener("abort", onAbort);
                    resolve();
                };
                function onAbort() {
                    speechSynthesis.cancel();
                    finish();
                }
                // Any terminal event resolves: an utterance that never ends would wedge the queue
                // behind it, and the queue is the whole feature.
                u.onend = finish;
                u.onerror = finish;
                signal.addEventListener("abort", onAbort, { once: true });
                speechSynthesis.speak(u);
            });
        },
    };
}

export function speechSupported(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** The voice list starts EMPTY and fills in asynchronously on Chrome, so nothing may read it on
 *  first paint. Chrome on Linux frequently finishes with none at all, which is why the caller has to
 *  treat "no voices" as "no voice" rather than as "not loaded yet". */
export function loadVoices(): Promise<SpeechSynthesisVoice[]> {
    if (!speechSupported()) return Promise.resolve([]);
    const now = speechSynthesis.getVoices();
    if (now.length) return Promise.resolve(now);
    return new Promise((resolve) => {
        const settle = () => {
            clearTimeout(timer);
            resolve(speechSynthesis.getVoices());
        };
        const timer = setTimeout(settle, 1000);
        speechSynthesis.addEventListener("voiceschanged", settle, { once: true });
    });
}

/** The visitor's own operating system voice (VOICE.md step 1: good on Edge and macOS, rough on
 *  Chrome for Linux). Only ever used when the cloud voice is unavailable. */
export function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
    const english = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
    return english.find((v) => v.localService) ?? english[0] ?? voices[0] ?? null;
}

// --- listening ---

/** The applicant's speech, as the sink sees it. One channel, because the Web Speech API is one
 *  channel: `onend` fires for our own stop, a silence timeout, a refusal and a network drop alike. */
export interface TranscriptionSink {
    /** Held words, final only (`interimResults` is off, so this never rewrites what was already
     *  shown (VOICE.md V4). */
    onWords(text: string): void;
    /** The engine's own speech detection. The mic-live signal, and it costs no second mic consumer
     *  (VOICE.md gotcha 4: on Android a meter's `getUserMedia` and recognition cannot coexist). */
    onSpeech(speaking: boolean): void;
    /** The take is over, whoever ended it. `error` is written for the applicant, null on a clean
     *  end; `byEngine` marks the engine ending it itself (silence timeout, dropped session). */
    onEnd(error: string | null, byEngine: boolean): void;
}

export interface Transcriber {
    readonly engine: VoiceEngine;
    start(): void;
    /** The applicant pressed stop. Held words survive; `cancel` throws them away. */
    stop(): void;
    cancel(): void;
}

/** Every reason a take cannot run, each with its own sentence (VOICE.md gotcha 3): a refused
 *  permission, a missing device, a browser without recognition and a page that is not a secure
 *  context are four different things to the person reading it. */
function refusalText(reason: SpeechRecognitionErrorCode | "unsupported" | "insecure"): string | null {
    switch (reason) {
        case "not-allowed":
        case "service-not-allowed":
            return "Microphone access is blocked. Allow it in this site's settings, then try again.";
        case "audio-capture":
            return "No microphone found. Check which input your system has selected, then try again.";
        case "network":
            return "Transcription dropped its connection. Check your network, then try again.";
        case "unsupported":
            return "This browser can't transcribe speech. Chrome, Edge and Safari can. Type your answer for now.";
        case "insecure":
            return "Microphone capture needs HTTPS (localhost counts). Type your answer for now.";
        default:
            // "aborted" and "no-speech" are not failures: the engine ended, nothing broke.
            return null;
    }
}

function speechRecognitionCtor(): (new () => SpeechRecognition) | null {
    if (typeof window === "undefined") return null;
    return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

/** Why a take cannot run on this browser, or null when it can. */
export function micBlockedReason(): string | null {
    if (!window.isSecureContext) return refusalText("insecure");
    if (!speechRecognitionCtor()) return refusalText("unsupported");
    return null;
}

export function browserTranscriber(lang: string, sink: TranscriptionSink): Transcriber {
    let rec: SpeechRecognition | null = null;
    let words = "";
    let error: string | null = null;
    let stoppedByUser = false;
    let settled = false;

    const finish = () => {
        if (settled) return;
        settled = true;
        rec = null;
        sink.onSpeech(false);
        sink.onEnd(error, !stoppedByUser);
    };

    return {
        engine: "browser",
        start() {
            const Ctor = speechRecognitionCtor();
            error = micBlockedReason();
            if (!Ctor || error) {
                finish();
                return;
            }
            const r = new Ctor();
            rec = r;
            r.lang = lang;
            // Continuous, because a take is one answer and the engine's own silence timeout must not
            // be what ends it: that is what the cap and the stop button are for.
            r.continuous = true;
            r.interimResults = false;
            r.maxAlternatives = 1;
            r.onspeechstart = () => sink.onSpeech(true);
            r.onspeechend = () => sink.onSpeech(false);
            r.onresult = (e) => {
                for (let i = e.resultIndex; i < e.results.length; i += 1) {
                    if (e.results[i].isFinal) words += e.results[i][0].transcript;
                }
                sink.onWords(words.trim());
            };
            r.onerror = (e) => {
                error = refusalText(e.error);
            };
            r.onend = finish;
            try {
                r.start();
            } catch {
                // Chrome throws when a recognition is already running for this document.
                error = "The microphone is busy in another tab. Close it, then try again.";
                finish();
            }
        },
        stop() {
            stoppedByUser = true;
            // stop() flushes the words already heard; abort() would throw them away.
            if (rec) rec.stop();
            else finish();
        },
        cancel() {
            settled = true;
            rec?.abort();
            rec = null;
        },
    };
}

/** Which engine a fresh take uses. The cloud engine is the primary (V1) and the reason this is a
 *  function rather than a direct call: it becomes a reachability choice here, with the browser
 *  engine as the answer whenever the cloud route is unavailable (V3: the engine is chosen before the
 *  take, and never swaps mid-answer).
 *  AI HERE: until the Workers AI route exists every take is the browser engine. */
export function pickTranscriber(sink: TranscriptionSink): Transcriber {
    return browserTranscriber(navigator.language || "en-US", sink);
}

// --- the visitor's choice, per browser ---

const PREF_KEY = "maxterview.voice";

/** Voice is off until asked for. The click that turns it on is also the gesture that lets audio
 *  play, which is what stops the autoplay policy from eating the first sentence. */
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

// The Web Speech API's recognition half is a draft the DOM lib does not ship: `SpeechRecognitionResult`,
// `SpeechRecognitionEvent` and `SpeechRecognitionErrorEvent` are there, the controller and its two
// constructor names are not.
declare global {
    interface SpeechRecognition extends EventTarget {
        lang: string;
        continuous: boolean;
        interimResults: boolean;
        maxAlternatives: number;
        start(): void;
        stop(): void;
        abort(): void;
        onstart: ((this: SpeechRecognition, ev: Event) => unknown) | null;
        onend: ((this: SpeechRecognition, ev: Event) => unknown) | null;
        onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => unknown) | null;
        onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => unknown) | null;
        onspeechstart: ((this: SpeechRecognition, ev: Event) => unknown) | null;
        onspeechend: ((this: SpeechRecognition, ev: Event) => unknown) | null;
    }

    interface Window {
        SpeechRecognition?: new () => SpeechRecognition;
        webkitSpeechRecognition?: new () => SpeechRecognition;
    }
}
