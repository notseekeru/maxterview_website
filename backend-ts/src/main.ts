import { serve } from "@hono/node-server";
import { app } from "./app.ts";
import { config } from "./env.ts";

serve({ fetch: app.fetch, port: config.port }, (info) => {
    if (config.appEnv !== "production") console.log(`listening on http://localhost:${info.port}`);
});
