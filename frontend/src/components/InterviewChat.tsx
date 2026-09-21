import { memo, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { apiDetail, type Feedback, finishInterview, getFeedback, getInterview, getMessages, httpStatus, MAX_TURN_CHARS, type Message, regenerateFeedback, startInterview, streamChat } from "@/lib/api";
import { OPENING_ASKS_RESUME, OPENING_HAS_RESUME } from "@/lib/config";
import { cn } from "@/lib/utils";
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
    const [hasResume, setHasResume] = useState(false);
    const sendingRef = useRef(false);
    const abortRef = useRef<AbortController | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const opening = hasResume ? OPENING_HAS_RESUME : OPENING_ASKS_RESUME;

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

    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    }, []);

    useEffect(() => {
        if (feedback) scrollRef.current?.scrollTo({ top: 0 });
    }, [feedback]);

    async function send() {
        const content = draft.trim();
        if (!content || status !== "ready" || sendingRef.current) return;
        sendingRef.current = true;
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
        try {
            await streamChat(
                interviewId,
                content,
                (ev) => {
                    if (ev.kind === "message") {
                        buffer += ev.content;
                        setAssistBuf(buffer);
                    } else if (ev.kind === "done") {
                        settled = true;
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
                if (rows?.some((m) => m.role === "user" && m.content === content)) setError(null);
                else {
                    rollback();
                    setDraft(content);
                    setError(STREAM_FAILED);
                }
            }
        } catch (e: unknown) {
            if ((e as { name?: string })?.name !== "AbortError") {
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

    // Hardcore is the only dial with a body count, so it gets the only glow: ambient while the run
    // is live, full strength once it fails. Light-mode red is the darker token - #ff9999 on white
    // is invisible.
    const glow = hardcoreFailed ? "border-destructive shadow-[0_0_30px_-2px_rgba(160,0,0,0.45)] dark:shadow-[0_0_34px_-2px_rgba(255,153,153,0.6)]" : hardcoreRun && status !== "completed" ? "border-destructive/40 shadow-[0_0_20px_-4px_rgba(160,0,0,0.3)] dark:shadow-[0_0_24px_-4px_rgba(255,153,153,0.45)]" : undefined;

    return (
        <>
            <Card className={cn("flex min-h-0 w-full flex-1 flex-col", glow)}>
                <CardHeader className="flex-row items-center justify-between space-y-0">
                    <div>
                        <CardTitle>Interview</CardTitle>
                        <CardDescription>{STATUS_LABELS[status]}</CardDescription>
                    </div>
                    <Button variant="outline" size="sm" onClick={onExit}>
                        Exit
                    </Button>
                </CardHeader>

                {/* One scroller: the review, then the transcript it argues from. */}
                <CardContent className="flex-1 overflow-y-auto space-y-3" ref={scrollRef} role="log" aria-live="polite" aria-busy={status === "streaming"} aria-label="Interview transcript">
                    {/* Safe to always offer: /finish refuses an empty transcript, so a review implies
                        at least one answer to re-annotate. */}
                    {feedback && <FeedbackView feedback={feedback} messages={messages} onAnnotate={() => void retryReview()} annotating={isFinishing} />}
                    {/* The screen was closed while the run is still being finished: keep the wait visible
                        where the review will land, plus a way back to the stages. */}
                    {finishing?.dismissed && (
                        <div role="status" className="flex items-center gap-2 rounded-lg border p-3 text-sm text-muted-foreground">
                            {finishing.done ? (
                                <span aria-hidden className="text-primary">
                                    ✓
                                </span>
                            ) : (
                                <Spinner />
                            )}
                            {finishing.title}. It will appear here.
                            <Button variant="ghost" size="sm" className="ml-auto" onClick={() => setFinishing((f) => (f ? { ...f, dismissed: false } : f))}>
                                Show progress
                            </Button>
                        </div>
                    )}
                    {error && <p className="text-sm text-destructive">{error}</p>}
                    {quotaLocked && <UpgradeNotice reason="your free chat turns ran out." />}
                    {interviewOver && (
                        <div role="status" className={hardcoreFailed ? "rounded-lg border border-destructive bg-destructive/10 p-3 text-sm" : "rounded-lg border p-3 text-sm"}>
                            {hardcoreFailed ? (
                                <>
                                    <p className="font-semibold uppercase tracking-wide text-destructive"> Your Run failed — go and tell your mommy and cry about it</p>
                                </>
                            ) : (
                                <>
                                    <p className="font-medium">That was the whole interview.</p>
                                    <p className="mt-1 text-muted-foreground">
                                        This run has asked every question in its mix, so there's nothing left to answer here. Press <span className="font-medium text-foreground">Finish</span> for your feedback, or start a new interview with a wider mix.
                                    </p>
                                </>
                            )}
                        </div>
                    )}
                    {status === "loading" && <p className="text-sm text-muted-foreground">Starting…</p>}
                    {/* Not while loading: a reopened run would flash the opening line before its
                    real transcript arrives. */}
                    {status !== "loading" && messages.length === 0 && opening && <Bubble from="assistant" content={opening} />}
                    {messages.map((m) => (
                        <Bubble key={m.id} from={m.role} content={m.content} moveClass={m.move_class} comment={m.comment} />
                    ))}
                    {assistBuf && <Bubble from="assistant" content={assistBuf} streaming />}
                    {status === "streaming" && !assistBuf && <p className="text-sm text-muted-foreground">Thinking…</p>}
                    {reviewFailed && status === "completed" && (
                        <div role="status" className="rounded-lg border p-3 text-sm">
                            <p className="font-medium">Interview finished — your review wasn't ready.</p>
                            <p className="mt-1 text-muted-foreground">We couldn't generate your feedback this run. Try again, or exit and check your history.</p>
                            <Button variant="outline" size="sm" className="mt-2" onClick={() => void retryReview()} disabled={isFinishing}>
                                {isFinishing && <Spinner />}
                                {isFinishing ? "Reviewing…" : "Retry review"}
                            </Button>
                        </div>
                    )}
                </CardContent>
                <CardFooter className="gap-2">
                    <Textarea
                        value={draft}
                        maxLength={MAX_TURN_CHARS}
                        aria-label="Your answer"
                        onChange={(e) => setDraft(e.target.value)}
                        placeholder={status === "completed" ? "Review above" : interviewOver ? "Interview finished — press Finish" : status === "ready" ? "Type your answer to the interviewer..." : status === "streaming" ? "Waiting for the interviewer..." : "Starting…"}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.shiftKey && status === "ready") {
                                e.preventDefault();
                                void send();
                            }
                        }}
                        disabled={status === "completed" || interviewOver}
                    />
                    <div className="flex flex-col gap-2">
                        <Button onClick={() => void send()} disabled={status !== "ready" || !draft.trim() || interviewOver}>
                            Send
                        </Button>
                        <Button variant="destructive" size="sm" onClick={() => void finishRun()} disabled={isFinishing || status === "streaming" || status === "completed" || !answered}>
                            {isFinishing && <Spinner />}
                            {isFinishing ? "Finishing…" : "Finish"}
                        </Button>
                    </div>
                </CardFooter>
            </Card>
            {finishing && <FinishOverlay open={!finishing.dismissed} title={finishing.title} done={finishing.done} onDismiss={() => setFinishing((f) => (f ? { ...f, dismissed: true } : f))} />}
        </>
    );
}

/** The reviewer's note on one answer, beside it: two lines until asked for more, so a long note
 *  cannot tower over the answer it grades. The control appears only when the text is actually cut,
 *  measured rather than guessed from a character count. */
const MoveTip = memo(function MoveTip({ comment }: { comment: string }) {
    const [expanded, setExpanded] = useState(false);
    const [cut, setCut] = useState(false);
    const ref = useRef<HTMLParagraphElement>(null);
    const id = useId();

    // Measured while collapsed: a line-clamped box hides the overflow, so any gap between scrollHeight
    // and clientHeight means there is more to read. While expanded the last value stands, or the
    // control that would collapse it disappears along with the measurement that revealed it.
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || expanded) return;
        const measure = () => setCut(el.scrollHeight > el.clientHeight + 1);
        measure();
        const ro = new ResizeObserver(measure); // the transcript's width moves with the window
        ro.observe(el);
        return () => ro.disconnect();
    }, [expanded]);

    return (
        <div className="relative ml-6 w-[22.5rem] max-w-[40%] shrink-0">
            <p id={id} ref={ref} className={cn("text-xs leading-relaxed text-muted-foreground", !expanded && "line-clamp-2")}>
                {comment}
            </p>
            {/* Collapsed, the control rides the last line instead of taking a row of its own: a third row
                pushed the note past the bottom of the answer it grades. Opaque, because it covers the
                ellipsis it replaces. */}
            {cut && (
                <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => setExpanded((v) => !v)} className={cn("text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground", expanded ? "mt-0.5 block" : "absolute right-0 bottom-0 bg-card pl-1")}>
                    {expanded ? "Less" : "More"}
                </button>
            )}
        </div>
    );
});

const Bubble = memo(function Bubble({ from, content, streaming, moveClass, comment }: { from: string; content: string; streaming?: boolean; moveClass?: string | null; comment?: string | null }) {
    const isUser = from === "user";
    const noted = isUser && !!comment;
    const bubble = (
        <div className={cn("whitespace-pre-line rounded-lg px-3 py-2 text-sm", !noted && "max-w-[80%]", isUser ? "bg-primary text-primary-foreground" : "border bg-card")}>
            {content}
            {streaming && <span className="inline-block animate-pulse">▋</span>}
        </div>
    );
    // Before the bubble, not after: a badge on the right insets the bubble's edge, so every answer
    // would shift left the moment the review lands.
    const badge = isUser && moveClass ? <MoveBadge moveClass={moveClass} /> : null;
    if (noted) {
        return (
            <div className="flex items-start gap-2">
                <MoveTip comment={comment} />
                {/* Tip holds the left edge, answer the right: a run reads as tips down one side and
                    answers down the other. The pair is wrapped so the badge keeps its old place on the
                    answer's LAST line while the tip starts on its first, and neither box carries a
                    percentage max-width - flex shrinking does the capping once a tip takes the left. */}
                <div className="ml-auto flex min-w-0 items-end gap-2">
                    {badge}
                    {bubble}
                </div>
            </div>
        );
    }
    return (
        <div className={`flex items-end gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
            {badge}
            {bubble}
        </div>
    );
});

function Spinner() {
    return <span role="status" aria-label="Loading" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}
