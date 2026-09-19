import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { apiDetail, completeInterview, type Feedback, getFeedback, getInterview, getMessages, httpStatus, MAX_TURN_CHARS, type Message, regenerateFeedback, startInterview, streamChat } from "@/lib/api";
import { cn } from "@/lib/utils";
import { OPENING_ASKS_RESUME, OPENING_HAS_RESUME } from "@/lib/config";
import { FeedbackView } from "./FeedbackView";
import { MoveBadge } from "./MoveBadge";
import { UpgradeNotice } from "./UsageBadge";

interface Props {
    interviewId: string;
    onExit: () => void;
}

const STREAM_FAILED = "The interviewer couldn't answer just now — the model was unreachable. Your turn wasn't saved, so send it again in a moment.";

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
    const [completing, setCompleting] = useState(false);
    const [scoringTip, setScoringTip] = useState(false);
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
                        setError(STREAM_FAILED);
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
                else setError("Connection lost while streaming.");
                rollback();
                if (st !== 409) setDraft(content);
            }
        } finally {
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
            await loadMessages();
        } catch (e: unknown) {
            setScoringTip(true);
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

    // Hardcore is the only dial with a body count, so it gets the only glow: ambient while the run
    // is live, full strength once it fails. Light-mode red is the darker token - #ff9999 on white
    // is invisible.
    const glow = hardcoreFailed
        ? "border-destructive shadow-[0_0_30px_-2px_rgba(160,0,0,0.45)] dark:shadow-[0_0_34px_-2px_rgba(255,153,153,0.6)]"
        : hardcoreRun && status !== "completed"
          ? "border-destructive/40 shadow-[0_0_20px_-4px_rgba(160,0,0,0.3)] dark:shadow-[0_0_24px_-4px_rgba(255,153,153,0.45)]"
          : undefined;

    return (
        <Card className={cn("flex min-h-0 w-full flex-1 flex-col", glow)}>
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
