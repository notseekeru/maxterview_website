import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { config } from "./env.ts";
import { HttpError } from "./errors.ts";
import { log, requestContext } from "./observability.ts";
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

// Starlette's router, not the handler, answers a known path with the wrong verb: 405 plus every
// declared method in Allow. Hono has no such path, so the registered routes are matched by hand.
function allowedMethods(path: string): string[] {
    const actual = path.split("/");
    const methods = new Set<string>();
    for (const route of app.routes) {
        if (route.method === "ALL") continue;
        const declared = route.path.split("/");
        if (declared.length !== actual.length || !declared.every((part, index) => part.startsWith(":") || part === actual[index])) continue;
        methods.add(route.method);
    }
    if (methods.has("GET")) methods.add("HEAD");
    return [...methods].sort();
}

app.use("*", requestContext);
if (config.corsAllowOrigins.length > 0) {
    // Hono's preflight is a bare 204; the browser sees the status, and Starlette's is 200 "OK".
    app.use("*", async (c, next) => {
        await next();
        if (c.req.method === "OPTIONS" && c.res.status === 204) c.res = new Response("OK", { status: 200, headers: c.res.headers });
    });
    app.use("*", cors({ origin: config.corsAllowOrigins, credentials: true, allowMethods: ["*"], allowHeaders: ["*"] }));
}
app.use("*", rateLimit);

app.notFound((c) => {
    const allow = allowedMethods(c.req.path);
    if (allow.length === 0) return c.json({ detail: "Not Found" }, 404);
    return c.json({ detail: "Method Not Allowed" }, 405, { Allow: allow.join(", ") });
});

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
