// Speaking: sentence-sized lines, prefetched one ahead, in order.

const FIRST_CHARS = 140;

const CHUNK_CHARS = 320;

// AI HERE: swap in a segmenter only if a mis-split ever becomes audible.
const BREAK = /[.!?]+["')\]]*\s|\n+/g;

export interface Line {
    text: string;
    end: number;
}

function takeLines(text: string, atEnd: boolean, first = FIRST_CHARS, limit = CHUNK_CHARS): { lines: Line[]; rest: string } {
    const lines: Line[] = [];
    let rest = text;
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
    console.assert("One. Two".slice(0, held.lines[0].end) === "One. ", "voice: a line's end is not where the caption cuts", held.lines[0].end);
    const wrapped = takeLines("x ".repeat(2 * CHUNK_CHARS), false, CHUNK_CHARS, CHUNK_CHARS);
    const whole = `${wrapped.lines.map((l) => l.text).join("")}${wrapped.rest}`.replace(/\s+/g, "");
    console.assert(wrapped.lines.every((l) => l.text.length <= CHUNK_CHARS) && whole === "x".repeat(2 * CHUNK_CHARS), "voice: long unbroken text lost or duplicated a line", wrapped.lines.length, wrapped.rest.length);
}

export interface Speaker<T> {
    load(text: string, signal: AbortSignal): Promise<T>;
    play(clip: T, signal: AbortSignal, onStart: () => void): Promise<boolean>;
}

interface ReaderSink {
    onSpoken(chars: number): void;
    onDrained(): void;
}

export interface VoiceReader {
    push(delta: string): void;
    flush(): void;
    stop(): void;
}

interface Job<T> {
    text: string;
    end: number;
    audio?: Promise<T>;
}

export function createReader<T>(speaker: Speaker<T>, sink: ReaderSink): VoiceReader {
    const ctl = new AbortController();
    const { signal } = ctl;
    let buf = "";
    let seen = 0;
    let jobs: Job<T>[] = [];
    let loading: Job<T> | null = null;
    let ended = false;
    let drained = false;
    let running = false;

    const fetchAudio = (job: Job<T>) => {
        const audio = speaker.load(job.text, signal);
        audio.catch(() => undefined);
        return audio;
    };

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
                clip = (await job.audio) as T;
            } catch {
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

const AUDIBLE_MS = 5000;

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

interface TranscriptionSink {
    onWords(text: string): void;
    onLevel(level: number): void;
    onEnd(error: string | null): void;
}

export interface Transcriber {
    start(): void;
    stop(): void;
    cancel(): void;
}

export function micBlockedReason(): string | null {
    if (!window.isSecureContext) return "Microphone capture needs HTTPS (localhost counts). Type your answer instead.";
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return "This browser cannot record audio. Type your answer instead.";
    return null;
}

const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

function pickRecordingType(): string | undefined {
    if (typeof MediaRecorder === "undefined") return undefined;
    return RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

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

    const deliver = async (clip: Blob) => {
        if (handed) return;
        handed = true;
        try {
            sink.onWords(await upload(clip));
            finish(null);
        } catch (e: unknown) {
            finish(e instanceof Error && e.message ? e.message : "The recording could not be transcribed. Try again, or type your answer.");
        }
    };

    const finishClip = () => {
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
            cancelAnimationFrame(meter);
            meter = 0;
            const take = recorder;
            const live = take !== null && take.state !== "inactive";
            if (live) {
                try {
                    take.stop();
                } catch {
                    undefined; // already inactive: the clip still settles below
                }
            }
            // Stop the tracks with the recorder: a live microphone after the take is a lit indicator
            // for nothing.
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

function permissionMessage(e: unknown): string {
    const name = (e as { name?: string })?.name;
    if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access is blocked. Allow it in this site's settings, then reload the page.";
    if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found. Check which input your system has selected, then reload the page.";
    if (name === "NotReadableError") return "The microphone is held by another application. Close it, then reload the page.";
    return "The microphone could not be opened. Type your answer instead.";
}

const PREF_KEY = "maxterview.voice";

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
