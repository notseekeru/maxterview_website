import { chatTurnLimit, SPEND_TURN_SQL, spendChatTurn, utcDay } from "./billing.ts";
import { fetchrow, getPool } from "./db.ts";
import { HttpError } from "./errors.ts";
import { type LLMConfig, PRO_CONFIG, SYSTEM_CONFIG } from "./llm.ts";
import type { ClerkUser } from "./models.ts";

export function chatConfig(tier: string): LLMConfig {
    return tier === "premium" && PRO_CONFIG !== null ? PRO_CONFIG : SYSTEM_CONFIG;
}

const LOCKOUT = "Daily chat-turn credits reached. Try again after midnight UTC, or upgrade to Pro.";

// main.py's _spend_chat_turn: the turn is charged before the call, because a provider timeout is the price of asking.
export async function spendChatTurnOrFail(user: ClerkUser, tier: string): Promise<void> {
    if (!(await spendChatTurn(user.sub, chatTurnLimit(tier)))) throw new HttpError(402, LOCKOUT);
}

export const CHAT_TURN_SQL = `
        WITH spend AS (
            ${SPEND_TURN_SQL}
        ), repaired AS (
            DELETE FROM chat_turns
            WHERE interview_id = $5::uuid
              AND $6::bool
              AND id = (SELECT id FROM chat_turns WHERE interview_id = $5::uuid ORDER BY created_at DESC, id DESC LIMIT 1)
              AND EXISTS (SELECT 1 FROM spend)
        ), stored AS (
            INSERT INTO chat_turns (interview_id, role, content)
            SELECT $5::uuid, 'user', $4 FROM spend
            RETURNING id::text
        )
        SELECT id FROM stored
        `;

// main.py's _spend_and_store_turn: one statement, so a spent turn and its stored user turn cannot disagree.
export async function spendAndStoreTurn(user: ClerkUser, tier: string, interviewId: string, content: string, repair: boolean): Promise<string> {
    const row = await fetchrow(getPool().unsafe<{ id: string }[]>(CHAT_TURN_SQL, [user.sub, utcDay(), chatTurnLimit(tier), content, interviewId, repair]));
    if (row === undefined) throw new HttpError(402, LOCKOUT);
    return row.id;
}
