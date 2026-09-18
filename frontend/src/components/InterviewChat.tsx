import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { apiDetail, completeInterview, type Feedback, getFeedback, getInterview, getMessages, httpStatus, MAX_TURN_CHARS, type Message, regenerateFeedback, startInterview, streamChat } from "@/lib/api";
import { OPENING_ASKS_RESUME, OPENING_HAS_RESUME } from "@/lib/config";
import { FeedbackView } from "./FeedbackView";
import { MoveBadge } from "./MoveBadge";
import { UpgradeNotice } from "./UsageBadge";

interface Props {
    interviewId: string;
    onExit: () => void;
}

// Shown to the candidate when a turn fails for a reason they cannot act on. The backend's
// `event: error` payload is `str(exc)` from the LLM client — provider URLs, timeouts, DNS — which
// is ops detail, not user copy.
const STREAM_FAILED = "The interviewer couldn't answer just now — the model was unreachable. Your turn wasn't saved, so send it again in a moment.";

export function InterviewChat({ interviewId, onExit }: Props) {
    const [status, setStatus] = useState<"loading" | "ready" | "streaming" | "completed">("loading");
    const [messages, setMessages] = useState<Message[]>([]);
    const [draft, setDraft] = useState("");
    const [assistBuf, setAssistBuf] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [feedback, setFeedback] = useState<Feedback | null>(null);
    const [quotaLocked, setQuotaLocked] = useState(false);
    // The question mix is a budget: once it is spent the API refuses further turns (409) and the
    // composer stops, leaving Complete as the only move.
    const [interviewOver, setInterviewOver] = useState(false);
    // Hardcore: the turn and class that ended the run, from the done frame. The run is over and the
    // review will shout, so the transcript says why instead of the generic "mix is spent" notice.
    const [hardcoreFailed, setHardcoreFailed] = useState<{ turn: number; class: string } | null>(null);
    const [completing, setCompleting] = useState(false); // 'Completing…' / 'Retry scoring…' spinner
    const [scoringTip, setScoringTip] = useState(false); // completed but feedback not ready yet
    // The run's attach point, read off whichever call created or fetched it. It only decides the
    // opening bubble: with a resume in hand, asking the candidate to paste one reads as a bug.
    const [hasResume, setHasResume] = useState(false);
    // Synchronous turn lock. `status` is React state, so two clicks landing before a re-render both
    // read "ready" and post the answer twice; this ref cannot be raced that way.
    const sendingRef = useRef(false);
    const abortRef = useRef<AbortController | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    // Which opening bubble this thread gets. Read after the state above exists - a resume in hand
    // means the generic "share your resume" opener would read as if the import had failed.
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

    // Reopening an existing (non-pending) run. POST /start 409s for BOTH in_progress and
    // completed runs, so read the authoritative status rather than inferring "completed"
    // from the conflict. Completed runs show stored feedback, or flag that scoring never
    // landed: 404 from /feedback is that case (the backend writes no row when generation
    // fails) and is the same signal `finish()` sets after a fresh /complete, so both paths
    // render one warning block.
    const loadExisting = useCallback(
        async (id: string) => {
            const [iv] = await Promise.all([getInterview(id), loadMessages()]);
            setHasResume(Boolean(iv.resume_id));
            if (iv.status !== "completed") return "ready" as const;
            try {
                setFeedback(await getFeedback(id));
            } catch (e: unknown) {
                if (httpStatus(e) === 404) setScoringTip(true);
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
                await loadMessages();
                setStatus("ready");
            } catch (e: unknown) {
                if (!cancelled) {
                    const st = httpStatus(e);
                    // NB: do NOT replace with `e.status` — axios nests the status at
                    // response.status, so the top-level read is undefined and this branch
                    // never runs (reopening a run then skips transcript + feedback).
                    if (st !== 409) {
                        setError("Could not start interview.");
                        setStatus("ready");
                    } else {
                        // Not pending (in_progress or completed) — let the interview's real
                        // status drive the UI state.
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

    // A landed review is the first thing in the scroller; without this the view stays parked on the
    // last answer instead of the grade.
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

        // Optimistically show the user's message; the backend persists it too.
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

        // A failed turn is rolled back server-side (the backend deletes the just-inserted user
        // row), so the optimistic bubble must go too — otherwise the transcript here disagrees
        // with the transcript after a reload, and the answer is silently lost.
        const rollback = () => {
            setMessages((m) => m.filter((x) => x.id !== localId));
            setAssistBuf("");
        };

        const ac = new AbortController();
        abortRef.current = ac;
        // Local accumulator, deliberately not state: a fast reply (the canned closing line) delivers
        // message+done in the same tick, before React re-renders, so a ref mirrored from state is
        // still empty at "done" and the reply never reaches the transcript.
        let buffer = "";
        // Did the server give the turn a verdict? A stream can also just stop (proxy drop, worker
        // death), and that must not read as a finished turn.
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
                        // The sign-off is the end of the run: stop the composer here rather than
                        // letting the next message discover the same thing via a 409.
                        if (ev.closing) setInterviewOver(true);
                        if (ev.failed) {
                            setHardcoreFailed(ev.failed);
                            // The server stored this class already, so badge the answer now instead of
                            // waiting for the review to be generated. By this point the reply above has
                            // been appended, so the turn to mark is this one by id, not "the last one".
                            setMessages((m) => m.map((x) => (x.id === localId ? { ...x, move_class: ev.failed?.class ?? null } : x)));
                        }
                    } else if (ev.kind === "error") {
                        settled = true;
                        rollback();
                        setDraft(content);
                        setError(STREAM_FAILED);
                        setStatus("ready");
                    }
                },
                { signal: ac.signal },
            );
            if (!settled) {
                // The stream ended with neither a reply nor an error. The server may have stored the
                // reply we never saw, or rolled the turn back, so ask it rather than guess.
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
                else setError("Connection lost while streaming.");
                rollback();
                // Only worth restoring when the turn could still be sent (quota/transport); the
                // arc being over (409) means the text can never be accepted.
                if (st !== 409) setDraft(content);
            }
        } finally {
            // Unconditional: every path through a turn has to hand the composer back, including the
            // truncated stream above, which throws nothing for the catch to reset on.
            sendingRef.current = false;
            setStatus("ready");
        }
    }

    async function finish(loaded: () => Promise<Feedback>) {
        setStatus("completed");
        setScoringTip(false);
        setError(null);
        try {
            const fb = await loaded();
            setFeedback(fb);
            // The review and the per-answer annotations are written by the same pass, so the transcript
            // fetched when this run was opened predates them: without this reload the badges only show
            // up after a manual refresh (they did exactly that once).
            await loadMessages();
        } catch (e: unknown) {
            // Feedback genuinely absent (or not ready after a scoring attempt). Keep the
            // completed view and offer a retry rather than a hard error or fabricated scores.
            setScoringTip(true);
            // 409 = structural refusal (nothing left to score); 404/503 are retryable and the
            // tip above already says so, so don't stack a jargon error line on top of it.
            if (httpStatus(e) === 409) setError(apiDetail(e));
        }
    }

    async function complete() {
        setCompleting(true);
        try {
            await completeInterview(interviewId);
            await finish(() => getFeedback(interviewId));
        } catch (e: unknown) {
            setError(apiDetail(e, "Failed to complete the interview."));
            setStatus("ready");
        } finally {
            setCompleting(false);
        }
    }

    async function retryScoring() {
        setCompleting(true);
        try {
            await finish(() => regenerateFeedback(interviewId));
        } finally {
            setCompleting(false);
        }
    }

    return (
        <Card className="flex min-h-0 w-full flex-1 flex-col">
            <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                    <CardTitle>Interview</CardTitle>
                    <CardDescription>{status}</CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={onExit}>
                    Exit
                </Button>
            </CardHeader>

            {/* One scroller: the review, then the transcript it argues from. */}
            <CardContent className="flex-1 overflow-y-auto space-y-3" ref={scrollRef} role="log" aria-live="polite" aria-busy={status === "streaming"} aria-label="Interview transcript">
                {/* Safe to always offer: /complete refuses an empty transcript, so a review implies
                    at least one answer to re-annotate. */}
                {feedback && <FeedbackView feedback={feedback} messages={messages} onAnnotate={() => void retryScoring()} annotating={completing} />}
                {error && <p className="text-sm text-destructive">{error}</p>}
                {quotaLocked && <UpgradeNotice reason="your free chat turns ran out." />}
                {interviewOver && (
                    <div role="status" className={hardcoreFailed ? "rounded-lg border border-destructive bg-destructive/10 p-3 text-sm" : "rounded-lg border p-3 text-sm"}>
                        {hardcoreFailed ? (
                            <>
                                <p className="font-semibold uppercase tracking-wide text-destructive">Run failed — hardcore</p>
                                <p className="mt-1 uppercase leading-relaxed text-foreground">
                                    One wrong move. Your answer to question {hardcoreFailed.turn} was a {hardcoreFailed.class}, so the interview stops here.
                                </p>
                                <p className="mt-1 text-muted-foreground">Press Complete for the feedback you earned.</p>
                            </>
                        ) : (
                            <>
                                <p className="font-medium">That was the whole interview.</p>
                                <p className="mt-1 text-muted-foreground">
                                    This run has asked every question in its mix, so there's nothing left to answer here. Press <span className="font-medium text-foreground">Complete</span> for your feedback, or start a new interview with a wider mix.
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
                    <Bubble key={m.id} from={m.role} content={m.content} moveClass={m.move_class} />
                ))}
                {assistBuf && <Bubble from="assistant" content={assistBuf} streaming />}
                {status === "streaming" && !assistBuf && <p className="text-sm text-muted-foreground">Thinking…</p>}
                {scoringTip && status === "completed" && (
                    <div role="status" className="rounded-lg border p-3 text-sm">
                        <p className="font-medium">Interview complete — your review wasn't ready.</p>
                        <p className="mt-1 text-muted-foreground">We couldn't generate your feedback this run. Try again, or exit and check your history.</p>
                        <Button variant="outline" size="sm" className="mt-2" onClick={() => void retryScoring()} disabled={completing}>
                            {completing && <Spinner />}
                            {completing ? "Reviewing…" : "Retry review"}
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
                    placeholder={status === "completed" ? "Review above" : interviewOver ? "Interview finished — press Complete" : status === "ready" ? "Type your answer to the interviewer..." : status === "streaming" ? "Waiting for the interviewer..." : "Starting…"}
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
                    <Button variant="destructive" size="sm" onClick={() => void complete()} disabled={completing || status === "streaming" || status === "completed"}>
                        {completing && <Spinner />}
                        {completing ? "Completing…" : "Complete"}
                    </Button>
                </div>
            </CardFooter>
        </Card>
    );
}

// Memoized: the streaming reply re-renders on every delta, and without this the whole transcript
// re-renders per token. Only the live bubble's content changes.
const Bubble = memo(function Bubble({ from, content, streaming, moveClass }: { from: string; content: string; streaming?: boolean; moveClass?: string | null }) {
    const isUser = from === "user";
    return (
        <div className={`flex items-end gap-2 ${isUser ? "justify-end" : "justify-start"}`}>
            {/* Before the bubble, not after: a badge on the right insets the bubble's edge, so every
                answer would shift left the moment the review lands. */}
            {isUser && moveClass && <MoveBadge moveClass={moveClass} />}
            <div className={isUser ? "max-w-[80%] whitespace-pre-line rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground" : "max-w-[80%] whitespace-pre-line rounded-lg border bg-card px-3 py-2 text-sm"}>
                {content}
                {streaming && <span className="inline-block animate-pulse">▋</span>}
            </div>
        </div>
    );
});

function Spinner() {
    return <span role="status" aria-label="Loading" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}
