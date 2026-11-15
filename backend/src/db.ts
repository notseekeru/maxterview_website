import dc from "node:diagnostics_channel";
import postgres, { type PendingQuery, type PostgresType, type QueryTrace, type Row, type Sql } from "postgres";
import { config } from "./env.ts";
import { gauge, record } from "./telemetry.ts";

if (config.databaseUrl === "") throw new Error("DATABASE_URL is required");

// asyncpg hands a timestamptz back as a UTC datetime and pydantic writes it as 2024-01-01T12:00:00.123456Z.
// The wire format is frozen, and Date only carries milliseconds, so the text is reshaped instead of parsed.
// A timestamp (1114) arrives without an offset from a session in another zone; it is given a Z the
// same way rather than left naive.
function isoMoment(value: string): string {
    const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?)([+-]\d{2}(?::\d{2}(?::\d{2})?)?)?$/.exec(value);
    if (match === null) return value;
    const [, day, time, offset] = match;
    if (offset === undefined || offset === "+00" || offset === "-00") return `${day}T${time}Z`;
    // AI HERE: only a session outside UTC reaches Date, and then the sub-millisecond digits are lost.
    // Upgrade path: pin TimeZone=UTC in `connection` once no query depends on the session's zone.
    return new Date(`${day}T${time}${offset}`).toISOString();
}

const TYPES: Record<string, PostgresType<string>> = {
    timestamptz: { from: [1184], parse: isoMoment },
    timestamp: { from: [1114], parse: isoMoment },
    date: { from: [1082], parse: (value) => value },
};

let pool: Sql | null = null;

export function initPool(): void {
    if (pool !== null) return;
    if (config.dbPoolMax < 1) throw new Error("DB_POOL_MAX has to hold at least one connection");
    // postgres.js opens connections on demand, so /health answers with Postgres down, as min_size=0 did.
    // A `-pooler` DSN means PgBouncer in transaction mode, which breaks prepared statements.
    pool = postgres(config.databaseUrl, {
        max: config.dbPoolMax,
        prepare: !config.databaseUrl.includes("-pooler"),
        types: TYPES,
    });
}

export async function closePool(): Promise<void> {
    const current = pool;
    pool = null;
    if (current !== null) await current.end();
}

export function getPool(): Sql {
    if (pool === null) throw new Error("pool not initialized; call initPool() during app startup");
    return pool;
}

// A bare object is a jsonb value to postgres.js: it serialises one, where a pre-stringified one arrives as a
// JSON scalar and Postgres stores the string. Callers pass the value, not its text.
type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export function sql<T extends Row[] = Row[]>(template: TemplateStringsArray, ...parameters: readonly (postgres.ParameterOrFragment<postgres.SerializableParameter> | JsonValue)[]): PendingQuery<T> {
    return getPool()<T>(template, ...(parameters as postgres.ParameterOrFragment<postgres.SerializableParameter>[]));
}

export async function fetch<T extends Row[]>(query: PendingQuery<T>): Promise<T> {
    return await query;
}

export async function fetchrow<T extends Row[]>(query: PendingQuery<T>): Promise<T[number] | undefined> {
    const rows: T = await query;
    return rows[0];
}

export async function execute(query: PendingQuery<Row[]>): Promise<number> {
    return (await query).count;
}

// The first keyword only. The label stays bounded by construction, so no query text ever reaches it.
const OPERATIONS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "WITH"]);

function operation(query: string): string {
    const first = query.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? "";
    return OPERATIONS.has(first) ? first : "other";
}

if (operation("\n  SELECT 1") !== "SELECT" || operation("EXPLAIN 1") !== "other") throw new Error("db operation classifier is broken");

dc.tracingChannel<QueryTrace>("postgres:query").subscribe({
    asyncEnd(event) {
        const current = pool;
        if (current !== null) {
            gauge("db.pool.size", current.stats.connections);
            gauge("db.pool.idle", current.stats.idle);
        }
        if (event.sent === null) return;
        record("db.pool.wait.duration", (event.sent - event.queued) / 1000);
        // A failed query is in the wait but not in the duration: asyncpg's call never returned either.
        if (event.complete !== null && !("error" in event)) record("db.query.duration", (event.complete - event.sent) / 1000, { "db.operation": operation(event.query ?? "") });
    },
});
