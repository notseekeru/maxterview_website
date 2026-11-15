import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import postgres from "postgres";
import { afterAll } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
// conftest.py's `setdefault`: a host with no DSN still runs the unit-only tests. The first file to run
// pins the parent DSN, because every later file sees its own DATABASE_URL.
const BASE_DSN = process.env.MXT_BASE_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgresql://x:x@localhost:5432/x";
process.env.MXT_BASE_DATABASE_URL = BASE_DSN;
const TEST_DB = `maxterview_test_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
const TEST_DSN = `${BASE_DSN.slice(0, BASE_DSN.lastIndexOf("/") + 1)}${TEST_DB}`;

// One database per test FILE: files run in parallel, and a count assertion ("the dashboard is empty for
// this owner") cannot survive another file's rows. Serialising instead would just queue the collision.
async function admin(create: boolean): Promise<boolean> {
    const db = postgres(BASE_DSN, { max: 1, onnotice: () => {} });
    try {
        if (create) {
            await db.unsafe(`CREATE DATABASE "${TEST_DB}"`);
        } else {
            await db`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${TEST_DB} AND pid <> pg_backend_pid()`;
            await db.unsafe(`DROP DATABASE IF EXISTS "${TEST_DB}"`);
        }
        return true;
    } catch {
        // Unreachable Postgres, or a placeholder DSN: leave the caller's DATABASE_URL alone, as conftest does.
        return false;
    } finally {
        await db.end({ timeout: 1 });
    }
}

const created = await admin(true);
// Registered before the migrate call: a hook registered after a throwing setup file never runs.
afterAll(async () => {
    if (!created) return;
    const { closePool } = await import("../../src/db.ts");
    await closePool();
    await admin(false);
});
if (created) {
    try {
        execFileSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "scripts", "migrate.ts"), "apply", "--database", TEST_DSN], {
            env: { ...process.env, DATABASE_URL: TEST_DSN, APP_ENV: "test" },
            stdio: ["ignore", "pipe", "pipe"],
        });
    } catch (error) {
        // A setup file that throws keeps no afterAll, so the drop has to happen here as well.
        await admin(false);
        throw error;
    }
}
process.env.DATABASE_URL = created ? TEST_DSN : BASE_DSN;
