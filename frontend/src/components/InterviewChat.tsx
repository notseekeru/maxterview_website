import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { MAX_TAKE_S, useRecorder, useSpeaker, useVoiceCapability } from "@/hooks/useInterviewVoice";
import { apiDetail, type Feedback, finishInterview, getFeedback, getInterview, getMessages, getOffer, httpStatus, kickoffInterview, MAX_TURN_CHARS, type Message, type Offer, regenerateFeedback, type StreamEvent, startInterview, streamChat } from "@/lib/api";
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

const STREAM_FAILED = "The interviewer couldn't answer just now: the model was unreachable. Your turn wasn't saved, so send it again in a moment.";
const CONNECTION_LOST = "Connection lost while streaming. The model never answered. If this repeats, test your provider in Settings > Interview engine (BYOK).";

const STATUS_LABELS = { loading: "Starting", ready: "In progress", streaming: "Interviewer is replying", completed: "Finished" } as const;

const DONE_HOLD_MS = 1200;

export function InterviewChat({ interviewId, onExit }: Props) {
    const [status, setStatus] = useState<"loading" | "ready" | "streaming" | "completed">("loading");
    const [messages, setMessages] = useState<Message[]>([]);
    const [draft, setDraft] = useState("");
    const [assistBuf, setAssistBuf] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<Feedback | null>(null);
    const [offer, setOffer] = useState<Offer | null>(null);
    const [quotaLocked, setQuotaLocked] = useState(false);
    const [interviewOver, setInterviewOver] = useState(false);
    const [hardcoreRun, setHardcoreRun] = useState(false);
    const [hardcoreFailed, setHardcoreFailed] = useState<{ turn: number; class: string } | null>(null);
    const [finishing, setFinishing] = useState<{ title: string; dismissed: boolean; done: boolean } | null>(null);
    const isFinishing = finishing !== null;
    const answered = messages.some((m) => m.role === "user");
    const [reviewFailed, setReviewFailed] = useState(false);
    const [redoing, setRedoing] = useState(false);
    const [redoError, setRedoError] = useState<string | null>(null);
    const [confirmFinish, setConfirmFinish] = useState(false);
    const sendingRef = useRef(false);
    const kickedRef = useRef(false);
    const abortRef = useRef<AbortController | null>(null);
    const replyId = useRef("");
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    const [voiceOn, setVoiceOn] = useState(readVoicePref);
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
    const voiceNote = capabilityFailed ? "Voice couldn't be checked just now, so both controls are off. Reload to try again." : capability && !capability.tts ? "Replies can't be read aloud: this server has no speech voice configured." : null;
    const micProblem = mic.blocked ?? mic.error;
    const placeholder = mic.recording
        ? "Listening: press Stop to put your words here"
        : mic.transcribing
          ? "Transcribing: your words land here in a moment"
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
            setHardcoreRun(iv.hardcore);
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
            const rows = getMessages(interviewId);
            const [started] = await Promise.allSettled([startInterview(interviewId), rows]);
            if (cancelled) return;
            if (started.status === "fulfilled") {
                setHardcoreRun(Boolean(started.value.hardcore));
                try {
                    setMessages(await rows);
                } catch {
                    setError("Could not load conversation.");
                }
                setStatus("ready");
                return;
            }
            const st = httpStatus(started.reason);
            if (st !== 409) {
                setError("Could not start interview.");
                setStatus("ready");
            } else {
                setStatus(await loadExisting(interviewId));
            }
        })();
        return () => {
            cancelled = true;
            abortRef.current?.abort();
        };
    }, [interviewId, loadExisting]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: runTurn is a fresh closure every render, so it cannot be a dependency; the ref is the guard.
    useEffect(() => {
        if (status !== "ready" || messages.length || interviewOver || error || kickedRef.current) return;
        kickedRef.current = true;
        void runTurn(null);
    }, [status, messages.length, interviewOver, error]);

    // AI HERE: a fixed pixel cap and a layout-forced reflow per keystroke. Upgrade path is a measure
    // in useLayoutEffect keyed on value length.
    // biome-ignore lint/correctness/useExhaustiveDependencies: el.scrollHeight is a function of draft, which no linter can see through the DOM.
    useEffect(() => {
        const el = inputRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
    }, [draft]);

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "instant" });
    }, []);

    useEffect(() => {
        if (feedback) scrollRef.current?.scrollTo({ top: 0, behavior: "instant" });
    }, [feedback]);

    useEffect(() => {
        if (!feedback) return;
        let cancelled = false;
        getOffer(feedback.interview_id)
            .then((o) => {
                if (!cancelled) setOffer(o);
            })
            .catch(() => {
                if (!cancelled) setOffer(null);
            });
        return () => {
            cancelled = true;
        };
    }, [feedback]);

    function toggleVoice() {
        const next = !voiceOn;
        setVoiceOn(next);
        writeVoicePref(next);
    }

    async function send() {
        const content = draft.trim();
        if (!content || status !== "ready" || sendingRef.current) return;
        setDraft("");
        await runTurn(content);
    }

    async function runTurn(answer: string | null) {
        if (sendingRef.current) return;
        sendingRef.current = true;
        mic.clear();
        setError(null);
        setStatus("streaming");
        setAssistBuf("");

        const localId = answer === null ? null : `local-${Date.now()}`;
        if (answer !== null) {
            const userMsg: Message = { id: localId as string, interview_id: interviewId, role: "user", content: answer, created_at: new Date().toISOString() };
            setMessages((m) => [...m, userMsg]);
        }

        const rollback = () => {
            if (localId) setMessages((m) => m.filter((x) => x.id !== localId));
            setAssistBuf("");
        };

        const ac = new AbortController();
        abortRef.current = ac;
        let buffer = "";
        let settled = false;
        replyId.current = `local-reply-${Date.now()}`;
        speaker.begin();
        try {
            const onEvent = (ev: StreamEvent) => {
                if (ev.kind === "message") {
                    buffer += ev.content;
                    setAssistBuf(buffer);
                    speaker.push(ev.content);
                } else if (ev.kind === "done") {
                    settled = true;
                    speaker.flush();
                    if (buffer) {
                        setMessages((m) => [...m, { id: replyId.current, interview_id: interviewId, role: "assistant", content: buffer, created_at: new Date().toISOString() }]);
                    }
                    setAssistBuf("");
                    setStatus("ready");
                    if (ev.closing) setInterviewOver(true);
                    if (ev.failed) {
                        setHardcoreFailed(ev.failed);
                        setMessages((m) => m.map((x) => (x.id === localId ? { ...x, move_class: ev.failed?.class ?? null } : x)));
                    }
                } else {
                    settled = true;
                    speaker.stop();
                    rollback();
                    if (answer !== null) setDraft(answer);
                    setError(ev.message || STREAM_FAILED);
                    setStatus("ready");
                }
            };
            await (answer === null ? kickoffInterview(interviewId, onEvent, { signal: ac.signal }) : streamChat(interviewId, answer, onEvent, { signal: ac.signal }));
            if (!settled) {
                setAssistBuf("");
                const rows = await loadMessages();
                const landed = answer === null ? rows?.some((m) => m.role === "assistant") : rows?.some((m) => m.role === "user" && m.content === answer);
                if (landed) {
                    setError(null);
                    speaker.flush(); // the turn landed after all: finish the sentence the cut-off stream left hanging
                } else {
                    speaker.stop();
                    rollback();
                    if (answer !== null) setDraft(answer);
                    setError(STREAM_FAILED);
                }
            }
        } catch (e: unknown) {
            if ((e as { name?: string })?.name !== "AbortError") {
                speaker.stop();
                const st = httpStatus(e);
                if (st === 402) setQuotaLocked(true);
                else if (st === 409 && answer === null) await loadMessages();
                else if (st === 409) setInterviewOver(true);
                else setError(CONNECTION_LOST);
                rollback();
                if (st !== 409 && answer !== null) setDraft(answer);
            }
        } finally {
            sendingRef.current = false;
            setStatus("ready");
        }
    }

    async function openReview(load: () => Promise<Feedback>) {
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
        setFinishing((f) => (f ? { ...f, done: true } : f));
        await new Promise((r) => setTimeout(r, DONE_HOLD_MS));
        setFinishing(null);
    }

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

    async function retryReview() {
        setFinishing({ title: "Rebuilding your review", dismissed: false, done: false });
        await openReview(() => regenerateFeedback(interviewId));
    }

    async function redoReview() {
        setRedoing(true);
        setRedoError(null);
        try {
            setFeedback(await regenerateFeedback(interviewId));
            await loadMessages();
        } catch (e: unknown) {
            setRedoError(apiDetail(e, "Couldn't rebuild your review just now."));
        } finally {
            setRedoing(false);
        }
    }

    const hardcoreBar = hardcoreFailed ? "border-destructive bg-destructive/10" : hardcoreRun && status !== "completed" ? "border-destructive/40 bg-destructive/5" : undefined;
    const lastOfRun = new Set(messages.filter((m, i) => messages[i + 1]?.role !== m.role).map((m) => m.id));
    const speech = speaker.spoken;
    const caption = (id: string, content: string) => (speech === null || id !== replyId.current ? content : content.slice(0, speech));
    const live = caption(replyId.current, assistBuf);

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
                    disabled={isFinishing || status === "streaming" || status === "completed" || !answered || mic.busy}
                >
                    {isFinishing ? <Spinner label="Reviewing" className="size-3.5" /> : <Icon name="complete" />}
                </Button>
            </header>
            {voiceNote && <p className="border-b bg-muted/40 px-4 py-1.5 text-center text-xs text-muted-foreground">{voiceNote}</p>}

            <div className="min-h-0 flex-1 overflow-y-auto" ref={scrollRef} role="log" aria-live="polite" aria-busy={status === "streaming"} aria-label="Interview transcript">
                <div className="mx-auto flex w-full max-w-[100rem] flex-col gap-1 px-4 py-5 sm:px-6">
                    {feedback && <FeedbackView feedback={feedback} messages={messages} offer={offer} onRedo={() => void redoReview()} redoing={redoing} redoError={redoError} />}
                    {finishing?.dismissed && (
                        <div role="status" className="my-1 flex items-center gap-2 self-center rounded-2xl border bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
                            {finishing.done ? (
                                <span aria-hidden className="text-primary">
                                    ✓
                                </span>
                            ) : (
                                <Spinner label="Reviewing" className="size-3.5" />
                            )}
                            {finishing.title}. It will appear here.
                            <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => setFinishing((f) => (f ? { ...f, dismissed: false } : f))}>
                                Show progress
                            </Button>
                        </div>
                    )}
                    {error && (
                        <div role="alert" className="my-1 flex flex-col items-center gap-1.5 self-center rounded-2xl border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-center text-xs text-destructive">
                            <p>{error}</p>
                            {!messages.length && !interviewOver && status === "ready" && (
                                <Button variant="outline" size="sm" onClick={() => void runTurn(null)}>
                                    Retry
                                </Button>
                            )}
                        </div>
                    )}
                    {quotaLocked && <UpgradeNotice />}
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
                    {messages.map((m, i) => (
                        <Bubble key={m.id} from={m.role} content={caption(m.id, m.content)} moveClass={m.move_class} comment={m.comment} last={lastOfRun.has(m.id)} lead={messages[i - 1]?.role !== m.role} onReplay={m.role === "assistant" && voiceOn && capability?.tts ? speaker.say : undefined} />
                    ))}
                    {status === "streaming" && <Bubble from="assistant" content={live} thinking={!live} streaming last lead={messages[messages.length - 1]?.role !== "assistant"} />}
                    {reviewFailed && status === "completed" && (
                        <div role="status" className="my-1 flex flex-col items-center gap-1.5 self-center rounded-2xl border bg-muted/50 px-3.5 py-2 text-center text-xs text-muted-foreground">
                            <p className="font-medium text-foreground">Interview finished, your review wasn't ready.</p>
                            <p>We couldn't generate your feedback this run. Try again, or exit and check your history.</p>
                            <Button variant="outline" size="sm" onClick={() => void retryReview()} disabled={isFinishing}>
                                {isFinishing && <Spinner label="Reviewing" className="size-3.5" />}
                                {isFinishing ? "Reviewing…" : "Retry review"}
                            </Button>
                        </div>
                    )}
                </div>
            </div>
            <div className="border-t bg-background px-3 py-2.5 sm:px-4">
                <div className="mx-auto w-full max-w-[100rem]">
                    {mic.recording && (
                        <p role="status" className="mb-1.5 flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
                            <span aria-hidden className="h-1 w-16 overflow-hidden rounded-full bg-muted">
                                <span className="block h-full rounded-full bg-destructive transition-[width] duration-100" style={{ width: `${Math.round(mic.level * 100)}%` }} />
                            </span>
                            Recording · {clock(mic.elapsed)} of {clock(MAX_TAKE_S)}
                        </p>
                    )}
                    {mic.transcribing && (
                        <p role="status" className="mb-1.5 flex items-center gap-1.5 px-2 text-xs text-muted-foreground">
                            <Spinner label="Transcribing your answer" className="size-3" />
                            Transcribing what you said...
                        </p>
                    )}
                    {!mic.busy && mic.notice && <p className="mb-1.5 px-2 text-xs text-muted-foreground">{mic.notice}</p>}
                    {!mic.busy && micProblem && <p className="mb-1.5 px-2 text-xs text-destructive">{micProblem}</p>}
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
                                if (e.nativeEvent.isComposing) return;
                                if (e.key === "Enter" && !e.shiftKey && status === "ready") {
                                    e.preventDefault();
                                    void send();
                                }
                            }}
                            disabled={status === "completed" || interviewOver || mic.busy}
                        />
                        <Button
                            variant={mic.recording ? "destructive" : "ghost"}
                            size="icon"
                            className={cn("shrink-0 rounded-full", !mic.recording && "text-muted-foreground")}
                            aria-pressed={mic.recording}
                            aria-label={mic.recording ? "Stop and keep what you said" : "Speak your answer"}
                            onClick={() => {
                                if (mic.recording) mic.stop();
                                else {
                                    // A talking interviewer would be transcribed into the answer, so
                                    // pressing the microphone stops the voice for the applicant.
                                    speaker.stop();
                                    mic.start();
                                }
                            }}
                            disabled={!mic.recording && (!mic.ready || status !== "ready" || interviewOver || Boolean(mic.blocked) || mic.busy)}
                            title={mic.recording ? "Stop and put what you said into your answer" : "Speak your answer instead of typing it"}
                        >
                            <Icon name={mic.recording ? "stop" : "mic"} />
                        </Button>
                        <Button size="icon" className="shrink-0 rounded-full" aria-label="Send your answer" title="Send your answer" onClick={() => void send()} disabled={status !== "ready" || !draft.trim() || interviewOver || mic.busy}>
                            <Icon name="send" />
                        </Button>
                    </div>
                </div>
            </div>
            {finishing && <FinishOverlay open={!finishing.dismissed} title={finishing.title} done={finishing.done} onDismiss={() => setFinishing((f) => (f ? { ...f, dismissed: true } : f))} />}
            <Modal open={confirmFinish} onClose={() => setConfirmFinish(false)} title="End early?">
                <p>This run still has questions left. Finishing now reviews the answers you gave and ends it here.</p>
                <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setConfirmFinish(false)}>
                        Keep going
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => void finishRun()} disabled={isFinishing || mic.busy}>
                        {isFinishing && <Spinner label="Ending the interview" className="size-3.5" />}
                        End it
                    </Button>
                </div>
            </Modal>
        </div>
    );
}

const Thinking = memo(function Thinking() {
    return (
        <span role="status" aria-label="The interviewer is thinking" className="flex items-center gap-1 py-1">
            {[0, 1, 2].map((i) => (
                <span key={i} aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-muted-foreground/50" style={{ animationDelay: `${i * 200}ms` }} />
            ))}
        </span>
    );
});

const Bubble = memo(function Bubble({ from, content, streaming, thinking, moveClass, comment, onReplay, last, lead }: { from: string; content: string; streaming?: boolean; thinking?: boolean; moveClass?: string | null; comment?: string | null; onReplay?: (text: string) => void; last?: boolean; lead?: boolean }) {
    const isUser = from === "user";
    const [expanded, setExpanded] = useState(false);
    const [clipped, setClipped] = useState(false);
    const bodyRef = useRef<HTMLDivElement | null>(null);
    const foldable = isUser && !streaming;
    useEffect(() => {
        const el = bodyRef.current;
        if (!el || !foldable || expanded) return;
        const measure = () => setClipped(el.scrollHeight > el.clientHeight + 1);
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [foldable, expanded]);
    const folded = foldable && !expanded;
    const bubble = (
        <div className={cn("max-w-[85%] whitespace-pre-line break-words rounded-3xl px-3.5 py-2 text-sm leading-relaxed lg:max-w-[45rem]", isUser ? "bg-primary text-primary-foreground" : "border bg-card", last && (isUser ? "rounded-br-md" : "rounded-bl-md"))}>
            <div ref={bodyRef} className={cn("break-words", folded && "line-clamp-6")}>
                {thinking ? <Thinking /> : content}
                {streaming && !thinking && <span className="inline-block animate-pulse">▋</span>}
            </div>
            {clipped && (
                <button type="button" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)} className={cn("mt-1 block text-xs font-medium transition-colors", isUser ? "text-primary-foreground/70 hover:text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                    {expanded ? "Show less" : "Show more"}
                </button>
            )}
        </div>
    );
    const replay =
        onReplay && !streaming ? (
            <button type="button" aria-label="Play this reply aloud" title="Play this reply aloud" onClick={() => onReplay(content)} className="mb-1 shrink-0 rounded-full p-1 text-muted-foreground/60 transition-colors hover:text-foreground">
                <Icon name="sound" className="h-3.5 w-3.5" />
            </button>
        ) : null;
    const badge = isUser && moveClass ? <MoveBadge moveClass={moveClass} comment={comment} /> : null;
    return (
        <div className={cn("flex min-w-0 max-w-full items-end gap-2", isUser ? "justify-end" : "justify-start", lead && "mt-3")}>
            <span aria-hidden className={cn("flex h-7 w-7 shrink-0 items-center justify-center self-end rounded-full bg-primary/10 text-primary", !(last && !isUser) && "invisible")}>
                <Icon name="chat" className="h-3.5 w-3.5" />
            </span>
            {badge}
            {bubble}
            {replay}
        </div>
    );
});

function clock(seconds: number): string {
    const total = Math.floor(seconds);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
