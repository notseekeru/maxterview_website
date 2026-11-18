import { serve } from "@hono/node-server";
import { app } from "./app.ts";
import { closePool, initPool } from "./db.ts";
import { config } from "./env.ts";
import * as telemetry from "./observability.ts";

if (!config.clerkEnabled && config.appEnv !== "development" && config.appEnv !== "test") {
    throw new Error("CLERK_ENABLED=false is only allowed when APP_ENV is development or test; refusing to boot.");
}

telemetry.configure();
const beat = telemetry.enabled() ? telemetry.heartbeat() : null;
initPool();

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
    if (config.appEnv !== "production") console.log(`listening on http://localhost:${info.port}`);
});

async function shutdown(): Promise<void> {
    if (beat !== null) clearInterval(beat);
    await closePool();
    await telemetry.shutdown();
    server.close(() => process.exit(0));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown());
}
