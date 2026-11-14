import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { config } from "./env.ts";
import { HttpError } from "./errors.ts";
import { log, requestContext } from "./logs.ts";
import { rateLimit } from "./ratelimit.ts";
import { chat } from "./routes/chat.ts";
import { interviews } from "./routes/interviews.ts";
import { resumes } from "./routes/resumes.ts";
import { settings } from "./routes/settings.ts";
import { templates } from "./routes/templates.ts";
import { voice } from "./routes/voice.ts";

const CLIENT_ERROR_MAX_BYTES = 4096;

const ClientError = z.object({
    message: z.string().min(1).max(300),
    route: z.string().max(200).default(""),
    component_stack: z.string().max(1000).default(""),
});

export const app = new Hono().basePath("/api");

app.use("*", requestContext);
if (config.corsAllowOrigins.length > 0) {
    app.use("*", cors({ origin: config.corsAllowOrigins, credentials: true, allowMethods: ["*"], allowHeaders: ["*"] }));
}
app.use("*", rateLimit);

app.notFound((c) => c.json({ detail: "Not Found" }, 404));

app.onError((err, c) => {
    if (err instanceof HttpError) {
        return c.json({ detail: err.detail }, err.status);
    }
    return c.text("Internal Server Error", 500);
});

app.get("/health", (c) => c.json({ status: "ok", up: 1 }));

app.post("/client-errors", async (c) => {
    const declared = c.req.header("content-length") ?? "";
    if (/^\d+$/.test(declared) && Number.parseInt(declared, 10) > CLIENT_ERROR_MAX_BYTES) {
        throw new HttpError(413, "Not a browser error report");
    }

    let body: unknown;
    try {
        body = JSON.parse(await c.req.text());
    } catch {
        throw new HttpError(422, "Not a browser error report");
    }

    const report = ClientError.safeParse(body);
    if (!report.success) {
        throw new HttpError(422, "Not a browser error report");
    }

    log.info("browser.error", { message: report.data.message, route: report.data.route, component_stack: report.data.component_stack });
    return c.body(null, 204);
});

app.route("/", interviews);
app.route("/", chat);
app.route("/", templates);
app.route("/", resumes);
app.route("/", voice);
app.route("/", settings);
