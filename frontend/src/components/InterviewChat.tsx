import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { completeInterview, type Feedback, getFeedback, getMessages, type Message, startInterview, streamChat } from "@/lib/api";
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
    const [completing, setCompleting] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    const scrollRef = useRef<HTMLDivElement | null>(null);

    const loadMessages = useCallback(async () => {
        try {
            setMessages(await getMessages(interviewId));
        } catch {
            setError("Could not load conversation.");
        }
    }, [interviewId]);

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
                    const any = e as { status?: number };
                    // Already started (409) is fine; other errors surface.
                    if (any?.status !== 409) setError("Could not start interview.");
                    else await loadMessages();
                    setStatus("ready");
                }
            }
        })();
        return () => {
            cancelled = true;
            abortRef.current?.abort();
        };
    }, [interviewId, loadMessages]);

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
        try {
            await streamChat(
                interviewId,
                content,
                (ev) => {
                    if (ev.kind === "message") {
                        setAssistBuf((prev) => prev + ev.content);
                    } else if (ev.kind === "done") {
                        setMessages((m) => {
                            if (!assistBufRef.current) return m;
                            return [
                                ...m,
                                {
                                    id: `assistant-${Date.now()}`,
                                    interview_id: interviewId,
                                    role: "assistant",
                                    content: assistBufRef.current,
                                    created_at: new Date().toISOString(),
                                },
                            ];
                        });
                        setAssistBuf("");
                        setStatus("ready");
                    } else if (ev.kind === "error") {
                        setError(ev.message || "Streaming error.");
                        setStatus("ready");
                    }
                },
                { signal: ac.signal },
            );
        } catch (e: unknown) {
            if ((e as { name?: string })?.name !== "AbortError") {
                if ((e as { status?: number }).status === 402) setQuotaLocked(true);
                else setError("Connection lost while streaming.");
            }
            setStatus("ready");
        }
    }

    const assistBufRef = useRef("");
    useEffect(() => {
        assistBufRef.current = assistBuf;
    }, [assistBuf]);

    async function complete() {
        setCompleting(true);
        try {
            await completeInterview(interviewId);
            const fb = await getFeedback(interviewId);
            setFeedback(fb);
            setStatus("completed");
        } catch {
            setError("Failed to complete interview / load feedback.");
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
                        {status === "loading" && <p className="text-sm text-muted-foreground">Starting…</p>}
                        {messages.map((m) => (
                            <Bubble key={m.id} from={m.role} content={m.content} />
                        ))}
                        {assistBuf && <Bubble from="assistant" content={assistBuf} streaming />}
                        {status === "streaming" && !assistBuf && <p className="text-sm text-muted-foreground">Thinking…</p>}
                    </CardContent>
                    <CardFooter className="gap-2">
                        <Textarea
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            placeholder={status === "ready" ? "Type your answer to the interviewer..." : status === "streaming" ? "Waiting for the interviewer..." : "Starting…"}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    void send();
                                }
                            }}
                        />
                        <div className="flex flex-col gap-2">
                            <Button onClick={() => void send()} disabled={status !== "ready" || !draft.trim()}>
                                Send
                            </Button>
                            <Button variant="destructive" size="sm" onClick={() => void complete()} disabled={completing || status === "streaming"}>
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
