import { Hono } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import { getCurrentUser } from "../auth.ts";
import { redoLimit, resolveTier } from "../billing.ts";
import { resolveConfig } from "../byok.ts";
import { chatConfig, spendAndStoreTurn, spendChatTurnOrFail } from "../chatconfig.ts";
import { fetch, fetchrow, sql } from "../db.ts";
import { HttpError, validationError } from "../errors.ts";
import { feedbackCols, feedbackPayload, feedbackRow, generateAndPersistFeedback, syncOffer, upsertFeedback } from "../feedback.ts";
import { type LLMConfig, closingLine, failShout, isClosingTurn, isInterviewFinished, judgeAnswer, providerHost, streamChat, systemPrompt, unreachableDetail } from "../llm.ts";
import { log } from "../logs.ts";
import { type ChatMessage, ChatTurn, Dials, FeedbackCreate, totalComp } from "../models.ts";
import { bandRange, startDate, tier as offerTier } from "../offer.ts";
import { FAIL_CLASSES, grade } from "../rating.ts";

export const chat = new Hono();

// Nobody is left to notify, so this unwinds the model stream without a `llm.chat.failed` line or a frame.
class ClientGone extends Error {}

class EmptyReply extends Error {
    override name = "RuntimeError";
}

type Session = {
    interview: { role: string; level: string; topic: string; resume_text: string | null };
    prior: ChatMessage[];
    asked: number;
    dials: Dials;
};

function failClass(cls: string): boolean {
    return (FAIL_CLASSES as readonly string[]).includes(cls);
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : String(error);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function elapsed(started: number): number {
    return Math.round((performance.now() - started) * 10) / 10;
}

function systemTurn(session: Session): ChatMessage {
    return {
        role: "system",
        content: systemPrompt(session.interview.role, session.interview.level, { topic: session.interview.topic, asked: session.asked, dials: session.dials, resume: session.interview.resume_text ?? "" }),
    };
}

async function chatSession(interviewId: string, ownerId: string): Promise<Session> {
    const interview = await fetchrow(sql`
        SELECT role, level, topic, status, failed_turn, company_size, cynicism, brutally_honest, human_mode, hardcore, depth,
               (SELECT r.text FROM resumes r WHERE r.id = interviews.resume_id) AS resume_text,
               (SELECT coalesce(jsonb_agg(jsonb_build_object('role', m.role, 'content', m.content) ORDER BY m.created_at), '[]')
                  FROM chat_turns m WHERE m.interview_id = interviews.id) AS transcript
        FROM interviews WHERE id = ${interviewId} AND owner_id = ${ownerId}
    `);
    if (interview === undefined) throw new HttpError(404, "Interview not found");
    if (interview.status !== "in_progress") throw new HttpError(409, "Interview is not in progress");
    // Hardcore runs end at the first wrong answer; the client stops the composer, and this is what
    // makes that final rather than a UI rule the next request could ignore.
    if (interview.failed_turn) throw new HttpError(409, "This hardcore run is over: one vague or wrong answer ended it. Press Finish for the feedback.");
    const prior = interview.transcript as ChatMessage[];
    // Interviewer turns already asked, which selects the arc phase. Derived from the transcript, not stored.
    const asked = prior.filter((row) => row.role === "assistant").length;
    const dials = Dials.parse({
        company_size: interview.company_size,
        cynicism: interview.cynicism,
        brutally_honest: interview.brutally_honest,
        human_mode: interview.human_mode,
        hardcore: interview.hardcore,
        depth: interview.depth,
    });
    // Once the arc is spent the interview is over: refuse before spending a chat credit or a model call.
    // The sign-off was the previous turn, so this is what makes it final.
    if (isInterviewFinished(asked, dials)) {
        throw new HttpError(409, "This interview has asked all of its questions. Press Finish to get your feedback, or start a new interview at a deeper level.");
    }
    return { interview: interview as Session["interview"], prior, asked, dials };
}

async function replyFrames(stream: SSEStreamingApi, config: LLMConfig, history: ChatMessage[], interviewId: string, asked: number, onError?: () => Promise<void>): Promise<void> {
    const collected: string[] = [];
    const started = performance.now();
    try {
        for await (const delta of streamChat(history, config)) {
            if (delta === "") continue;
            collected.push(delta);
            await stream.writeSSE({ event: "message", data: delta });
            if (stream.aborted) throw new ClientGone();
        }
        const reply = collected.join("").trim();
        if (reply === "") throw new EmptyReply("the model returned no reply"); // an empty bubble would read as answered
        await fetchrow(sql`INSERT INTO chat_turns (interview_id, role, content) VALUES (${interviewId}, 'assistant', ${reply}) RETURNING id`);
        // AI HERE: `chars` stands in for tokens; the provider reports usage only when asked.
        log.info("llm.chat.completed", { interview_id: interviewId, model: config.model, asked, chars: reply.length, latency_ms: elapsed(started) });
    } catch (error) {
        if (error instanceof ClientGone) throw error;
        // Model or DB failure while the turn is in flight: whatever the caller wrote first must not
        // outlive it, or the next send duplicates it (see the reply path's trailing-user-turn repair).
        log.warning("llm.chat.failed", { interview_id: interviewId, model: config.model, byok: config.byok, provider: providerHost(config), asked, reason: errorName(error), latency_ms: elapsed(started) });
        if (onError !== undefined) await onError();
        // The client shows this verbatim: an unreachable provider is the one failure its owner can
        // fix themselves, and "ConnectError" is not that sentence.
        await stream.writeSSE({ event: "error", data: unreachableDetail(error, config) || errorMessage(error) });
        return;
    }
    await stream.writeSSE({ event: "done", data: "{}" });
}

function offerPayload(row: Record<string, unknown>) {
    const [bandLow, bandHigh] = bandRange(row.band as string);
    const [tierSlug, tierLabel] = offerTier(row.performance as number);
    return {
        interview_id: row.interview_id,
        role: row.role,
        level: row.level,
        title: row.title,
        band: row.band,
        band_low: bandLow,
        band_high: bandHigh,
        base_salary: row.base_salary,
        signing_bonus: row.signing_bonus,
        equity: row.equity,
        performance: row.performance,
        tier: tierSlug,
        tier_label: tierLabel,
        benefits: row.benefits ?? [],
        accuracy: row.accuracy,
        grade: grade(row.accuracy as number | null, row.failed_class !== null),
        decision: row.decision,
        created_at: row.created_at,
        starts_on: startDate(new Date(row.created_at as string)),
        total_comp: totalComp({ base_salary: row.base_salary as number, equity: row.equity as number }),
    };
}

chat.get("/interviews/:interview_id/chat", async (c) => {
    const user = await getCurrentUser(c);
    // Owned-but-empty returns its own row with NULL message columns, which is how it is told from
    // not-yours in one statement; dropping the LEFT JOIN would silently turn [] into a 404.
    const rows = await fetch(sql`
        SELECT m.id::text, m.interview_id::text, m.role, m.content, m.move_class, m.comment, m.created_at
        FROM interviews i
        LEFT JOIN chat_turns m ON m.interview_id = i.id
        WHERE i.id = ${c.req.param("interview_id")} AND i.owner_id = ${user.sub}
        ORDER BY m.created_at, m.id
    `);
    if (rows.length === 0) throw new HttpError(404, "Interview not found");
    return c.json(rows.filter((row) => row.id !== null));
});

chat.get("/interviews/:interview_id/feedback", async (c) => {
    const user = await getCurrentUser(c);
    // The LEFT JOIN carries both 404s: no row is a foreign or missing interview, a row with no feedback
    // columns is an owned interview that was never scored.
    const row = await fetchrow(sql`SELECT ${feedbackCols()} FROM interviews i LEFT JOIN feedback f ON f.interview_id = i.id WHERE i.id = ${c.req.param("interview_id")} AND i.owner_id = ${user.sub}`);
    if (row === undefined) throw new HttpError(404, "Interview not found");
    if (row.id === null) throw new HttpError(404, "Feedback not found");
    return c.json(feedbackPayload(row));
});

chat.post("/interviews/:interview_id/feedback", async (c) => {
    const user = await getCurrentUser(c);
    const interviewId = c.req.param("interview_id");
    const parsed = FeedbackCreate.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) throw validationError(parsed.error, "body");
    const owned = await fetchrow(sql`SELECT 1 FROM interviews WHERE id = ${interviewId} AND owner_id = ${user.sub}`);
    if (owned === undefined) throw new HttpError(404, "Interview not found");
    const body = parsed.data;
    await upsertFeedback(interviewId, body.scores, body.verdict, body.tips, body.decision, body.certainty);
    await syncOffer(interviewId);
    return c.json(await feedbackRow(interviewId), 201);
});

chat.post("/interviews/:interview_id/feedback/generate", async (c) => {
    const user = await getCurrentUser(c);
    const interviewId = c.req.param("interview_id");
    // One row answers all four guards: ownership, status, transcript, redos. The 404, then each 409,
    // then the 402/409 redo gate keep the order the separate reads gave the caller.
    const row = await fetchrow(sql`
        SELECT i.status, f.redos,
               EXISTS (SELECT 1 FROM chat_turns m WHERE m.interview_id = i.id AND m.role = 'user') AS has_transcript
        FROM interviews i
        LEFT JOIN feedback f ON f.interview_id = i.id
        WHERE i.id = ${interviewId} AND i.owner_id = ${user.sub}
    `);
    if (row === undefined) throw new HttpError(404, "Interview not found");
    if (row.status !== "completed") throw new HttpError(409, "Interview is not completed");
    if (!row.has_transcript) throw new HttpError(409, "Nothing to score yet: this interview has no answers.");
    // Redo allowance, per run. A run that never got a review reads as zero spent, so the repair path
    // stays open to an owner who has nothing to lose.
    const tier = await resolveTier(user);
    const limit = redoLimit(tier);
    if ((row.redos ?? 0) >= limit) {
        const spent = `This run has used all ${limit} of its review redos.`;
        const upsell = tier === "free";
        throw new HttpError(upsell ? 402 : 409, upsell ? `${spent} Pro raises that limit.` : spent);
    }
    if ((await generateAndPersistFeedback(interviewId, user)) === null) {
        throw new HttpError(503, "Scoring model could not produce feedback right now; try again later.");
    }
    await fetchrow(sql`UPDATE feedback SET redos = redos + 1 WHERE interview_id = ${interviewId}`);
    return c.json(await feedbackRow(interviewId));
});

chat.post("/interviews/:interview_id/chat/opening", async (c) => {
    const user = await getCurrentUser(c);
    const interviewId = c.req.param("interview_id");
    const session = await chatSession(interviewId, user.sub);
    if (session.asked) throw new HttpError(409, "This interview has already opened.");
    const tier = await resolveTier(user);
    const config = await resolveConfig(user);
    const chatModel = await chatConfig(user, tier);
    await spendChatTurnOrFail(user, config, tier);
    const history = [systemTurn(session)];
    return streamSSE(c, async (stream) => {
        try {
            await replyFrames(stream, chatModel, history, interviewId, session.asked);
        } catch (error) {
            // Nobody is left to notify: the opening spent its turn, and there is no user turn to roll back.
            if (!(error instanceof ClientGone)) throw error;
        }
    });
});

chat.post("/interviews/:interview_id/chat/send", async (c) => {
    const user = await getCurrentUser(c);
    const interviewId = c.req.param("interview_id");
    const parsed = ChatTurn.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) throw validationError(parsed.error, "body");
    const body = parsed.data;
    const session = await chatSession(interviewId, user.sub);

    // A trailing user turn means an earlier attempt died before its reply landed, so this send REPLACES it,
    // past the guards only. The stale row leaves the history too, or the model sees the answer twice.
    const repair = session.prior.length > 0 && session.prior[session.prior.length - 1].role === "user";
    const tier = await resolveTier(user);
    const config = await resolveConfig(user);
    const chatModel = await chatConfig(user, tier);
    const userMsgId = await spendAndStoreTurn(user, config, tier, interviewId, body.content, repair);
    const prior = repair ? session.prior.slice(0, -1) : session.prior;

    const discardTurn = async (): Promise<void> => {
        try {
            await fetchrow(sql`DELETE FROM chat_turns WHERE id = ${userMsgId} AND interview_id = ${interviewId} AND (SELECT status FROM interviews WHERE id = ${interviewId}) = 'in_progress'`);
        } catch {
            log.warning("chat.turn_rollback_failed", { interview_id: interviewId });
        }
    };

    const history: ChatMessage[] = [systemTurn(session), ...prior.map((row) => ({ role: row.role, content: row.content })), { role: "user", content: body.content }];

    return streamSSE(c, async (stream) => {
        // The client went away before the first token: the same rollback the mid-stream path runs.
        stream.onAbort(discardTurn);
        try {
            // Judged before the interviewer replies: one failing answer ends the run, and the mode promises
            // never to spend a question on someone already out. The last answer counts too.
            if (session.dials.hardcore) {
                const turn = history.filter((message) => message.role === "user").length;
                const question = [...prior].reverse().find((row) => row.role === "assistant")?.content ?? "";
                const move = await judgeAnswer(question, body.content, config, turn);
                if (move !== null) {
                    await fetchrow(sql`UPDATE chat_turns SET move_class = ${move.cls}, comment = ${move.comment} WHERE id = ${userMsgId}`);
                    if (failClass(move.cls)) {
                        await fetchrow(sql`UPDATE interviews SET failed_turn = ${turn}, failed_class = ${move.cls}, updated_at = now() WHERE id = ${interviewId}`);
                        const shout = await failShout(question, body.content, move.cls, config);
                        // Persisted like any other reply, or a reload ends on the candidate's own answer with no
                        // callout. Best-effort: a DB hiccup must cost the stored line, not the shout.
                        try {
                            await fetchrow(sql`INSERT INTO chat_turns (interview_id, role, content) VALUES (${interviewId}, 'assistant', ${shout}) RETURNING id`);
                        } catch (error) {
                            log.warning("chat.shout_persist_failed", { interview_id: interviewId, reason: errorName(error) });
                        }
                        await stream.writeSSE({ event: "message", data: shout });
                        // `failed` tells the client WHY the run ended (the arc being spent is the other ending).
                        await stream.writeSSE({ event: "done", data: `{"closing": true, "failed": {"turn": ${turn}, "class": "${move.cls}"}}` });
                        return;
                    }
                }
            }

            // Generated like any other turn, so it spends a chat turn. The canned line guards the case where
            // the model asks a question the API would refuse (llm.closing_line).
            if (isClosingTurn(session.asked, session.dials)) {
                const closing = await closingLine(history, chatModel);
                await fetchrow(sql`INSERT INTO chat_turns (interview_id, role, content) VALUES (${interviewId}, 'assistant', ${closing}) RETURNING id`);
                await stream.writeSSE({ event: "message", data: closing });
                // Tells the client the run is over in the same frame it renders the sign-off.
                await stream.writeSSE({ event: "done", data: '{"closing": true}' });
                return;
            }

            await replyFrames(stream, chatModel, history, interviewId, session.asked, discardTurn);
        } catch (error) {
            // Client went away (the SSE stream was cancelled): same rollback, nobody left to notify.
            await discardTurn();
            if (!(error instanceof ClientGone)) throw error;
        }
    });
});

chat.get("/interviews/:interview_id/offer", async (c) => {
    const user = await getCurrentUser(c);
    const row = await fetchrow(sql`
        SELECT o.interview_id::text, o.title, o.band, o.base_salary, o.signing_bonus, o.equity, o.performance, o.benefits, o.created_at,
               i.role, i.level, i.failed_class, f.accuracy, f.decision
        FROM offers o
        JOIN interviews i ON i.id = o.interview_id
        LEFT JOIN feedback f ON f.interview_id = o.interview_id
        WHERE o.interview_id = ${c.req.param("interview_id")} AND i.owner_id = ${user.sub}
    `);
    if (row === undefined) throw new HttpError(404, "No offer for this interview");
    return c.json(offerPayload(row));
});
