import { chatTurnLimit, spendChatTurn, utcDay, SPEND_TURN_SQL } from "./billing.ts";
import { resolveConfig } from "./byok.ts";
import { fetchrow, getPool } from "./db.ts";
import { HttpError } from "./errors.ts";
import { type LLMConfig, PRO_CONFIG } from "./llm.ts";
import type { ClerkUser } from "./models.ts";

// main.py's _chat_config dependency: a premium tier chats on the deployment's own model, unless the owner brought a key.
export async function chatConfig(user: ClerkUser, tier: string): Promise<LLMConfig> {
    const base = await resolveConfig(user);
    if (base.byok || PRO_CONFIG === null) return base;
    return tier === "premium" ? PRO_CONFIG : base;
}

export function lockoutDetail(tier: string, byok: boolean, limit: number): string {
    if (!byok) return "Daily chat-turn credits reached. Try again after midnight UTC, or upgrade to Pro.";
    const pro = chatTurnLimit("premium", true);
    return `Daily chat-turn limit reached (${limit} turns/day on your own provider). Try again after midnight UTC.${tier === "free" ? ` Pro raises it to ${pro}.` : ""}`;
}

// main.py's _spend_chat_turn: the turn is charged before the call, because a provider timeout is the price of asking.
export async function spendChatTurnOrFail(user: ClerkUser, config: LLMConfig, tier: string): Promise<void> {
    const limit = chatTurnLimit(tier, config.byok);
    if (!(await spendChatTurn(user.sub, limit))) throw new HttpError(402, lockoutDetail(tier, config.byok, limit));
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
export async function spendAndStoreTurn(user: ClerkUser, config: LLMConfig, tier: string, interviewId: string, content: string, repair: boolean): Promise<string> {
    const limit = chatTurnLimit(tier, config.byok);
    const row = await fetchrow(getPool().unsafe<{ id: string }[]>(CHAT_TURN_SQL, [user.sub, utcDay(), limit, content, interviewId, repair]));
    if (row === undefined) throw new HttpError(402, lockoutDetail(tier, config.byok, limit));
    return row.id;
}
