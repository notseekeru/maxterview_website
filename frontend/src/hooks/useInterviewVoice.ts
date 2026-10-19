import { useCallback, useEffect, useRef, useState } from "react";

import { apiDetail, getVoiceCapability, synthesizeSpeech, transcribeAudio, type VoiceCapability } from "@/lib/api";
import { cloudSpeaker, cloudTranscriber, createReader, micBlockedReason, type Transcriber, type VoiceReader } from "@/lib/voice";

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
        setSpoken(null);
    }, []);

    useEffect(() => {
        on.current = enabled;
        if (!enabled) stop();
    }, [enabled, stop]);
    // Unmount, or leaving the route: playback outlives the component that asked for it (gotcha 5).
    useEffect(() => stop, [stop]);

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
        begin: useCallback(() => start(true), [start]),
        push: useCallback((delta: string) => reader.current?.push(delta), []),
        flush: useCallback(() => reader.current?.flush(), []),
        say: useCallback(
            (text: string) => {
                start(false);
                reader.current?.push(text);
                reader.current?.flush();
            },
            [start],
        ),
        stop,
        spoken,
    };
}

export const MAX_TAKE_S = 180;

const NOTHING_HEARD = "Nothing was heard in that take, so nothing was added to your answer. Try again, or type it.";
const CAPPED = "Stopped at the three-minute cap.";
const NO_STT = "Speech can't be transcribed here: this server has no transcription configured. Type your answer instead.";

export function useRecorder(capability: VoiceCapability | null, onWords: (text: string) => void) {
    const [recording, setRecording] = useState(false);
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
        ready: capability !== null,
        blocked,
        recording,
        transcribing,
        busy: recording || transcribing,
        level,
        elapsed,
        error,
        notice,
        start,
        stop,
        clear: useCallback(() => {
            setError(null);
            setNotice(null);
        }, []),
    };
}
