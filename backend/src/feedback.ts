import { resolveConfig } from "./byok.ts";
import { fetch, fetchrow, sql } from "./db.ts";
import { generateFeedback, judgeAnswer, type LLMConfig } from "./llm.ts";
import { type ChatMessage, type ClerkUser, Dials, HIRING_DECISIONS, type Move } from "./models.ts";
import { withSpan } from "./observability.ts";
import { terms } from "./offer.ts";
import { accuracy, FAIL_CLASSES, grade } from "./rating.ts";

const COMPLETE_MAX_FEEDBACK_ATTEMPTS = 3;
const COMPLETE_FEEDBACK_BACKOFF_MS = 800;

type TurnRow = { id: string; role: string; content: string; move_class: string | null; comment: string | null };

function isFailClass(cls: string): boolean {
    return (FAIL_CLASSES as readonly string[]).includes(cls);
}

function sleep(ms: number): Promise<void> {
    return new Promise((done) => setTimeout(done, ms));
}

export function feedbackCols() {
    return sql`f.id::text, f.interview_id::text, f.scores, f.verdict, f.tips, f.decision, f.certainty, f.accuracy, f.redos, i.failed_turn, i.failed_class, f.created_at`;
}

export function feedbackPayload(row: Record<string, unknown>) {
    return { ...row, grade: grade(row.accuracy as number | null, row.failed_turn !== null) };
}

export async function feedbackRow(interviewId: string): Promise<Record<string, unknown>> {
    const row = await fetchrow(sql`SELECT ${feedbackCols()} FROM feedback f JOIN interviews i ON i.id = f.interview_id WHERE f.interview_id = ${interviewId}`);
    if (row === undefined) throw new Error("feedback row missing after write");
    return feedbackPayload(row);
}

// `accuracy` is COALESCEd, not overwritten: it derives from the stored message classes, so a raw POST
// /feedback must not wipe a grade an earlier pass earned.
export async function upsertFeedback(interviewId: string, scores: Record<string, number>, verdict: string, tips: string[], decision: string | null = null, certainty: number | null = null, acc: number | null = null): Promise<void> {
    await fetchrow(sql`
        INSERT INTO feedback (interview_id, scores, verdict, tips, decision, certainty, accuracy)
        VALUES (${interviewId}, ${scores}, ${verdict}, ${tips}, ${decision}, ${certainty}, ${acc})
        ON CONFLICT (interview_id) DO UPDATE SET scores = EXCLUDED.scores, verdict = EXCLUDED.verdict, tips = EXCLUDED.tips, decision = EXCLUDED.decision, certainty = EXCLUDED.certainty, accuracy = COALESCE(EXCLUDED.accuracy, feedback.accuracy), created_at = now()
    `);
}

export async function syncOffer(interviewId: string): Promise<void> {
    const row = await fetchrow(sql`SELECT i.role, i.level, f.scores, f.accuracy, f.decision FROM interviews i JOIN feedback f ON f.interview_id = i.id WHERE i.id = ${interviewId} AND i.status = 'completed'`);
    if (row === undefined) return;
    if (!(HIRING_DECISIONS as readonly string[]).includes(row.decision)) {
        await fetchrow(sql`DELETE FROM offers WHERE interview_id = ${interviewId}`);
        return;
    }
    const priced = terms(row.role, row.level, (row.scores as Record<string, unknown> | null) ?? {}, row.accuracy as number | null);
    if (priced === null) return;
    await fetchrow(sql`
        INSERT INTO offers (interview_id, title, band, base_salary, signing_bonus, equity, performance, benefits)
        VALUES (${interviewId}, ${priced.title}, ${priced.band}, ${priced.base_salary}, ${priced.signing_bonus}, ${priced.equity}, ${priced.performance}, ${priced.benefits})
        ON CONFLICT (interview_id) DO UPDATE SET title = EXCLUDED.title, band = EXCLUDED.band, base_salary = EXCLUDED.base_salary, signing_bonus = EXCLUDED.signing_bonus, equity = EXCLUDED.equity, performance = EXCLUDED.performance, benefits = EXCLUDED.benefits, created_at = now()
    `);
}

export function questionsByTurn(historyRows: TurnRow[]): Record<number, string> {
    const questions: Record<number, string> = {};
    let asked = "";
    let turn = 0;
    for (const row of historyRows) {
        if (row.role === "assistant") {
            asked = row.content;
        } else if (row.role === "user") {
            turn += 1;
            questions[turn] = asked;
        }
    }
    return questions;
}

export async function persistMoves(interviewId: string, candidateIds: string[], moves: Record<string, Move>): Promise<string[]> {
    const graded = Object.entries(moves).flatMap(([turn, move]) => (/^\d+$/.test(turn) && Number(turn) >= 1 && Number(turn) <= candidateIds.length ? [[Number(turn), move] as const] : []));
    if (graded.length === 0) return [];
    const classes: (string | null)[] = [];
    const comments: (string | null)[] = [];
    for (let turn = 1; turn <= candidateIds.length; turn += 1) {
        const found = graded.find(([n]) => n === turn);
        classes.push(found?.[1].cls ?? null);
        comments.push(found?.[1].comment ?? null);
    }
    await fetch(sql`
        UPDATE chat_turns SET move_class = u.move_class, comment = u.comment
        FROM unnest(${candidateIds}::text[], ${classes}::text[], ${comments}::text[]) AS u(id, move_class, comment)
        WHERE chat_turns.id = u.id::uuid AND chat_turns.interview_id = ${interviewId}
        RETURNING chat_turns.id
    `);
    return graded.map(([, move]) => move.cls);
}

export async function reconcileHardcoreMoves(interviewId: string, historyRows: TurnRow[], candidateRows: TurnRow[], config: LLMConfig): Promise<string[]> {
    const judged: (Move | null)[] = candidateRows.map((row) => (row.move_class ? { cls: row.move_class, comment: row.comment } : null));
    const holes = judged.flatMap((move, index) => (move === null || !move.comment ? [index + 1] : []));
    if (holes.length === 0) return judged.flatMap((move) => (move === null ? [] : [move.cls]));
    const questions = questionsByTurn(historyRows);
    const fill: Record<number, Move> = {};
    for (const turn of holes) {
        const got = await judgeAnswer(questions[turn] ?? "", candidateRows[turn - 1].content, config, turn);
        if (got !== null) fill[turn] = got;
    }
    const merged: Record<string, Move> = {};
    judged.forEach((move, index) => {
        const turn = index + 1;
        const cls = move?.cls ?? fill[turn]?.cls ?? null;
        if (cls !== null) merged[String(turn)] = { cls, comment: move?.comment ?? fill[turn]?.comment ?? null };
    });
    const persisted = await persistMoves(
        interviewId,
        candidateRows.map((row) => row.id),
        merged,
    );
    return persisted.length > 0 ? persisted : judged.flatMap((move) => (move === null ? [] : [move.cls]));
}

export async function runFeedbackPipeline(interviewId: string, config: LLMConfig): Promise<Record<string, unknown> | null> {
    // The `, id` tiebreak keeps the order stable: llm numbers candidate turns off this exact list.
    const historyRows = (await fetch(sql`SELECT id::text, role, content, move_class, comment FROM chat_turns WHERE interview_id = ${interviewId} ORDER BY created_at, id`)) as TurnRow[];
    const history: ChatMessage[] = historyRows.map((row) => ({ role: row.role, content: row.content }));
    const row = await fetchrow(sql`
        SELECT company_size, cynicism, brutally_honest, human_mode, hardcore, depth, level, failed_turn, failed_class,
               (SELECT r.text FROM resumes r WHERE r.id = interviews.resume_id) AS resume_text
        FROM interviews WHERE id = ${interviewId}
    `);
    const dials =
        row === undefined
            ? null
            : Dials.parse({
                  company_size: row.company_size,
                  cynicism: row.cynicism,
                  brutally_honest: row.brutally_honest,
                  human_mode: row.human_mode,
                  hardcore: row.hardcore,
                  depth: row.depth,
              });
    const failure: [number, string] | null = row?.failed_turn ? [row.failed_turn as number, (row.failed_class as string | null) ?? ""] : null;
    // A hardcore run was already judged turn by turn as it was answered (send_turn), so its
    // annotation pass would only re-litigate verdicts the candidate was told about.
    const hardcore = dials?.hardcore === true;
    const summary = await generateFeedback(history, dials, config, {
        failure,
        annotate: !hardcore,
        resume: (row?.resume_text as string | null) ?? "",
        level: (row?.level as string | null) ?? "any",
    });
    if (summary === null) return null;
    const candidateRows = historyRows.filter((row) => row.role === "user");
    const classes = hardcore
        ? await reconcileHardcoreMoves(interviewId, historyRows, candidateRows, config)
        : await persistMoves(
              interviewId,
              candidateRows.map((row) => row.id),
              summary.moves,
          );
    const acc = accuracy(classes);
    // Safety net: hardcore, no failure recorded (the live judge came back empty on some turn), and this
    // transcript does contain one. Record it, or the review would show F with nothing to shout about.
    if (hardcore && failure === null) {
        const wrong = classes.findIndex((cls) => isFailClass(cls));
        if (wrong !== -1) {
            await fetchrow(sql`UPDATE interviews SET failed_turn = ${wrong + 1}, failed_class = ${classes[wrong]} WHERE id = ${interviewId}`);
        }
    }
    // Accuracy averages what was STORED, not the model's payload: a turn the writer dropped must not
    // count towards the score it never earned.
    await upsertFeedback(interviewId, summary.scores, summary.verdict, summary.tips, summary.decision, summary.certainty, acc);
    await syncOffer(interviewId);
    return await feedbackRow(interviewId);
}

async function attemptFeedback(interviewId: string, config: LLMConfig): Promise<Record<string, unknown> | null> {
    return await withSpan("feedback.generate", {}, async (span) => {
        const row = await runFeedbackPipeline(interviewId, config);
        span.setAttribute("feedback.outcome", row === null ? "error" : "ok");
        return row;
    });
}

export async function generateAndPersistFeedback(interviewId: string, user: ClerkUser): Promise<Record<string, unknown> | null> {
    return await attemptFeedback(interviewId, await resolveConfig(user));
}

export async function autoGenerateAndPersistFeedback(interviewId: string, config: LLMConfig): Promise<void> {
    for (let attempt = 0; attempt < COMPLETE_MAX_FEEDBACK_ATTEMPTS; attempt += 1) {
        if ((await attemptFeedback(interviewId, config)) !== null) return;
        if (attempt < COMPLETE_MAX_FEEDBACK_ATTEMPTS - 1) await sleep(COMPLETE_FEEDBACK_BACKOFF_MS);
    }
}
