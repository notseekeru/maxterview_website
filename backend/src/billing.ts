import { strict as assert } from "node:assert";
import { fetchrow, sql } from "./db.ts";
import { config } from "./env.ts";
import type { ClerkUser } from "./models.ts";

export type Tier = "free" | "premium" | "dev";

type QuotaName = "chat_turns" | "byok_turns" | "resumes" | "redos";

// Daily GLOBAL chat-turn credits PER OWNER, across all interviews in one UTC day.
function limits(): Record<Tier, Record<QuotaName, number>> {
    return {
        free: { chat_turns: config.freeChatTurns, byok_turns: config.byokChatTurns, resumes: config.freeResumes, redos: config.freeRedos },
        premium: { chat_turns: config.premiumChatTurns, byok_turns: config.byokPremiumChatTurns, resumes: config.premiumResumes, redos: config.premiumRedos },
        dev: { chat_turns: config.devChatTurns, byok_turns: config.byokPremiumChatTurns, resumes: config.devResumes, redos: config.devRedos },
    };
}

// `cancelled` included: the provider cancels at once but the invoice stays paid.
const ENTITLED_STATUSES = ["active", "cancelled"];

function quota(tier: string, what: QuotaName): number {
    const table = limits();
    return (table[tier as Tier] ?? table.free)[what];
}

async function entitledRow(ownerId: string) {
    return await fetchrow(sql`
        SELECT plan, current_period_end FROM subscriptions
        WHERE owner_id = ${ownerId} AND plan = 'premium'
          AND status = ANY(${ENTITLED_STATUSES}::text[])
          AND (current_period_end IS NULL OR current_period_end > now())
        `);
}

export async function resolveTier(user: ClerkUser): Promise<Tier> {
    if (!config.clerkEnabled || user.tier === "premium") return tierFrom(user, false);
    return tierFrom(user, (await entitledRow(user.sub)) !== undefined);
}

export function tierFrom(user: ClerkUser, entitled: boolean): Tier {
    if (!config.clerkEnabled) return "dev";
    return user.tier === "premium" || entitled ? "premium" : "free";
}

export type UsageState = { turns: number; byok: boolean; premium_until: string | null };

export async function usageState(user: ClerkUser): Promise<UsageState> {
    const row = await fetchrow(sql`
        SELECT (SELECT turns FROM turn_usage WHERE owner_id = ${user.sub} AND day = ${utcDay()}) AS turns,
               EXISTS(SELECT 1 FROM llm_credentials WHERE owner_id = ${user.sub}) AS byok,
               (SELECT current_period_end FROM subscriptions
                 WHERE owner_id = ${user.sub} AND plan = 'premium'
                   AND status = ANY(${ENTITLED_STATUSES}::text[])
                   AND (current_period_end IS NULL OR current_period_end > now())) AS premium_until
        `);
    assert(row !== undefined);
    return { turns: row.turns ?? 0, byok: Boolean(row.byok), premium_until: row.premium_until ?? null };
}

export async function premiumUntil(ownerId: string): Promise<string | null> {
    return (await entitledRow(ownerId))?.current_period_end ?? null;
}

export function chatTurnLimit(tier: string, byok = false): number {
    return quota(tier, byok ? "byok_turns" : "chat_turns");
}

export function redoLimit(tier: string): number {
    return quota(tier, "redos");
}

export function resumeLimit(tier: string): number {
    return quota(tier, "resumes");
}

export const SPEND_TURN_SQL = `
        INSERT INTO turn_usage (owner_id, day, turns)
        SELECT $1, $2, 1
        WHERE $3 > 0
        ON CONFLICT (owner_id, day) DO UPDATE SET turns = turn_usage.turns + 1
        WHERE turn_usage.turns < $3
        RETURNING turns
        `;

// A `DATE` column and an ISO day string: the UTC day is a calendar fact, not an instant, so it stays text.
export function utcDay(): string {
    return new Date().toISOString().slice(0, 10);
}

export async function spendChatTurn(ownerId: string, limit: number): Promise<boolean> {
    const row = await fetchrow(sql`
        INSERT INTO turn_usage (owner_id, day, turns)
        SELECT ${ownerId}, ${utcDay()}::date, 1
        WHERE ${limit} > 0
        ON CONFLICT (owner_id, day) DO UPDATE SET turns = turn_usage.turns + 1
        WHERE turn_usage.turns < ${limit}
        RETURNING turns
        `);
    return row !== undefined;
}

assert(quota("no-such-tier", "chat_turns") === config.freeChatTurns);
