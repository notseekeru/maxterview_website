import { useCallback, useEffect, useRef, useState } from "react";

import { apiDetail, getVoiceCapability, synthesizeSpeech, transcribeAudio, type VoiceCapability } from "@/lib/api";
import { cloudSpeaker, cloudTranscriber, createReader, micBlockedReason, type Transcriber, type VoiceReader } from "@/lib/voice";

/** What this server can do, fetched once per mount. It is deployment config rather than run state, and
 *  a failed probe is NOT the same fact as a server without voice: claiming the second from the first
 *  tells the visitor to stop trying for a reason that is not true. One retry, then say so. */
export function useVoiceCapability(): { capability: VoiceCapability | null; failed: boolean } {
    const [capability, setCapability] = useState<VoiceCapability | null>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let alive = true;
        let retry: ReturnType<typeof setTimeout> | undefined;
        const load = (attempt: number) => {
            void getVoiceCapability()
                .then((got) => {
                    if (alive) setCapability(got);
                })
                .catch(() => {
                    if (!alive) return;
                    if (attempt === 0) retry = setTimeout(() => load(1), 800);
                    else setFailed(true);
                });
        };
        load(0);
        return () => {
            alive = false;
            clearTimeout(retry);
        };
    }, []);
    return { capability, failed };
}

/** The interviewer speaking (VOICE.md step 1). One reader per reply, and the reader outlives the
 *  component only until unmount: audio left queued keeps talking over the next screen.
 *
 *  `spoken` is the caption's clock: while the voice is on, the reply is revealed up to what has been
 *  said out loud, so the words and the audio share one beat instead of the text running a whole reply
 *  ahead of the voice. It is null whenever nothing is held back, which is every case with no voice to
 *  sync to: voice off, a replay, or a queue that has drained. */
export function useSpeaker(enabled: boolean) {
    const reader = useRef<VoiceReader | null>(null);
    const on = useRef(false);
    // Reader generations: a stopped reader's callbacks land after the next one has started, and they say
    // nothing about the line being spoken now.
    const gen = useRef(0);
    const [spoken, setSpoken] = useState<number | null>(null);

    const stop = useCallback(() => {
        gen.current += 1;
        reader.current?.stop();
        reader.current = null;
        // Nothing is being said, so nothing stays held back.
        setSpoken(null);
    }, []);

    useEffect(() => {
        on.current = enabled;
        if (!enabled) stop();
    }, [enabled, stop]);
    // Unmount, or leaving the route: playback outlives the component that asked for it (gotcha 5).
    useEffect(() => stop, [stop]);

    /** Take the voice over from whatever is playing and start a fresh queue. A no-op while voice is
     *  off, so the chat surface drives this unconditionally and the decision stays in one place. */
    const start = useCallback(
        (gate: boolean) => {
            stop();
            if (!on.current) return;
            const id = gen.current;
            reader.current = createReader(cloudSpeaker(synthesizeSpeech), {
                onSpoken: (chars) => {
                    if (id === gen.current) setSpoken(chars);
                },
                onDrained: () => {
                    if (id === gen.current) setSpoken(null);
                },
            });
            if (gate) setSpoken(0);
        },
        [stop],
    );

    return {
        /** A reply is starting: the caption is held back to what has been said out loud. */
        begin: useCallback(() => start(true), [start]),
        push: useCallback((delta: string) => reader.current?.push(delta), []),
        flush: useCallback(() => reader.current?.flush(), []),
        /** One line, now: a replay of a reply that is already on screen. Takes the voice from anything
         *  mid-sentence, and never gates the caption. */
        say: useCallback(
            (text: string) => {
                start(false);
                reader.current?.push(text);
                reader.current?.flush();
            },
            [start],
        ),
        stop,
        /** How much of the reply has been said out loud, or null when nothing is held back. */
        spoken,
    };
}

/** A take left running is a stuck screen and, on the cloud engine, a bill on the shared budget
 *  (VOICE.md gotcha 8): it stops itself well inside both. */
export const MAX_TAKE_S = 180;

const NOTHING_HEARD = "Nothing was heard in that take, so nothing was added to your answer. Try again, or type it.";
const CAPPED = "Stopped at the three-minute cap.";
const NO_STT = "Speech can't be transcribed here: this server has no transcription configured. Type your answer instead.";

/** The applicant speaking (VOICE.md step 2). Press to start, press to stop, and the words land in the
 *  answer box for the applicant to confirm or edit: the transcript is what gets scored (V5). */
export function useRecorder(capability: VoiceCapability | null, onWords: (text: string) => void) {
    const [recording, setRecording] = useState(false);
    // The microphone is off and the clip is with the server. Separate from `recording` because the wait
    // is 7-18s of Whisper (VOICE.md latency) and counting it as a take is a screen that looks stuck.
    const [transcribing, setTranscribing] = useState(false);
    const [level, setLevel] = useState(0);
    const [elapsed, setElapsed] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const rec = useRef<Transcriber | null>(null);
    const startedAt = useRef(0);
    const capped = useRef(false);
    const done = useRef(onWords);
    useEffect(() => {
        done.current = onWords;
    }, [onWords]);

    /** Read once: a browser does not grow a microphone, and the server's answer does not change
     *  without a reload. Both are known before the first take, so neither can surprise a take. */
    const mounted = useState(micBlockedReason)[0];
    const blocked = mounted ?? (capability && !capability.stt ? NO_STT : null);

    const finish = useCallback((failure: string | null) => {
        rec.current = null;
        setRecording(false);
        setTranscribing(false);
        setLevel(0);
        setElapsed(0);
        setError(failure);
    }, []);

    const sink = useCallback(
        (): Parameters<typeof cloudTranscriber>[1] => ({
            onWords: (text: string) => {
                const clean = text.trim();
                if (clean) {
                    done.current(clean);
                    setNotice(capped.current ? CAPPED : null);
                } else {
                    setNotice(NOTHING_HEARD);
                }
            },
            onLevel: setLevel,
            onEnd: finish,
        }),
        [finish],
    );

    /** Press stop. The take ends here and the microphone is released: the words are already on their
     *  way, so the screen says what is being waited on instead of still counting a take that is over. */
    const stop = useCallback(() => {
        const take = rec.current;
        if (!take) return;
        take.stop();
        // A take that ended inside stop() (an empty clip) has already said so and cleared the ref.
        if (rec.current === take) {
            setRecording(false);
            setTranscribing(true);
            setLevel(0);
        }
    }, []);

    useEffect(() => {
        if (!recording) return;
        const timer = setInterval(() => {
            const secs = (Date.now() - startedAt.current) / 1000;
            setElapsed(Math.min(secs, MAX_TAKE_S));
            if (secs >= MAX_TAKE_S && !capped.current) {
                capped.current = true;
                stop();
            }
        }, 1000);
        return () => clearInterval(timer);
    }, [recording, stop]);

    // Leaving the route: the microphone stays lit until it is told to let go.
    useEffect(
        () => () => {
            rec.current?.cancel();
            rec.current = null;
        },
        [],
    );

    const start = useCallback(() => {
        if (rec.current) return;
        setError(blocked);
        setNotice(null);
        if (blocked) return;
        capped.current = false;
        setTranscribing(false);
        startedAt.current = Date.now();
        setElapsed(0);
        setLevel(0);
        setRecording(true);
        const next = cloudTranscriber(async (clip) => {
            try {
                return (await transcribeAudio(clip)).text;
            } catch (e: unknown) {
                // The server writes its refusals for the applicant (app/voice.py), and apiDetail
                // prefers them over anything generic we could say here.
                throw new Error(apiDetail(e, "The words did not come back. Try again, or type your answer.") ?? "");
            }
        }, sink());
        rec.current = next;
        next.start();
    }, [blocked, sink]);

    return {
        /** Settled answer from the server about its own voice support: until then no control is
         *  offerable, and after it the reason is owed on screen rather than in a tooltip. */
        ready: capability !== null,
        /** Non-null when no take can run here: the button is dead, and this says why. */
        blocked,
        recording,
        /** The take is over and the clip is with the server. */
        transcribing,
        /** Either half of a take is still this screen's to finish, so nothing may be sent until it is not. */
        busy: recording || transcribing,
        level,
        elapsed,
        error,
        notice,
        start,
        stop,
        /** The answer went out: the last take's note stops being news. */
        clear: useCallback(() => {
            setError(null);
            setNotice(null);
        }, []),
    };
}
