import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres, { type Sql } from "postgres";
import { config } from "../src/env.ts";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

const INTERNAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS _yoyo_migration (
    migration_hash VARCHAR(64),
    migration_id VARCHAR(255),
    applied_at_utc TIMESTAMP,
    PRIMARY KEY (migration_hash)
);
CREATE TABLE IF NOT EXISTS _yoyo_log (
    id VARCHAR(36),
    migration_hash VARCHAR(64),
    migration_id VARCHAR(255),
    operation VARCHAR(10),
    username VARCHAR(255),
    hostname VARCHAR(255),
    comment VARCHAR(255),
    created_at_utc TIMESTAMP,
    PRIMARY KEY (id)
);
CREATE TABLE IF NOT EXISTS _yoyo_version (
    version INT NOT NULL PRIMARY KEY,
    installed_at_utc TIMESTAMP
);
CREATE TABLE IF NOT EXISTS yoyo_lock (
    locked INT DEFAULT 1,
    ctime TIMESTAMP,
    pid INT NOT NULL,
    PRIMARY KEY (locked)
);
INSERT INTO _yoyo_version (version, installed_at_utc)
    VALUES (2, now() AT TIME ZONE 'utc')
    ON CONFLICT (version) DO NOTHING;
`;

function migrationHash(id: string): string {
    return createHash("sha256").update(id, "utf8").digest("hex");
}

if (migrationHash("0001_init") !== "80d448607e02943553d30e6a2c6d4a83577f3ce023dce3651fe886a405b75d3d") throw new Error("migration hash does not match yoyo");

type MigrationFile = { id: string; rollback: boolean };

async function listFiles(): Promise<MigrationFile[]> {
    const entries = await readdir(MIGRATIONS_DIR);
    return entries
        .filter((name) => name.endsWith(".sql"))
        .map((name) => ({ id: name.slice(0, -".sql".length), rollback: name.endsWith(".rollback.sql") }))
        .sort((left, right) => (left.id < right.id ? -1 : 1));
}

async function bodyOf(id: string): Promise<string> {
    return await readFile(join(MIGRATIONS_DIR, `${id}.sql`), "utf8");
}

async function appliedIds(db: Sql): Promise<string[]> {
    const rows = await db<{ migration_id: string }[]>`SELECT migration_id FROM _yoyo_migration ORDER BY applied_at_utc, migration_id`;
    return rows.map((row) => row.migration_id);
}

async function runFile(db: Sql, id: string, sql: string): Promise<void> {
    await db.begin(async (tx) => {
        await tx.unsafe(sql);
        await tx`INSERT INTO _yoyo_migration (migration_hash, migration_id, applied_at_utc) VALUES (${migrationHash(id)}, ${id}, now() AT TIME ZONE 'utc')`;
    });
}

async function main(mode: string): Promise<void> {
    if (config.databaseUrl === "") throw new Error("DATABASE_URL is required");
    const files = await listFiles();
    const forward = files.filter((file) => !file.rollback);
    const db = postgres(config.databaseUrl, { max: 1, onnotice: () => {} });
    try {
        await db.unsafe(INTERNAL_SCHEMA);
        const applied = await appliedIds(db);
        const known = new Set(applied);

        if (mode === "status") {
            const pending = forward.filter((file) => !known.has(file.id));
            console.log(`applied ${applied.length}:`);
            for (const id of applied) console.log(`  ${id}`);
            console.log(`pending ${pending.length}:`);
            for (const file of pending) console.log(`  ${file.id}`);
            return;
        }

        if (mode === "apply") {
            const pending = forward.filter((file) => !known.has(file.id));
            for (const file of pending) {
                await runFile(db, file.id, await bodyOf(file.id));
                console.log(`applied ${file.id}`);
            }
            console.log(`applied ${pending.length}, pending 0`);
            return;
        }

        if (mode === "rollback") {
            const target = applied.at(-1);
            if (target === undefined) throw new Error("nothing to roll back");
            const rollback = files.find((file) => file.rollback && file.id === `${target}.rollback`);
            if (rollback === undefined) throw new Error(`no rollback file for ${target}`);
            await db.begin(async (tx) => {
                await tx.unsafe(await bodyOf(rollback.id));
                await tx`DELETE FROM _yoyo_migration WHERE migration_hash = ${migrationHash(target)}`;
            });
            console.log(`rolled back ${target}`);
            return;
        }

        throw new Error(`unknown mode ${mode}; use status, apply or rollback`);
    } finally {
        await db.end();
    }
}

try {
    await main(process.argv[2] ?? "status");
} catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
}
