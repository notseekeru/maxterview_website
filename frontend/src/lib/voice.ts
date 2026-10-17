/** Voice I/O around the turn that already exists (VOICE.md).
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

// Speaking: sentence-sized lines, prefetched one ahead, in order.

/** The ceiling on the FIRST line, which is the one that bounds the silence before the interviewer
 *  starts: the shorter it is, the sooner the first word lands. */
const FIRST_CHARS = 140;

/** The ceiling on every line after it. Those are fetched while the previous one is being heard, so
 *  this only decides how much text the caption gets at once, and it is wide enough for a whole
 *  sentence: a cut mid-clause ends on a clipped intonation, a cut at a sentence end is a pause. */
const CHUNK_CHARS = 320;

/** A sentence end: `.!?` plus any closing punctuation, or a newline. Not a real segmenter, so an
 *  abbreviation or a decimal splits a line in two. Audible as nothing, because the queue is
 *  serialized and the pieces play back to back in one voice.
 *  AI HERE: swap in a segmenter only if a mis-split ever becomes audible. */
const BREAK = /[.!?]+["')\]]*\s|\n+/g;

/** One line to speak, and where it ends in the stream it came from. `end` is the caption's cut: the
 *  reply is revealed up to here when this line is heard, so the words and the voice share one beat. */
export interface Line {
    text: string;
    end: number;
}

/** `[lines worth speaking now, text held back]`. Held text is the whole contract: a boundary is what
 *  lets the first sentence be heard before the reply has finished streaming. */
function takeLines(text: string, atEnd: boolean, first = FIRST_CHARS, limit = CHUNK_CHARS): { lines: Line[]; rest: string } {
    const lines: Line[] = [];
    let rest = text;
    // Where `rest` starts in `text`: a line's end is reported as an offset into the whole string, not
    // into the piece that happens to be under the scalpel this pass.
    let base = 0;
    for (;;) {
        const cap = lines.length ? limit : first;
        BREAK.lastIndex = 0;
        const m = BREAK.exec(rest);
        const ends = m ? m.index + m[0].length : -1;
        if (ends > 0 && ends <= cap) {
            const line = rest.slice(0, ends).trim();
            if (line) lines.push({ text: line, end: base + ends });
            rest = rest.slice(ends);
            base += ends;
            continue;
        }
        if (rest.length > cap) {
            // No sentence end within reach: cut at the last word that fits, so one long clause is
            // heard now instead of the whole reply being heard late.
            const cut = Math.max(rest.lastIndexOf(" ", cap), 1);
            const line = rest.slice(0, cut).trim();
            if (line) lines.push({ text: line, end: base + cut });
            rest = rest.slice(cut);
            base += cut;
            continue;
        }
        break;
    }
    if (atEnd) {
        const tail = rest.trim();
        if (tail) lines.push({ text: tail, end: base + rest.length });
        rest = "";
    }
    return { lines, rest };
}

if (import.meta.env.DEV) {
    const held = takeLines("One. Two", false);
    console.assert(held.lines.length === 1 && held.lines[0].text === "One." && held.rest === "Two", "voice: the chunker stopped holding text back", held);
    // The offset is the caption's cut, so it has to land after the sentence and its break, or the
    // revealed text loses the space in front of the next one.
    console.assert("One. Two".slice(0, held.lines[0].end) === "One. ", "voice: a line's end is not where the caption cuts", held.lines[0].end);
    // A clause with no sentence end in it: every line still respects the ceiling, and nothing is
    // dropped or said twice between what is spoken and what is held back.
    const wrapped = takeLines("x ".repeat(2 * CHUNK_CHARS), false, CHUNK_CHARS, CHUNK_CHARS);
    const whole = `${wrapped.lines.map((l) => l.text).join("")}${wrapped.rest}`.replace(/\s+/g, "");
    console.assert(wrapped.lines.every((l) => l.text.length <= CHUNK_CHARS) && whole === "x".repeat(2 * CHUNK_CHARS), "voice: long unbroken text lost or duplicated a line", wrapped.lines.length, wrapped.rest.length);
}

/** One voice, one line at a time. Implementations must never overlap two lines (VOICE.md gotcha 9). */
export interface Speaker<T> {
    /** Fetch one line's audio. Run ahead of playback, so it must make no sound. */
    load(text: string, signal: AbortSignal): Promise<T>;
    /** Play a loaded line to completion, reporting the moment it becomes audible. Resolves `true` when
     *  the line was heard and `false` when it was not (a refused autoplay, a decode failure), and
     *  resolves in every terminal state: a line that never settles wedges the queue behind it. */
    play(clip: T, signal: AbortSignal, onStart: () => void): Promise<boolean>;
}

/** What the reader reports back. `onSpoken` is the caption's clock: the caller reveals the reply up to
 *  that offset, so the reader is what keeps the words and the voice on the same beat. */
interface ReaderSink {
    onSpoken(chars: number): void;
    /** The queue is empty and the stream has ended: nothing is held back any more. */
    onDrained(): void;
}

export interface VoiceReader {
    push(delta: string): void;
    flush(): void;
    /** Cancel from here on. Audio outlives the component that asked for it, so this is not optional
     *  on unmount or a route change (VOICE.md gotcha 5). */
    stop(): void;
}

/** A line on its way to being heard, plus its audio fetch once there is one to make. */
interface Job<T> {
    text: string;
    end: number;
    audio?: Promise<T>;
}

/** Lines are fetched one ahead of playback. That lookahead is the whole seamlessness of this file:
 *  without it every sentence waits a round trip after the one before it has finished, which is heard
 *  as a stitched-together monologue rather than a person talking. One line of lookahead is also the
 *  whole waste: turning the voice off mid-reply has already paid for the next line. */
export function createReader<T>(speaker: Speaker<T>, sink: ReaderSink): VoiceReader {
    const ctl = new AbortController();
    const { signal } = ctl;
    // Held-back text, and how much of the stream has been received: an offset in the stream is
    // `seen - buf.length + line.end`, which is what the caption slices on.
    let buf = "";
    let seen = 0;
    let jobs: Job<T>[] = [];
    let loading: Job<T> | null = null;
    let ended = false;
    let drained = false;
    let running = false;

    const fetchAudio = (job: Job<T>) => {
        const audio = speaker.load(job.text, signal);
        // Handled now, awaited later: a rejection that lands while the previous line is still playing
        // is not an unhandled rejection, it is the next iteration's problem.
        audio.catch(() => undefined);
        return audio;
    };

    /** Keep the earliest line that still needs its audio in flight, and no more than one: starting the
     *  next fetch the moment the current line arrives is what removes the gap between two sentences,
     *  since a line only waits for its audio when the voice is not already busy with the one before. */
    function preload(): void {
        if (loading) return;
        const job = jobs.find((j) => !j.audio);
        if (!job) return;
        loading = job;
        job.audio = fetchAudio(job);
        void job.audio.then(clear, clear);
        function clear() {
            if (loading === job) loading = null;
            preload();
        }
    }

    async function run(): Promise<void> {
        if (running) return;
        running = true;
        while (!signal.aborted) {
            const job = jobs[0];
            if (!job) break;
            preload(); // its audio is either in flight or about to be
            let clip: T;
            try {
                // `preload()` leaves a fetch in flight for this line; the cast is only because TS cannot
                // see that a generic `T` is not a promise of itself.
                clip = (await job.audio) as T;
            } catch {
                // Nothing was heard, so nothing is held back: a line nobody heard cannot hold the caption.
                jobs.shift();
                sink.onSpoken(job.end);
                continue;
            }
            jobs.shift();
            if (signal.aborted) break;
            if (!(await speaker.play(clip, signal, () => sink.onSpoken(job.end)))) sink.onSpoken(job.end);
        }
        running = false;
        if (ended && !drained && !signal.aborted && !jobs.length) {
            drained = true;
            sink.onDrained();
        }
    }

    return {
        push(delta) {
            if (signal.aborted) return;
            const base = seen - buf.length;
            seen += delta.length;
            const { lines, rest } = takeLines(buf + delta, false);
            for (const line of lines) jobs.push({ text: line.text, end: base + line.end });
            buf = rest;
            preload();
            void run();
        },
        flush() {
            if (signal.aborted) return;
            const base = seen - buf.length;
            const { lines } = takeLines(buf, true);
            for (const line of lines) jobs.push({ text: line.text, end: base + line.end });
            buf = "";
            ended = true;
            preload();
            void run();
        },
        stop() {
            ctl.abort();
            buf = "";
            jobs = [];
        },
    };
}

if (import.meta.env.DEV) {
    // Order, and the lookahead, are the parts no single unit test of the chunker can see. A fake
    // speaker is the only way to watch the interleaving.
    void (async () => {
        const stream = "One. Two. Three.";
        const heard: string[] = [];
        const gate: number[] = [];
        let loading = 0;
        let overlapped = false;
        const fake: Speaker<string> = {
            async load(text) {
                loading += 1;
                return text;
            },
            async play(clip, _signal, onStart) {
                overlapped ||= loading > 1;
                loading -= 1;
                onStart();
                heard.push(clip);
                return true;
            },
        };
        const reader = createReader(fake, { onSpoken: (chars) => gate.push(chars), onDrained: () => undefined });
        reader.push(stream);
        reader.flush();
        await new Promise((r) => setTimeout(r, 10));
        console.assert(heard.join(" ") === stream, "voice: the reader dropped, reordered or merged a line", heard);
        let from = 0;
        const aligned =
            gate.length === heard.length &&
            gate.every((end, i) => {
                const ok = stream.slice(from, end).trim() === heard[i];
                from = end;
                return ok;
            });
        console.assert(aligned, "voice: the caption's cut does not match the words being said", gate, heard);
        console.assert(overlapped, "voice: each line waits for the one before it to finish, so every sentence pays a round trip", heard);
    })();
}

/** How long a line gets to become audible before it is written off. The audio is already in hand at
 *  this point, so decoding it is milliseconds: five seconds means a media stack that has stopped
 *  answering, and the queue (and with it the caption) must not sit behind it for the whole session. */
const AUDIBLE_MS = 5000;

/** Play one decoded clip to completion. Every terminal state resolves, including a decode failure, a
 *  refused autoplay and a pipeline that never starts: an utterance that never resolves wedges the
 *  queue behind it, and the queue is the whole feature. The blob URL is revoked by the caller once
 *  this settles. */
function play(url: string, signal: AbortSignal, onStart: () => void): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const el = new Audio(url);
        let heard = false;
        let watchdog: ReturnType<typeof setTimeout> | undefined;
        const finish = () => {
            signal.removeEventListener("abort", onAbort);
            clearTimeout(watchdog);
            el.onplaying = null;
            el.onended = null;
            el.onerror = null;
            resolve(heard);
        };
        function onAbort() {
            el.pause();
            finish();
        }
        // `playing`, not the `play()` promise: the caption is released on this callback, and it has to
        // land with the sound rather than with the request to make it.
        el.onplaying = () => {
            if (heard) return;
            heard = true;
            onStart();
        };
        el.onended = finish;
        el.onerror = finish;
        signal.addEventListener("abort", onAbort, { once: true });
        void el.play().catch(finish);
        watchdog = setTimeout(() => {
            if (heard) return;
            el.pause(); // written off, and not left to start talking under the next line
            finish();
        }, AUDIBLE_MS);
    });
}

/** The cloud speaker. `fetchAudio` is injected rather than imported so this file stays free of the API
 *  client, and so the reader can be driven by a plain function in a test. */
export function cloudSpeaker(fetchAudio: (text: string, signal: AbortSignal) => Promise<Blob>): Speaker<Blob> {
    return {
        load: (text, signal) => fetchAudio(text, signal),
        async play(blob, signal, onStart) {
            const url = URL.createObjectURL(blob);
            try {
                return await play(url, signal, onStart);
            } finally {
                URL.revokeObjectURL(url);
            }
        },
    };
}

/** What the recorder reports. One channel: the take started, how loud it is, and how it ended. */
interface TranscriptionSink {
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

function pickRecordingType(): string | undefined {
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
    // The analyser needs a context, and a context holds an audio thread until it is closed. One per
    // take with nothing closing them accumulates for the life of the page.
    let audio: AudioContext | null = null;
    let mediaType: string | undefined;
    let settled = false;
    let handed = false;

    const release = () => {
        cancelAnimationFrame(meter);
        meter = 0;
        for (const track of stream?.getTracks() ?? []) track.stop();
        stream = null;
        recorder = null;
        void audio?.close().catch(() => undefined);
        audio = null;
    };

    const finish = (error: string | null) => {
        if (settled) return;
        settled = true;
        release();
        sink.onLevel(0);
        sink.onEnd(error);
    };

    /** The clip is uploaded and discarded server-side, and the wait scales with its length: ~18s for 90
     *  seconds of audio, since Whisper is batch (VOICE.md latency). `upload` rejects with a message
     *  written for the applicant: this file stays API-free and the caller owns that translation. */
    const deliver = async (clip: Blob) => {
        // One clip, one upload: stop twice and the second press must not bill a second transcription.
        if (handed) return;
        handed = true;
        try {
            sink.onWords(await upload(clip));
            finish(null);
        } catch (e: unknown) {
            finish(e instanceof Error && e.message ? e.message : "The recording could not be transcribed. Try again, or type your answer.");
        }
    };

    /** The take is over: the recorder is stopped, so the clip is whatever it buffered. An inactive
     *  recorder fires no stop event, and a take that never settles is a stuck screen. */
    const finishClip = () => {
        // Already handed off, or the take ended some other way: one press, one clip, one upload.
        if (handed || settled) return;
        const clip = new Blob(chunks, { type: recorder?.mimeType || mediaType || "audio/webm" });
        chunks = [];
        if (!clip.size) {
            finish("Nothing was recorded, so nothing was added to your answer. Try again, or type it.");
            return;
        }
        void deliver(clip);
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
                if (settled) {
                    // The take ended while the prompt was up, so nothing will release these tracks.
                    for (const track of stream.getTracks()) track.stop();
                    stream = null;
                    return;
                }
                mediaType = pickRecordingType();
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
                recorder.onstop = finishClip;
                // Guarded: a stream the recorder will not accept throws here, and an uncaught throw left
                // the take looking live until the cap.
                try {
                    recorder.start();
                    audio = new AudioContext();
                    const analyser = audio.createAnalyser();
                    analyser.fftSize = 1024;
                    audio.createMediaStreamSource(stream).connect(analyser);
                    const frame = new Uint8Array(analyser.fftSize);
                    const tick = () => {
                        sink.onLevel(levelOf(analyser, frame));
                        meter = requestAnimationFrame(tick);
                    };
                    meter = requestAnimationFrame(tick);
                } catch {
                    try {
                        recorder.stop();
                    } catch {
                        undefined; // never started
                    }
                    finish("The recorder could not start on this device. Type your answer instead.");
                }
            })();
        },
        stop() {
            // Nothing more is metered: the take is over the moment it is asked to be.
            cancelAnimationFrame(meter);
            meter = 0;
            const take = recorder;
            const live = take !== null && take.state !== "inactive";
            if (live) {
                try {
                    take.stop();
                } catch {
                    undefined; // raced with the recorder going inactive: the clip still has to settle
                }
            }
            // Stop the tracks with the recorder: a live microphone after the take is a lit indicator
            // for nothing (VOICE.md gotcha 8).
            for (const track of stream?.getTracks() ?? []) track.stop();
            if (!live) finishClip();
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
