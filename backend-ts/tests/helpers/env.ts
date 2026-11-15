// Listed in vitest.config.ts `setupFiles` after tests/helpers/db.ts, which owns the DSN. Together they are the
// only place that runs before a test file's src/ imports. Values are conftest.py's, verbatim.
import { afterAll } from "vitest";
const TEST_ENV = {
    APP_ENV: "test",
    CLERK_ENABLED: "false",
    CLERK_DOMAIN: "https://test.clerk.accounts",
    CLERK_JWKS_URL: "",
    LLM_BASE_URL: "",
    LLM_MODEL: "",
    LLM_API_KEY: "",
    LLM_PRO_BASE_URL: "",
    LLM_PRO_MODEL: "",
    LLM_PRO_API_KEY: "",
    RATE_LIMIT: "off",
};

for (const [key, value] of Object.entries(TEST_ENV)) process.env[key] = value;
process.env.DATABASE_URL ??= "postgresql://x:x@localhost:5432/x";

// Loading env.ts here means the shared config is already built from the test env, whatever order the
// test file imports src/ in. It also makes the ordering itself checkable instead of assumed.
const { config } = await import("../../src/env.ts");

if (config.appEnv !== TEST_ENV.APP_ENV || config.rateLimit !== TEST_ENV.RATE_LIMIT || config.databaseUrl !== process.env.DATABASE_URL) {
    throw new Error(
        `src/env.ts was read before the test env was set (appEnv=${config.appEnv}). tests/helpers/db.ts and env.ts must stay in vitest.config.ts ` +
            "`setupFiles`: move the import out of another setup entry, or out of a globalSetup.",
    );
}

// initPool() is otherwise only reachable from main.ts, which the tests never load; FastAPI's TestClient
// ran the lifespan that did the same job.
const { closePool, initPool } = await import("../../src/db.ts");
initPool();
afterAll(async () => {
    await closePool();
});
