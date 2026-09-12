import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { apiDetail, completeInterview, type Feedback, getFeedback, getInterview, getMessages, httpStatus, type Message, regenerateFeedback, startInterview, streamChat } from "@/lib/api";
import { OPENING_ASKS_RESUME } from "@/lib/config";
import { FeedbackView } from "./FeedbackView";
import { UpgradeNotice } from "./UsageBadge";

interface Props {
    interviewId: string;
    onExit: () => void;
}

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
    const [completing, setCompleting] = useState(false); // 'Completing…' / 'Retry scoring…' spinner
    const [scoringTip, setScoringTip] = useState(false); // completed but feedback not ready yet
    const abortRef = useRef<AbortController | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);

    const loadMessages = useCallback(async () => {
        try {
            setMessages(await getMessages(interviewId));
        } catch {
            setError("Could not load conversation.");
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
            const [interview] = await Promise.all([getInterview(id), loadMessages()]);
            if (interview.status !== "completed") return "ready" as const;
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
                await startInterview(interviewId);
                if (cancelled) return;
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

    async function send() {
        const content = draft.trim();
        if (!content || status !== "ready") return;
        setDraft("");
        setError(null);
        setStatus("streaming");

        // Optimistically show the user's message; the backend persists it too.
        const userMsg: Message = {
            id: `local-${Date.now()}`,
            interview_id: interviewId,
            role: "user",
            content,
            created_at: new Date().toISOString(),
        };
        setMessages((m) => [...m, userMsg]);
        setAssistBuf("");

        const ac = new AbortController();
        abortRef.current = ac;
        // Local accumulator, deliberately not state: a fast reply (the canned closing line) delivers
        // message+done in the same tick, before React re-renders, so a ref mirrored from state is
        // still empty at "done" and the reply never reaches the transcript.
        let buffer = "";
        try {
            await streamChat(
                interviewId,
                content,
                (ev) => {
                    if (ev.kind === "message") {
                        buffer += ev.content;
                        setAssistBuf(buffer);
                    } else if (ev.kind === "done") {
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
                    } else if (ev.kind === "error") {
                        setError(ev.message || "Streaming error.");
                        setStatus("ready");
                    }
                },
                { signal: ac.signal },
            );
        } catch (e: unknown) {
            if ((e as { name?: string })?.name !== "AbortError") {
                const st = httpStatus(e);
                if (st === 402) setQuotaLocked(true);
                else if (st === 409) setInterviewOver(true);
                else setError("Connection lost while streaming.");
            }
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
        <Card className="flex h-[80vh] w-full max-w-2xl flex-col">
            <CardHeader className="flex-row items-center justify-between space-y-0">
                <div>
                    <CardTitle>Interview</CardTitle>
                    <CardDescription>{status}</CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={onExit}>
                    Exit
                </Button>
            </CardHeader>

            {feedback ? (
                <FeedbackView feedback={feedback} />
            ) : (
                <>
                    <CardContent className="flex-1 overflow-y-auto space-y-3" ref={scrollRef}>
                        {error && <p className="text-sm text-destructive">{error}</p>}
                        {quotaLocked && <UpgradeNotice reason="your free chat turns ran out." />}
                        {interviewOver && (
                            <div role="status" className="rounded-lg border p-3 text-sm">
                                <p className="font-medium">That was the whole interview.</p>
                                <p className="mt-1 text-muted-foreground">
                                    This run has asked every question in its mix, so there's nothing left to answer here. Press <span className="font-medium text-foreground">Complete</span> for your feedback, or start a new interview with a wider mix.
                                </p>
                            </div>
                        )}
                        {status === "loading" && <p className="text-sm text-muted-foreground">Starting…</p>}
                        {messages.length === 0 && OPENING_ASKS_RESUME && <Bubble from="assistant" content={OPENING_ASKS_RESUME} />}
                        {messages.map((m) => (
                            <Bubble key={m.id} from={m.role} content={m.content} />
                        ))}
                        {assistBuf && <Bubble from="assistant" content={assistBuf} streaming />}
                        {status === "streaming" && !assistBuf && <p className="text-sm text-muted-foreground">Thinking…</p>}
                        {scoringTip && status === "completed" && (
                            <div role="status" className="rounded-lg border p-3 text-sm">
                                <p className="font-medium">Interview complete — scoring wasn't ready.</p>
                                <p className="mt-1 text-muted-foreground">We couldn't generate your feedback this run. Try scoring again, or exit and check your history.</p>
                                <Button variant="outline" size="sm" className="mt-2" onClick={() => void retryScoring()} disabled={completing}>
                                    {completing && <Spinner />}
                                    {completing ? "Scoring…" : "Retry scoring"}
                                </Button>
                            </div>
                        )}
                    </CardContent>
                    <CardFooter className="gap-2">
                        <Textarea
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            placeholder={interviewOver ? "Interview finished — press Complete" : status === "ready" ? "Type your answer to the interviewer..." : status === "streaming" ? "Waiting for the interviewer..." : "Starting…"}
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
                </>
            )}
        </Card>
    );
}

function Bubble({ from, content, streaming }: { from: string; content: string; streaming?: boolean }) {
    const isUser = from === "user";
    return (
        <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
            <div className={isUser ? "max-w-[80%] whitespace-pre-line rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground" : "max-w-[80%] whitespace-pre-line rounded-lg border bg-card px-3 py-2 text-sm"}>
                {content}
                {streaming && <span className="inline-block animate-pulse">▋</span>}
            </div>
        </div>
    );
}

function Spinner() {
    return <span role="status" aria-label="Loading" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}
