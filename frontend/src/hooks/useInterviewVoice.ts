import { useCallback, useEffect, useRef, useState } from "react";

import { browserSpeaker, createReader, loadVoices, micBlockedReason, pickTranscriber, pickVoice, type Transcriber, type VoiceReader } from "@/lib/voice";

/** The interviewer speaking (VOICE.md step 1). One reader per reply, and the reader outlives the
 *  component only until unmount: an utterance left queued keeps talking over the next screen. */
export function useSpeaker(enabled: boolean) {
    // "This browser has a voice at all", true only after the async list lands and has something in
    // it. False on a Chrome for Linux built without a speech service, and on any browser whose
    // voices are all loaded from a service the page cannot reach.
    const [available, setAvailable] = useState(false);
    const voice = useRef<SpeechSynthesisVoice | null>(null);
    const reader = useRef<VoiceReader | null>(null);
    const on = useRef(false);

    useEffect(() => {
        if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
        let alive = true;
        void loadVoices().then((list) => {
            if (!alive) return;
            voice.current = pickVoice(list);
            setAvailable(list.length > 0);
        });
        return () => {
            alive = false;
        };
    }, []);

    const stop = useCallback(() => {
        reader.current?.stop();
        reader.current = null;
        // Belt and braces: the reader's abort cancels what it queued, this cancels anything else the
        // document is holding. Off, and on the way out, nothing may keep speaking.
        if (typeof window !== "undefined" && "speechSynthesis" in window) speechSynthesis.cancel();
    }, []);

    useEffect(() => {
        // Availability is part of the decision: a browser with no voice at all must not be told to
        // speak, whatever the stored preference says.
        on.current = enabled && available;
        if (!on.current) stop();
    }, [enabled, available, stop]);
    // Unmount, or leaving the route: an utterance outlives the component that queued it (gotcha 5).
    useEffect(() => stop, [stop]);

    /** Take the voice over from whatever is speaking and start a fresh queue. A no-op while voice is
     *  off, so the chat surface can drive this unconditionally and the decision stays in one place. */
    const begin = useCallback(() => {
        stop();
        if (on.current) reader.current = createReader(browserSpeaker(voice.current));
    }, [stop]);

    return {
        available,
        begin,
        push: useCallback((delta: string) => reader.current?.push(delta), []),
        flush: useCallback(() => reader.current?.flush(), []),
        /** One line, now: a replay, or the opening line. Takes the voice from anything mid-sentence. */
        say: useCallback(
            (text: string) => {
                begin();
                reader.current?.push(text);
                reader.current?.flush();
            },
            [begin],
        ),
        stop,
    };
}

/** A take left running is a stuck screen and, on the cloud engine, a bill on the shared budget
 *  (VOICE.md gotcha 8): it stops itself well inside both. */
export const MAX_TAKE_S = 180;

const NOTHING_HEARD = "Nothing was heard, so nothing was added to your answer. Try again, or type it.";
const ENGINE_ENDED = "Your browser ended the take early. Anything it caught is in your answer, so press the mic again to keep going.";
const CAPPED = "Stopped at the three-minute cap.";

/** The applicant speaking (VOICE.md step 2). Press to start, press to stop, and the words land in
 *  the answer box for the applicant to confirm or edit: the transcript is what gets scored (V5). */
export function useRecorder(onWords: (text: string) => void) {
    const [recording, setRecording] = useState(false);
    const [hearing, setHearing] = useState(false);
    const [elapsed, setElapsed] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const rec = useRef<Transcriber | null>(null);
    const words = useRef("");
    const startedAt = useRef(0);
    const capped = useRef(false);
    const done = useRef(onWords);
    useEffect(() => {
        done.current = onWords;
    }, [onWords]);

    const finish = useCallback((failure: string | null, byEngine: boolean) => {
        const heard = words.current.trim();
        words.current = "";
        rec.current = null;
        setRecording(false);
        setHearing(false);
        setElapsed(0);
        setError(failure);
        // A take that ended badly still hands over what it caught: losing words the applicant said
        // to punish them for a dropped connection is the worse failure.
        if (heard) {
            done.current(heard);
            setNotice(capped.current ? CAPPED : !failure && byEngine ? ENGINE_ENDED : null);
        } else {
            setNotice(failure ? null : NOTHING_HEARD);
        }
    }, []);

    useEffect(() => {
        if (!recording) return;
        const timer = setInterval(() => {
            const secs = (Date.now() - startedAt.current) / 1000;
            setElapsed(Math.min(secs, MAX_TAKE_S));
            if (secs >= MAX_TAKE_S && !capped.current) {
                capped.current = true;
                rec.current?.stop();
            }
        }, 1000);
        return () => clearInterval(timer);
    }, [recording]);

    // Leaving the route: the engine holds the microphone until it is told to let go.
    useEffect(
        () => () => {
            rec.current?.cancel();
            rec.current = null;
        },
        [],
    );

    /** Why the mic cannot run here, or null when it can. Read once: a browser does not grow one. */
    const blocked = useState(micBlockedReason)[0];

    const start = useCallback(() => {
        if (rec.current) return;
        const reason = micBlockedReason();
        setError(reason);
        setNotice(null);
        if (reason) return;
        words.current = "";
        capped.current = false;
        startedAt.current = Date.now();
        setElapsed(0);
        setHearing(false);
        setRecording(true);
        const next = pickTranscriber({
            onWords: (text) => {
                words.current = text;
            },
            onSpeech: setHearing,
            onEnd: finish,
        });
        rec.current = next;
        next.start();
    }, [finish]);

    return {
        /** Non-null when no take can run here: the button is dead, and this says why. */
        blocked,
        recording,
        hearing,
        elapsed,
        error,
        notice,
        start,
        stop: useCallback(() => rec.current?.stop(), []),
        /** The answer went out: the last take's note stops being news. */
        clear: useCallback(() => {
            setError(null);
            setNotice(null);
        }, []),
    };
}
