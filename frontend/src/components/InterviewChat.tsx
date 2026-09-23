import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Textarea } from "@/components/ui/textarea";
import { MAX_TAKE_S, useRecorder, useSpeaker, useVoiceCapability } from "@/hooks/useInterviewVoice";
import { apiDetail, type Feedback, finishInterview, getFeedback, getInterview, getMessages, httpStatus, MAX_TURN_CHARS, type Message, regenerateFeedback, startInterview, streamChat } from "@/lib/api";
import { OPENING_ASKS_RESUME, OPENING_HAS_RESUME } from "@/lib/config";
import { cn } from "@/lib/utils";
import { readVoicePref, writeVoicePref } from "@/lib/voice";
import { Icon } from "./AppIcons";
import { FeedbackView } from "./FeedbackView";
import { FinishOverlay } from "./FinishOverlay";
import { MoveBadge } from "./MoveBadge";
import { UpgradeNotice } from "./UsageBadge";

interface Props {
    interviewId: string;
    onExit: () => void;
}

const STREAM_FAILED = "The interviewer couldn't answer just now — the model was unreachable. Your turn wasn't saved, so send it again in a moment.";
// The connection died before any frame arrived, so the server never got to name the provider (it does
// that in llm.unreachable_detail). Same advice either way: the panel that fixes it is the same one.
const CONNECTION_LOST = "Connection lost while streaming — the model never answered. If this repeats, test your provider in Settings > Interview engine (BYOK).";

// The header reads as a state of the interview, not as the wire value behind it (the API and the DB
// keep `completed`, which is the status the list, analytics and feedback endpoints filter on).
const STATUS_LABELS = { loading: "Starting", ready: "In progress", streaming: "Interviewer is replying", completed: "Finished" } as const;

/** How long the finished progress screen stays up with every stage checked before it closes onto the
 *  review. Covers the scroll to top and the first paint of the feedback behind it. */
const DONE_HOLD_MS = 1200;

export function InterviewChat({ interviewId, onExit }: Props) {
    const [status, setStatus] = useState<"loading" | "ready" | "streaming" | "completed">("loading");
    const [messages, setMessages] = useState<Message[]>([]);
    const [draft, setDraft] = useState("");
    const [assistBuf, setAssistBuf] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<Feedback | null>(null);
    const [quotaLocked, setQuotaLocked] = useState(false);
    const [interviewOver, setInterviewOver] = useState(false);
    const [hardcoreRun, setHardcoreRun] = useState(false);
    const [hardcoreFailed, setHardcoreFailed] = useState<{ turn: number; class: string } | null>(null);
    // Non-null while a finish or rebuild request is in flight: what the progress screen calls it,
    // whether the candidate closed it, and whether the review has landed. Closing never cancels the
    // request behind it.
    const [finishing, setFinishing] = useState<{ title: string; dismissed: boolean; done: boolean } | null>(null);
    const isFinishing = finishing !== null;
    // /finish refuses a transcript with no gradable turn, so the button stays dead until the
    // candidate has said something. Without this the progress screen flashes for a request that
    // cannot land.
    const answered = messages.some((m) => m.role === "user");
    const [reviewFailed, setReviewFailed] = useState(false);
    // Mid-run Finish needs a second look: the arc still has questions left, so ending here trades
    // them for the review. At the cap there is nothing left to trade, so the click goes straight
    // through. Reset by anything that leaves the footer.
    const [confirmFinish, setConfirmFinish] = useState(false);
    const [hasResume, setHasResume] = useState(false);
    const sendingRef = useRef(false);
    const abortRef = useRef<AbortController | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    const opening = hasResume ? OPENING_HAS_RESUME : OPENING_ASKS_RESUME;
    const [voiceOn, setVoiceOn] = useState(readVoicePref);
    // Voice is I/O around the turn: the applicant's speech lands in the answer box, the interviewer's
    // reply is read aloud, and everything after that is the pipeline that already exists (VOICE.md).
    // The server is asked what it can do before anything is offered, so a deployment without Workers
    // AI shows a dead control with a reason instead of a button that fails on click.
    const { capability, failed: capabilityFailed } = useVoiceCapability();
    const speaker = useSpeaker(voiceOn && Boolean(capability?.tts));
    const mic = useRecorder(
        capability,
        useCallback((text: string) => {
            if (!text) return;
            setDraft((d) => (d.trim() ? `${d.trimEnd()} ${text}` : text).slice(0, MAX_TURN_CHARS));
        }, []),
    );
    const voiceTitle = capability?.tts ? (voiceOn ? "Stop reading replies aloud" : "Read each reply aloud") : undefined;
    // Voice limits belong to the server, not the run, so they are stated on screen where the controls
    // are. A title attribute is not enough: the buttons that need the explanation are disabled, and a
    // hairline under the pointer is not where a stuck visitor looks. A probe that FAILED is a third
    // state: the controls stay off, and the line says the check did not happen rather than inventing a
    // deployment without voice.
    const voiceNote = capabilityFailed ? "Voice couldn't be checked just now, so both controls are off. Reload to try again." : capability && !capability.tts ? "Replies can't be read aloud: this server has no speech voice configured." : null;
    const micProblem = mic.blocked ?? mic.error;
    const placeholder = mic.recording
        ? "Listening: press Stop to put your words here"
        : status === "completed"
          ? "Review above"
          : interviewOver
            ? "Interview finished. Press ✓ at the top right for your feedback"
            : confirmFinish
              ? "Ending here skips the rest"
              : status === "ready"
                ? "Type your answer, or press the microphone to speak"
                : status === "streaming"
                  ? "Waiting for the interviewer..."
                  : "Starting…";

    const loadMessages = useCallback(async () => {
        try {
            const rows = await getMessages(interviewId);
            setMessages(rows);
            return rows;
        } catch {
            setError("Could not load conversation.");
            return null;
        }
    }, [interviewId]);

    const loadExisting = useCallback(
        async (id: string) => {
            const [iv] = await Promise.all([getInterview(id), loadMessages()]);
            setHasResume(Boolean(iv.resume_id));
            setHardcoreRun(iv.hardcore);
            // A failed hardcore run is dead in the DB before it is finished, so reopening one has to
            // show the ending and close the composer: the stream event only covers the session that
            // watched it happen. Finish stays the candidate's click either way.
            if (iv.failed_turn) {
                setHardcoreFailed({ turn: iv.failed_turn, class: iv.failed_class ?? "fault" });
                setInterviewOver(true);
            }
            if (iv.status !== "completed") return "ready" as const;
            try {
                setFeedback(await getFeedback(id));
            } catch (e: unknown) {
                if (httpStatus(e) === 404) setReviewFailed(true);
            }
            return "completed" as const;
        },
        [loadMessages],
    );

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const started = await startInterview(interviewId);
                if (cancelled) return;
                setHasResume(Boolean(started.resume_id));
                setHardcoreRun(Boolean(started.hardcore));
                await loadMessages();
                setStatus("ready");
            } catch (e: unknown) {
                if (!cancelled) {
                    const st = httpStatus(e);
                    if (st !== 409) {
                        setError("Could not start interview.");
                        setStatus("ready");
                    } else {
                        setStatus(await loadExisting(interviewId));
                    }
                }
            }
        })();
        return () => {
            cancelled = true;
            abortRef.current?.abort();
        };
    }, [interviewId, loadMessages, loadExisting]);

    // The composer grows with the answer and stops at nine lines, then scrolls inside the pill. A
    // pasted paragraph should not push the transcript off the screen.
    // AI HERE: fixed pixel cap and a layout-forced reflow per keystroke. Upgrade path is a measure
    // in useLayoutEffect keyed on value length only.
    // biome-ignore lint/correctness/useExhaustiveDependencies: el.scrollHeight is a function of draft, which no linter can see through the DOM.
    useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    }, [draft]);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }, []);

    useEffect(() => {
        if (feedback) scrollRef.current?.scrollTo({ top: 0 });
    }, [feedback]);

    // The opening line is a reply, so it is read aloud too, but only when voice was already on: the
    // click that turns it on is the gesture that lets audio play (VOICE.md gotcha 5).
    const openingSpoken = useRef(false);
    useEffect(() => {
        if (openingSpoken.current || !voiceOn || !capability?.tts || status === "loading" || feedback || messages.length || !opening) return;
        // Deferred past this commit: StrictMode runs this effect, cancels it and runs it again, so
        // speaking inline would be stopped by our own cleanup before it was audible. A dev-only
        // silence is the worst kind of bug to chase, and the flag moves inside the timer so the
        // cancelled pass cannot claim to have spoken.
        const timer = setTimeout(() => {
            openingSpoken.current = true;
            speaker.say(opening);
        }, 0);
        return () => clearTimeout(timer);
    }, [voiceOn, capability, speaker, status, feedback, messages.length, opening]);

    /** The choice is per browser and survives the session; the speak call itself is driven by the
     *  hook, so turning this off mid-sentence stops the sentence. */
    function toggleVoice() {
        const next = !voiceOn;
        setVoiceOn(next);
        writeVoicePref(next);
    }

    async function send() {
        const content = draft.trim();
        if (!content || status !== "ready" || sendingRef.current) return;
        sendingRef.current = true;
        // The take that failed is behind us now; a living mic error under a box that just sent is noise.
        mic.clear();
        setDraft("");
        setError(null);
        setStatus("streaming");

        const localId = `local-${Date.now()}`;
        const userMsg: Message = {
            id: localId,
            interview_id: interviewId,
            role: "user",
            content,
            created_at: new Date().toISOString(),
        };
        setMessages((m) => [...m, userMsg]);
        setAssistBuf("");

        const rollback = () => {
            setMessages((m) => m.filter((x) => x.id !== localId));
            setAssistBuf("");
        };

        const ac = new AbortController();
        abortRef.current = ac;
        let buffer = "";
        let settled = false;
        // Spoken as it streams, sentence by sentence: waiting for the whole reply would put the voice
        // a generation behind the text on screen.
        speaker.begin();
        try {
            await streamChat(
                interviewId,
                content,
                (ev) => {
                    if (ev.kind === "message") {
                        buffer += ev.content;
                        setAssistBuf(buffer);
                        speaker.push(ev.content);
                    } else if (ev.kind === "done") {
                        settled = true;
                        speaker.flush();
                        if (buffer) {
                            setMessages((m) => [
                                ...m,
                                {
                                    id: `assistant-${Date.now()}`,
                                    interview_id: interviewId,
                                    role: "assistant",
                                    content: buffer,
                                    created_at: new Date().toISOString(),
                                },
                            ]);
                        }
                        setAssistBuf("");
                        setStatus("ready");
                        if (ev.closing) setInterviewOver(true);
                        if (ev.failed) {
                            setHardcoreFailed(ev.failed);
                            setMessages((m) => m.map((x) => (x.id === localId ? { ...x, move_class: ev.failed?.class ?? null } : x)));
                        }
                    } else if (ev.kind === "error") {
                        settled = true;
                        speaker.stop();
                        rollback();
                        setDraft(content);
                        // The server's message names the endpoint and what to do about it; the constant
                        // is only for a frame with no data.
                        setError(ev.message || STREAM_FAILED);
                        setStatus("ready");
                    }
                },
                { signal: ac.signal },
            );
            if (!settled) {
                setAssistBuf("");
                const rows = await loadMessages();
                if (rows?.some((m) => m.role === "user" && m.content === content)) {
                    setError(null);
                    speaker.flush(); // the turn landed after all: finish the sentence the cut-off stream left hanging
                } else {
                    speaker.stop();
                    rollback();
                    setDraft(content);
                    setError(STREAM_FAILED);
                }
            }
        } catch (e: unknown) {
            if ((e as { name?: string })?.name !== "AbortError") {
                speaker.stop();
                const st = httpStatus(e);
                if (st === 402) setQuotaLocked(true);
                else if (st === 409) setInterviewOver(true);
                else setError(CONNECTION_LOST);
                rollback();
                if (st !== 409) setDraft(content);
            }
        } finally {
            sendingRef.current = false;
            setStatus("ready");
        }
    }

    /** Load the review and re-read the transcript it annotates. Every finish path lands here. */
    async function openReview(load: () => Promise<Feedback>) {
        // The review page is silent: whatever the last reply had left to say stops here rather than
        // talking over the thing it is being graded against.
        speaker.stop();
        setStatus("completed");
        setReviewFailed(false);
        setError(null);
        try {
            setFeedback(await load());
            await loadMessages();
        } catch (e: unknown) {
            setReviewFailed(true);
            if (httpStatus(e) === 409) setError(apiDetail(e));
            setFinishing(null); // nothing landed, so there is no finished state to show
            return;
        }
        // Held on the all-checked state for a beat, then closed onto the review: the wait ending by
        // vanishing reads as a failure, whatever landed underneath.
        setFinishing((f) => (f ? { ...f, done: true } : f));
        await new Promise((r) => setTimeout(r, DONE_HOLD_MS));
        setFinishing(null);
    }

    /** Finish the run on the server, then show the review. Closing the progress screen does not
     *  cancel this: the call keeps running and the review still lands when it returns. */
    async function finishRun() {
        setConfirmFinish(false);
        setFinishing({ title: "Finishing your interview", dismissed: false, done: false });
        try {
            await finishInterview(interviewId);
            await openReview(() => getFeedback(interviewId));
        } catch (e: unknown) {
            setError(apiDetail(e, "Failed to finish the interview."));
            setStatus("ready");
            setFinishing(null);
        }
    }

    /** Re-run the review for a run that finished without one (or without its per-answer notes). */
    async function retryReview() {
        setFinishing({ title: "Rebuilding your review", dismissed: false, done: false });
        await openReview(() => regenerateFeedback(interviewId));
    }

    // Hardcore is the only dial with a body count, so it gets the only red: a tinted bar while the
    // run is live, full strength once it fails. Light-mode red is the darker token, #ff9999 on white
    // is invisible.
    const hardcoreBar = hardcoreFailed ? "border-destructive bg-destructive/10" : hardcoreRun && status !== "completed" ? "border-destructive/40 bg-destructive/5" : undefined;
    // Consecutive turns from one side close up tight and only the last of each burst carries the
    // interviewer's face, the way a chat app groups a paragraph of short replies.
    const lastOfRun = new Set(messages.filter((m, i) => messages[i + 1]?.role !== m.role).map((m) => m.id));

    return (
        <div className="flex h-dvh flex-col bg-background">
            <header className={cn("flex items-center gap-2 border-b bg-background px-2 py-2 sm:px-3", hardcoreBar)}>
                <Button variant="ghost" size="icon" className="rounded-full" aria-label="Exit this interview" title="Exit to your dashboard" onClick={onExit}>
                    <Icon name="back" />
                </Button>
                <span aria-hidden className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Icon name="chat" />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">Interviewer</p>
                    <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                        <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", hardcoreFailed ? "bg-destructive" : status === "streaming" ? "animate-pulse bg-foreground" : status === "completed" ? "bg-muted-foreground/40" : "bg-foreground/70")} />
                        {STATUS_LABELS[status]}
                    </p>
                </div>
                {/* Icon-only: the labels came off, so the tooltip and the aria-label carry the meaning.
                    Finish sits here rather than in the composer, where it stacked under Send. */}
                <Button variant="ghost" size="icon" className="rounded-full" aria-pressed={voiceOn} aria-label={voiceOn ? "Voice on" : "Voice off"} onClick={toggleVoice} disabled={!capability?.tts} title={voiceTitle}>
                    <Icon name={voiceOn ? "sound" : "mute"} />
                </Button>
                <Button
                    variant="destructive"
                    size="icon"
                    className="rounded-full"
                    aria-label={interviewOver ? "Finish and get your feedback" : "End this interview"}
                    title={interviewOver ? "Finish and get your feedback" : "End this interview"}
                    onClick={() => (interviewOver ? void finishRun() : setConfirmFinish(true))}
                    disabled={isFinishing || status === "streaming" || status === "completed" || !answered || mic.recording}
                >
                    {isFinishing ? <Spinner /> : <Icon name="complete" />}
                </Button>
            </header>
            {voiceNote && <p className="border-b bg-muted/40 px-4 py-1.5 text-center text-xs text-muted-foreground">{voiceNote}</p>}

            {/* One scroller: the review, then the transcript it argues from. */}
            <div className="min-h-0 flex-1 overflow-y-auto" ref={scrollRef} role="log" aria-live="polite" aria-busy={status === "streaming"} aria-label="Interview transcript">
                <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-1 px-4 py-5 sm:px-6">
                    {/* Safe to always offer: /finish refuses an empty transcript, so a review implies
                        at least one answer to re-annotate. */}
                    {feedback && <FeedbackView feedback={feedback} messages={messages} onAnnotate={() => void retryReview()} annotating={isFinishing} />}
                    {/* The screen was closed while the run is still being finished: keep the wait visible
                        where the review will land, plus a way back to the stages. */}
                    {finishing?.dismissed && (
                        <div role="status" className="my-1 flex items-center gap-2 self-center rounded-2xl border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
                            {finishing.done ? (
                                <span aria-hidden className="text-primary">
                                    ✓
                                </span>
                            ) : (
                                <Spinner />
                            )}
                            {finishing.title}. It will appear here.
                            <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => setFinishing((f) => (f ? { ...f, dismissed: false } : f))}>
                                Show progress
                            </Button>
                        </div>
                    )}
                    {error && <p className="my-1 self-center rounded-2xl border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-center text-xs text-destructive">{error}</p>}
                    {quotaLocked && <UpgradeNotice reason="your free chat turns ran out." />}
                    {interviewOver && (
                        <div role="status" className={cn("my-1 self-center rounded-2xl border px-3.5 py-2 text-center text-xs", hardcoreFailed ? "border-destructive bg-destructive/10 text-destructive" : "bg-muted/50 text-muted-foreground")}>
                            {hardcoreFailed ? (
                                <p className="font-semibold uppercase tracking-wide">Your run failed. Go and tell your mommy and cry about it.</p>
                            ) : (
                                <>
                                    <p className="font-medium text-foreground">That was the whole interview.</p>
                                    <p className="mt-1">
                                        This run has asked every question in its mix, so there's nothing left to answer here. Press the <span className="font-medium text-foreground">✓</span> at the top right for your feedback, or start a new interview with a wider mix.
                                    </p>
                                </>
                            )}
                        </div>
                    )}
                    {status === "loading" && <p className="my-1 self-center text-xs text-muted-foreground">Starting…</p>}
                    {/* Not while loading: a reopened run would flash the opening line before its
                    real transcript arrives. */}
                    {status !== "loading" && messages.length === 0 && opening && <Bubble from="assistant" content={opening} last onReplay={voiceOn && capability?.tts ? speaker.say : undefined} />}
                    {messages.map((m, i) => (
                        <Bubble key={m.id} from={m.role} content={m.content} moveClass={m.move_class} comment={m.comment} last={lastOfRun.has(m.id)} lead={messages[i - 1]?.role !== m.role} onReplay={m.role === "assistant" && voiceOn && capability?.tts ? speaker.say : undefined} />
                    ))}
                    {assistBuf && <Bubble from="assistant" content={assistBuf} streaming last lead={messages[messages.length - 1]?.role !== "assistant"} />}
                    {status === "streaming" && !assistBuf && <p className="my-1 self-center text-xs text-muted-foreground">Thinking…</p>}
                    {reviewFailed && status === "completed" && (
                        <div role="status" className="my-1 flex flex-col items-center gap-1.5 self-center rounded-2xl border bg-muted/50 px-3.5 py-2 text-center text-xs text-muted-foreground">
                            <p className="font-medium text-foreground">Interview finished, your review wasn't ready.</p>
                            <p>We couldn't generate your feedback this run. Try again, or exit and check your history.</p>
                            <Button variant="outline" size="sm" onClick={() => void retryReview()} disabled={isFinishing}>
                                {isFinishing && <Spinner />}
                                {isFinishing ? "Reviewing…" : "Retry review"}
                            </Button>
                        </div>
                    )}
                </div>
            </div>
            {/* The pill: box and both buttons are one control, the way a chat app draws it. It grows to
                six lines and then scrolls (see the draft effect), and it is never resizable. */}
            <div className="border-t bg-background px-3 py-2.5 sm:px-4">
                <div className="mx-auto w-full max-w-[100rem]">
                    {/* Nothing renders mid-answer (V4): the meter and the timer are the whole of the
                        feedback until Stop, because nothing is transcribed on this side. */}
                    {mic.recording && (
                        <p role="status" className="mb-1.5 flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
                            <span aria-hidden className="h-1 w-16 overflow-hidden rounded-full bg-muted">
                                <span className="block h-full rounded-full bg-destructive transition-[width] duration-100" style={{ width: `${Math.round(mic.level * 100)}%` }} />
                            </span>
                            Recording · {clock(mic.elapsed)} of {clock(MAX_TAKE_S)}
                        </p>
                    )}
                    {!mic.recording && mic.notice && <p className="mb-1.5 px-2 text-xs text-muted-foreground">{mic.notice}</p>}
                    {!mic.recording && micProblem && <p className="mb-1.5 px-2 text-xs text-destructive">{micProblem}</p>}
                    <div className="flex items-end gap-1 rounded-3xl border bg-card p-1 pl-2 shadow-sm transition-shadow focus-within:border-ring focus-within:shadow-md">
                        <Textarea
                            ref={inputRef}
                            rows={1}
                            value={draft}
                            maxLength={MAX_TURN_CHARS}
                            aria-label="Your answer"
                            className="max-h-60 min-h-0 resize-none border-0 bg-transparent px-1 py-2 shadow-none focus-visible:ring-0"
                            onChange={(e) => setDraft(e.target.value)}
                            placeholder={placeholder}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey && status === "ready") {
                                    e.preventDefault();
                                    void send();
                                }
                            }}
                            disabled={status === "completed" || interviewOver || mic.recording}
                        />
                        {/* Disabled while the interviewer is replying: an open microphone would
                            transcribe our own voice back into the answer (VOICE.md gotcha 7). */}
                        <Button
                            variant={mic.recording ? "destructive" : "ghost"}
                            size="icon"
                            className={cn("h-8 w-8 shrink-0 rounded-full", !mic.recording && "text-muted-foreground")}
                            aria-pressed={mic.recording}
                            aria-label={mic.recording ? "Stop and keep what you said" : "Speak your answer"}
                            onClick={() => (mic.recording ? mic.stop() : mic.start())}
                            disabled={!mic.recording && (!mic.ready || status !== "ready" || interviewOver || Boolean(mic.blocked))}
                            title={mic.recording ? "Stop and put what you said into your answer" : "Speak your answer instead of typing it"}
                        >
                            <Icon name={mic.recording ? "stop" : "mic"} />
                        </Button>
                        <Button size="icon" className="h-8 w-8 shrink-0 rounded-full" aria-label="Send your answer" title="Send your answer" onClick={() => void send()} disabled={status !== "ready" || !draft.trim() || interviewOver || mic.recording}>
                            <Icon name="send" />
                        </Button>
                    </div>
                </div>
            </div>
            {finishing && <FinishOverlay open={!finishing.dismissed} title={finishing.title} done={finishing.done} onDismiss={() => setFinishing((f) => (f ? { ...f, dismissed: true } : f))} />}
            {/* Its own modal now that Finish lives in the header: the old inline prompt had nowhere
                to hang off a 32px icon without shoving the header row around. */}
            <Modal open={confirmFinish} onClose={() => setConfirmFinish(false)} title="End early?">
                <p>This run still has questions left. Finishing now reviews the answers you gave and ends it here.</p>
                <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setConfirmFinish(false)}>
                        Keep going
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => void finishRun()} disabled={isFinishing || mic.recording}>
                        {isFinishing && <Spinner />}
                        End it
                    </Button>
                </div>
            </Modal>
        </div>
    );
}

/** The reviewer's note on one answer, behind the bulb that used to sit in front of it. Folded so
 *  the transcript keeps its height until a note is asked for; the next click anywhere else, or Esc,
 *  puts it away, which is also how a second bulb takes over from this one. */
const TipButton = memo(function TipButton({ comment }: { comment: string }) {
    const [open, setOpen] = useState(false);
    // The bulb sits left of an answer that can be a whole screen wide, so the card's natural spot can
    // land past the transcript's right edge, where it gets clipped and drags a scrollbar in. It slides
    // back by the overflow, measured from the bulb rather than the card: a reopen must not measure the
    // shift it applied last time.
    const [shift, setShift] = useState(0);
    const ref = useRef<HTMLDivElement | null>(null);
    const cardRef = useRef<HTMLDivElement | null>(null);
    useLayoutEffect(() => {
        if (!open) return;
        const card = cardRef.current;
        const bulb = ref.current?.getBoundingClientRect();
        const log = ref.current?.closest<HTMLElement>('[role="log"]')?.getBoundingClientRect();
        if (!card || !bulb || !log) return;
        const over = bulb.left + card.offsetWidth + 8 - log.right;
        setShift(over > 0 ? -over : 0);
    }, [open]);
    useEffect(() => {
        if (!open) return;
        const away = (e: Event) => {
            if (!ref.current?.contains(e.target as Node)) setOpen(false);
        };
        const esc = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("pointerdown", away);
        document.addEventListener("keydown", esc);
        return () => {
            document.removeEventListener("pointerdown", away);
            document.removeEventListener("keydown", esc);
        };
    }, [open]);
    return (
        <div ref={ref} className="relative shrink-0">
            <button type="button" aria-expanded={open} aria-label="Show the tip for this answer" title="Show the tip for this answer" onClick={() => setOpen((o) => !o)} className={cn("flex rounded-full p-1 transition-colors", open ? "text-foreground" : "text-muted-foreground/60 hover:text-foreground")}>
                <Icon name="tip" className="h-3.5 w-3.5" />
            </button>
            {/* Above the bulb and over the answer it grades. AI HERE: a row at the very top of the
                scroller would clip it, which needs a measure-and-flip; not worth the layout read yet. */}
            {open && (
                <div ref={cardRef} role="note" style={{ left: shift }} className="absolute bottom-full z-30 mb-1 w-64 max-w-[70vw] rounded-2xl border bg-popover px-3 py-2 text-xs leading-relaxed text-popover-foreground shadow-md lg:w-80">
                    {comment}
                </div>
            )}
        </div>
    );
});

const Bubble = memo(function Bubble({ from, content, streaming, moveClass, comment, onReplay, last, lead }: { from: string; content: string; streaming?: boolean; moveClass?: string | null; comment?: string | null; onReplay?: (text: string) => void; last?: boolean; lead?: boolean }) {
    const isUser = from === "user";
    const noted = isUser && !!comment;
    // An answer folds at six lines and offers the rest behind a toggle. Only the answer: a reply is
    // read as it arrives, and one that folds itself away mid-read is worse than a long one.
    const [expanded, setExpanded] = useState(false);
    const [clipped, setClipped] = useState(false);
    const bodyRef = useRef<HTMLDivElement | null>(null);
    const foldable = isUser && !streaming;
    useEffect(() => {
        const el = bodyRef.current;
        if (!el || !foldable || expanded) return;
        // The box is the measure, and it has to be measured CLAMPED: only then does it report more
        // content than it shows, which is what the toggle exists for. Re-run on width changes too,
        // because a wider bubble pulls lines back over the fold.
        const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [foldable, expanded]);
    const folded = foldable && !expanded;
    // The flat corner marks the end of a burst, and only that bubble gets the interviewer's face.
    // Width is a reading cap, not a column cap: the screen fills edge to edge, the line does not.
    const bubble = (
        <div className={cn("max-w-[85%] whitespace-pre-line break-words rounded-3xl px-3.5 py-2 text-sm leading-relaxed lg:max-w-[45rem]", isUser ? "bg-primary text-primary-foreground" : "border bg-card", last && (isUser ? "rounded-br-md" : "rounded-bl-md"))}>
            <div ref={bodyRef} className={cn("break-words", folded && "line-clamp-6")}>
                {content}
                {streaming && <span className="inline-block animate-pulse">▋</span>}
            </div>
            {clipped && (
                <button type="button" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)} className={cn("mt-1 block text-xs font-medium transition-colors", isUser ? "text-primary-foreground/70 hover:text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                    {expanded ? "Show less" : "Show more"}
                </button>
            )}
        </div>
    );
    // Replies only: a replay is how a word the engine misheard gets checked, and the applicant knows
    // what they said. Nothing to replay while the reply is still arriving.
    const replay =
        onReplay && !streaming ? (
            <button type="button" aria-label="Play this reply aloud" title="Play this reply aloud" onClick={() => onReplay(content)} className="mb-1 shrink-0 rounded-full p-1 text-muted-foreground/60 transition-colors hover:text-foreground">
                <Icon name="sound" className="h-3.5 w-3.5" />
            </button>
        ) : null;
    // Before the bubble, not after: a badge on the right insets the bubble's edge, so every answer
    // would shift left the moment the review lands.
    const badge = isUser && moveClass ? <MoveBadge moveClass={moveClass} /> : null;
    return (
        <div className={cn("flex min-w-0 max-w-full items-end gap-2", isUser ? "justify-end" : "justify-start", lead && "mt-3")}>
            {/* The face rides the last reply of a burst, and an invisible twin holds its column in
                every other row so bubbles are never pushed sideways. */}
            <span aria-hidden className={cn("flex h-7 w-7 shrink-0 items-center justify-center self-end rounded-full bg-primary/10 text-primary", !(last && !isUser) && "invisible")}>
                <Icon name="chat" className="h-3.5 w-3.5" />
            </span>
            {/* The bulb shares the gutter with the badge, and its column is held on every answer by
                an invisible twin, same as the face: the review landing cannot shove the bubble. */}
            {isUser && (noted ? <TipButton comment={comment} /> : <span aria-hidden className="w-[22px] shrink-0" />)}
            {badge}
            {bubble}
            {replay}
        </div>
    );
});

/** mm:ss for the take timer, which is also the cap counting down beside it. */
function clock(seconds: number): string {
    const total = Math.floor(seconds);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function Spinner() {
    return <span role="status" aria-label="Loading" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}
