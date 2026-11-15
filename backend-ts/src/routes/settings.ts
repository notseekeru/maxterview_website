import { Hono, type Context } from "hono";
import { getCurrentUser } from "../auth.ts";
import * as billing from "../billing.ts";
import * as byok from "../byok.ts";
import { config } from "../env.ts";
import { HttpError, jsonBody as jsonBodyText, validationError } from "../errors.ts";
import { LLMProviderUpdate } from "../models.ts";
import * as paymongo from "../paymongo.ts";

export const settings = new Hono();

// FastAPI validates the `event: dict` body before the handler runs, so the 404 guard sits after this.
async function eventBody(c: Context): Promise<Record<string, unknown>> {
    const body = jsonBodyText(await c.req.text());
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        throw new HttpError(422, [{ loc: ["body"], msg: "Input should be a valid dictionary" }]);
    }
    return body as Record<string, unknown>;
}

settings.get("/billing/usage", async (c) => {
    const user = await getCurrentUser(c);
    const state = await billing.usageState(user);
    const tier = billing.tierFrom(user, state.premium_until !== null);
    const byokEnabled = state.byok && byok.enabled();
    const chat = billing.chatTurnLimit(tier, byokEnabled);
    const used = state.turns;
    return c.json({
        tier,
        [`chat_turns_per_day_${tier}`]: chat,
        chat_turns_used_today: used,
        chat_turns_remaining_today: Math.max(0, chat - used),
        byok: byokEnabled,
        resume_limit: billing.resumeLimit(tier),
        billing_mode: config.billingMode,
        premium_until: tier === "premium" ? state.premium_until : null,
    });
});

// PayMongo signs the bytes it sent. The raw bytes go to verifySignature before anything decodes them:
// a decode and re-encode replaces invalid UTF-8, a parse and re-serialise reorders keys and drops
// whitespace, and every real event then fails as 401.
// Nothing upstream reads the body, so this is the first consumer of the stream.
settings.post("/billing/webhook", async (c) => {
    const raw = new Uint8Array(await c.req.arrayBuffer());
    if (!paymongo.verifySignature(raw, c.req.header("paymongo-signature") ?? "")) {
        throw new HttpError(400, "Invalid signature");
    }
    await paymongo.handleWebhookEvent(JSON.parse(new TextDecoder().decode(raw)));
    return c.text("ok");
});

// No PayMongo equivalent of `stripe listen`, so this skips the signature and feeds the same handler.
// Guarded like the no-Clerk fallback: unreachable with APP_ENV=production.
settings.post("/billing/webhook/simulate", async (c) => {
    const event = await eventBody(c);
    if (config.appEnv !== "development" && config.appEnv !== "test") throw new HttpError(404, "Not Found");
    await paymongo.handleWebhookEvent(event);
    return c.text("ok");
});

settings.post("/billing/checkout", async (c) => {
    const user = await getCurrentUser(c);
    return c.json(await paymongo.startCheckout(user));
});

settings.post("/billing/cancel", async (c) => {
    const user = await getCurrentUser(c);
    await paymongo.cancelRenewal(user);
    return c.json({ ok: true });
});

// publicView carries key_hint (the last four characters); the key itself never leaves byok.ts.
settings.get("/settings/llm", async (c) => {
    const user = await getCurrentUser(c);
    return c.json(await byok.publicView(user));
});

// byok.save raises the 503 DISABLED_DETAIL when no BYOK_ENCRYPTION_KEY is set; reads stay unguarded so
// the client can render `enabled: false` instead of an error.
settings.put("/settings/llm", async (c) => {
    const user = await getCurrentUser(c);
    const parsed = LLMProviderUpdate.safeParse(jsonBodyText(await c.req.text()));
    if (!parsed.success) throw validationError(parsed.error, "body");
    await byok.save(user.sub, parsed.data.base_url, parsed.data.model, parsed.data.api_key);
    return c.json(await byok.publicView(user));
});

settings.delete("/settings/llm", async (c) => {
    const user = await getCurrentUser(c);
    await byok.clear(user.sub);
    return c.body(null, 204);
});

settings.post("/settings/llm/test", async (c) => {
    const user = await getCurrentUser(c);
    return c.json(await byok.test(user));
});
