import { createHmac } from "node:crypto";
import postgres from "postgres";
import { beforeEach, describe, expect, it } from "vitest";
import { chatTurnLimit, resolveTier, utcDay } from "../src/billing.ts";
import { fetchrow, sql } from "../src/db.ts";
import { config } from "../src/env.ts";
import { HttpError } from "../src/errors.ts";
import { ClerkUser } from "../src/models.ts";
import { cancelRenewal, handleWebhookEvent, startCheckout, startSubscription, verifySignature } from "../src/paymongo.ts";
import { withConfig } from "./helpers/config.ts";
import { type Call, type HttpStub, json, stubHttp } from "./helpers/http.ts";

const API = "https://api.paymongo.com";
const PAY_URL = "https://paymaya.test/x";
const QR_IMAGE = "data:image/png;base64,AAAA";
const DAY_MS = 86_400_000;

const OWNER = "t2-owner";
const BUYER = ClerkUser.parse({ sub: OWNER, email: "a@b.co", name: "A B" });
const PERIOD = { paymongoSecretKey: "sk_test_x", paymongoPlanId: "", billingMode: "period" };
const SUBSCRIPTION = { paymongoSecretKey: "sk_test_x", paymongoPlanId: "plan_x", billingMode: "subscription" };

type SubRow = {
    owner_id?: string;
    provider?: string;
    provider_customer_id?: string;
    provider_subscription_id?: string;
    provider_plan_id?: string;
    plan?: string;
    status?: string;
    current_period_end?: Date | null;
    updated_at?: Date;
};

type Row = Record<string, unknown> | undefined;

async function parked(db: ReturnType<typeof postgres>): Promise<boolean> {
    const rows = await db.unsafe("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%UPDATE subscriptions%'");
    return Number((rows[0] as unknown as { n: number }).n) > 0;
}

function inDays(days: number): Date {
    return new Date(Date.now() + days * DAY_MS);
}

function iso(value: unknown): string | null {
    return value === null || value === undefined ? null : new Date(String(value)).toISOString();
}

function endMs(row: Row): number {
    return new Date(String(row?.current_period_end)).getTime();
}

async function seedRow(row: SubRow = {}): Promise<void> {
    const full = { owner_id: OWNER, provider: "paymongo", provider_customer_id: "", provider_subscription_id: "", provider_plan_id: "", plan: "free", status: "active", current_period_end: null, updated_at: new Date(), ...row };
    await fetchrow(sql`
        INSERT INTO subscriptions (owner_id, provider, provider_customer_id, provider_subscription_id, provider_plan_id, plan, status, current_period_end, updated_at)
        VALUES (${full.owner_id}, ${full.provider}, ${full.provider_customer_id}, ${full.provider_subscription_id}, ${full.provider_plan_id}, ${full.plan}, ${full.status}, ${full.current_period_end}, ${full.updated_at})
        ON CONFLICT (owner_id) DO UPDATE SET provider = EXCLUDED.provider, provider_customer_id = EXCLUDED.provider_customer_id,
            provider_subscription_id = EXCLUDED.provider_subscription_id, provider_plan_id = EXCLUDED.provider_plan_id,
            plan = EXCLUDED.plan, status = EXCLUDED.status, current_period_end = EXCLUDED.current_period_end, updated_at = EXCLUDED.updated_at
        `);
}

async function rowFor(owner = OWNER): Promise<Row> {
    return await fetchrow(sql`SELECT provider, provider_customer_id, provider_subscription_id, provider_plan_id, plan, status, current_period_end, updated_at FROM subscriptions WHERE owner_id = ${owner}`);
}

async function countRows(): Promise<number> {
    const row = await fetchrow(sql`SELECT count(*)::int AS n FROM subscriptions WHERE owner_id LIKE ${`${OWNER}%`}`);
    return Number(row?.n ?? 0);
}

async function clearRows(): Promise<void> {
    await fetchrow(sql`DELETE FROM subscriptions WHERE owner_id LIKE ${`${OWNER}%`}`);
}

async function failure(call: () => Promise<unknown>): Promise<{ status: number; detail: unknown }> {
    try {
        await call();
    } catch (error) {
        if (error instanceof HttpError) return { status: error.status, detail: error.detail };
        throw error;
    }
    throw new Error("expected the call to be rejected");
}

function providerUrl(path: string, params: Record<string, string | number> = {}): string {
    const url = new URL(`${API}${path}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return url.href;
}

function paths(stub: HttpStub): string[] {
    return stub.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`);
}

function parse(call: Call): Record<string, never> {
    return JSON.parse(call.body) as Record<string, never>;
}

function subscriptionEvent(etype: string, options: { status?: string; attrs?: Record<string, unknown>; legacy?: boolean } = {}): Record<string, unknown> {
    const body = {
        type: etype,
        livemode: false,
        data: {
            id: "subs_123",
            type: "subscription",
            attributes: { id: "subs_123", customer_id: "cus_123", plan_id: "plan_123", status: options.status ?? "active", next_billing_schedule: "2026-10-14", ...(options.attrs ?? {}) },
        },
    };
    return { data: options.legacy === true ? { attributes: body } : body };
}

function invoiceEvent(etype: string, options: { status?: string } = {}): Record<string, unknown> {
    const resource = { id: "inv_123", type: "invoice", attributes: { id: "inv_123", amount: 9900, currency: "PHP", resource_id: "subs_123", status: options.status ?? "paid", due_date: "2026-09-14" } };
    return { data: { type: etype, livemode: false, data: resource } };
}

function paymentEvent(options: { etype?: string; intentId?: string } = {}): Record<string, unknown> {
    const etype = options.etype ?? "payment.paid";
    const intentId = options.intentId ?? "pi_1";
    const resource = etype.startsWith("payment_intent") ? { id: intentId, type: "payment_intent", attributes: { id: intentId, amount: 9900, status: "succeeded" } } : { id: "pay_1", type: "payment", attributes: { id: "pay_1", amount: 9900, status: "paid", payment_intent_id: intentId } };
    return { data: { type: etype, livemode: false, data: resource } };
}

function refundedPaymentEvent(intentId = "pi_1"): Record<string, unknown> {
    const resource = { id: "pay_1", type: "payment", attributes: { id: "pay_1", status: "refunded", payment_intent_id: intentId } };
    return { data: { type: "payment.refunded", livemode: false, data: resource } };
}

function refundResourceEvent(etype = "payment.refunded", attrs: Record<string, unknown> = {}): Record<string, unknown> {
    const resource = { id: "ref_1", type: "refund", attributes: { id: "ref_1", ...attrs } };
    return { data: { type: etype, livemode: false, data: resource } };
}

function stubRedirectFlow(stub: HttpStub, intentId: string, expiresAt?: string): string {
    const attachUrl = providerUrl(`/v1/payment_intents/${intentId}/attach`);
    stub.post(providerUrl("/v1/customers"), () => json({ data: { id: "cus_1" } }));
    stub.post(providerUrl("/v1/payment_intents"), () => json({ data: { id: intentId } }));
    stub.post(providerUrl("/v1/payment_methods"), () => json({ data: { id: "pm_1" } }));
    stub.on("GET", providerUrl(`/v1/payment_intents/${intentId}`), () => json({ data: { attributes: { client_key: `${intentId}_client`, status: "awaiting_next_action", next_action: { code: { image_url: QR_IMAGE, expires_at: expiresAt } } } } }));
    stub.post(attachUrl, () => json({ data: { attributes: { next_action: { redirect: { url: PAY_URL } } } } }));
    return attachUrl;
}

function stubSubscriptionFlow(stub: HttpStub, subscriptionId: string, intentId: string): void {
    const params = { resource_id: subscriptionId, limit: 1, order: "desc" };
    stub.post(providerUrl("/v1/customers"), () => json({ data: { id: "cus_1" } }));
    stub.post(providerUrl("/v1/subscriptions"), () => json({ data: { id: subscriptionId } }));
    stub.on("GET", providerUrl("/v1/subscriptions/invoices", params), () => json({ data: [{ attributes: { payment_intent: { id: intentId } } }] }));
    stub.post(providerUrl("/v1/payment_methods"), () => json({ data: { id: "pm_1" } }));
    stub.on("GET", providerUrl(`/v1/payment_intents/${intentId}`), () => json({ data: { attributes: { client_key: `${intentId}_client` } } }));
    stub.post(providerUrl(`/v1/payment_intents/${intentId}/attach`), () => json({ data: { attributes: { next_action: { redirect: { url: PAY_URL } } } } }));
}

const SECRET = "whsec_test";
const SIGNED_BODY = Buffer.from('{"data":{"type":"subscription.activated"}}');

function sign(body: Buffer, options: { stamp?: number; key?: string; secret?: string } = {}): string {
    const stamp = options.stamp ?? Math.floor(Date.now() / 1000);
    const mac = createHmac("sha256", options.secret ?? SECRET)
        .update(`${stamp}.`)
        .update(body)
        .digest("hex");
    return `t=${stamp},${options.key ?? "te"}=${mac}`;
}

beforeEach(clearRows);

describe("billing dials", () => {
    it("serves the default daily caps", () => {
        expect([chatTurnLimit("free"), chatTurnLimit("premium"), chatTurnLimit("dev")]).toEqual([30, 300, 100_000_000]);
        expect(chatTurnLimit("free")).toBe(config.freeChatTurns);
    });

    it("swaps the byok ceiling in for the tier cap", () => {
        expect(chatTurnLimit("free")).toBe(config.freeChatTurns);
        expect(chatTurnLimit("free", true)).toBe(config.byokChatTurns);
        expect(chatTurnLimit("premium", true)).toBe(config.byokPremiumChatTurns);
        expect(chatTurnLimit("dev", true)).toBe(config.byokPremiumChatTurns);
        expect(config.byokChatTurns).toBeGreaterThan(config.premiumChatTurns);
        expect(config.byokPremiumChatTurns).toBeGreaterThan(config.byokChatTurns);
    });

    it("falls back to dev when clerk is off", async () => {
        await withConfig({ clerkEnabled: false }, async () => {
            expect(await resolveTier(ClerkUser.parse({ sub: `${OWNER}-dev`, tier: "free" }))).toBe("dev");
        });
    });

    it("elevates a stored premium subscription", async () => {
        await seedRow({ owner_id: `${OWNER}-elevated`, plan: "premium", status: "active", current_period_end: inDays(7) });
        await withConfig({ clerkEnabled: true }, async () => {
            expect(await resolveTier(ClerkUser.parse({ sub: `${OWNER}-elevated`, tier: "free" }))).toBe("premium");
        });
    });

    it("stays free without a subscription", async () => {
        await withConfig({ clerkEnabled: true }, async () => {
            expect(await resolveTier(ClerkUser.parse({ sub: `${OWNER}-plain`, tier: "free" }))).toBe("free");
        });
    });

    it("reads the utc day as the calendar day", () => {
        expect(utcDay()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(utcDay()).toBe(new Date().toISOString().slice(0, 10));
    });

    it("keeps a jwt premium claim when nothing is stored", async () => {
        await withConfig({ clerkEnabled: true }, async () => {
            expect(await resolveTier(ClerkUser.parse({ sub: `${OWNER}-p`, tier: "premium" }))).toBe("premium");
        });
    });
});

describe("subscription webhooks", () => {
    it("upserts a premium row when a subscription activates", async () => {
        await seedRow({ provider_customer_id: "cus_123", provider_subscription_id: "subs_123" });
        await handleWebhookEvent(subscriptionEvent("subscription.activated"));
        const row = await rowFor();
        expect(row).toMatchObject({ provider: "paymongo", provider_customer_id: "cus_123", provider_subscription_id: "subs_123", provider_plan_id: "plan_123", plan: "premium", status: "active" });
        expect(iso(row?.current_period_end)).toBe("2026-10-14T00:00:00.000Z");
    });

    it("upserts through the legacy envelope too", async () => {
        await seedRow({ provider_customer_id: "cus_123", provider_subscription_id: "subs_123" });
        await handleWebhookEvent(subscriptionEvent("subscription.updated", { legacy: true }));
        expect(await rowFor()).toMatchObject({ provider_subscription_id: "subs_123", plan: "premium", status: "active" });
    });

    it("keeps the plan but loses the entitlement when past due", async () => {
        await seedRow({ provider_customer_id: "cus_123", provider_subscription_id: "subs_123", plan: "premium", status: "active", current_period_end: inDays(9) });
        await handleWebhookEvent(subscriptionEvent("subscription.past_due", { status: "past_due", attrs: { next_billing_schedule: inDays(9).toISOString() } }));
        expect(await rowFor()).toMatchObject({ plan: "premium", status: "past_due" });
        await withConfig({ clerkEnabled: true }, async () => {
            const payer = ClerkUser.parse({ sub: OWNER, tier: "free" });
            expect(await resolveTier(payer)).toBe("free");
            await handleWebhookEvent(subscriptionEvent("subscription.updated", { status: "active", attrs: { next_billing_schedule: inDays(9).toISOString() } }));
            expect(await resolveTier(payer)).toBe("premium");
        });
    });

    it("drops to the free plan when cancelled", async () => {
        await seedRow({ provider_customer_id: "cus_123", provider_subscription_id: "subs_123", plan: "premium", status: "active", current_period_end: inDays(9) });
        await handleWebhookEvent(subscriptionEvent("subscription.updated", { status: "cancelled", attrs: { next_billing_schedule: inDays(9).toISOString() } }));
        expect(await rowFor()).toMatchObject({ plan: "free", status: "cancelled" });
    });

    it("ignores an event for a subscription it never issued", async () => {
        await handleWebhookEvent(subscriptionEvent("subscription.activated"));
        expect(await countRows()).toBe(0);
    });
});

describe("resubscribe gate", () => {
    it("allows a purchase when nothing is stored", async () => {
        const stub = stubHttp();
        stubRedirectFlow(stub, "pi_new");
        await withConfig(PERIOD, async () => {
            expect(await startCheckout(BUYER)).toEqual({ url: PAY_URL });
        });
    });

    it("blocks a second purchase inside a paid period", async () => {
        const stub = stubHttp();
        stubRedirectFlow(stub, "pi_new");
        await withConfig(PERIOD, async () => {
            for (const status of ["active", "past_due", "unpaid", "cancelled"]) {
                await seedRow({ plan: "premium", status, current_period_end: inDays(10) });
                const blocked = await failure(() => startCheckout(BUYER));
                expect(blocked.status).toBe(409);
                expect(String(blocked.detail)).toContain("already covers");
            }
        });
        expect(stub.calls).toEqual([]);
    });

    it("allows the purchase once the period lapsed", async () => {
        const stub = stubHttp();
        stubRedirectFlow(stub, "pi_new");
        await withConfig(PERIOD, async () => {
            await seedRow({ plan: "premium", status: "cancelled", current_period_end: inDays(-11) });
            expect(await startCheckout(BUYER)).toEqual({ url: PAY_URL });
            await seedRow({ plan: "free", status: "cancelled", current_period_end: null });
            expect(await startCheckout(BUYER)).toEqual({ url: PAY_URL });
        });
    });

    it("blocks a second subscription while the first payment is pending", async () => {
        const stub = stubHttp();
        stubSubscriptionFlow(stub, "subs_new", "pi_new");
        await withConfig(SUBSCRIPTION, async () => {
            await seedRow({ plan: "free", status: "incomplete", current_period_end: null, updated_at: new Date() });
            const pending = await failure(() => startSubscription(BUYER));
            expect(pending.status).toBe(409);
            expect(String(pending.detail)).toContain("already pending");

            await seedRow({ plan: "free", status: "incomplete", current_period_end: null, updated_at: new Date(Date.now() - 30 * 3600_000) });
            expect(await startSubscription(BUYER)).toBe(PAY_URL);
        });
    });
});

describe("pending payment intents", () => {
    it("resumes a payable code instead of refusing", async () => {
        const stub = stubHttp();
        const expiresAt = new Date(Date.now() + 20 * 60_000).toISOString();
        stub.on("GET", providerUrl("/v1/payment_intents/pi_x"), () => json({ data: { attributes: { status: "awaiting_next_action", next_action: { type: "consume_qr", code: { image_url: QR_IMAGE, expires_at: expiresAt } } } } }));
        await seedRow({ plan: "premium", status: "incomplete", current_period_end: null, provider_subscription_id: "pi_x" });
        await withConfig(PERIOD, async () => {
            expect(await startCheckout(BUYER)).toEqual({ qr: { image_url: QR_IMAGE, expires_at: expiresAt } });
        });
        expect(paths(stub)).toEqual(["GET /v1/payment_intents/pi_x"]);
    });

    it("judges the pending code by its own deadline", async () => {
        const stub = stubHttp();
        const intent = providerUrl("/v1/payment_intents/pi_x");
        const awaiting = (minutes: number, extra: Record<string, unknown>): Record<string, unknown> => ({
            data: { attributes: { status: "awaiting_next_action", next_action: { code: { expires_at: new Date(Date.now() + minutes * 60_000).toISOString(), ...extra } } } },
        });
        stub.on("GET", intent, [
            () => json(awaiting(12, {})),
            () => json(awaiting(-1, { image_url: QR_IMAGE })),
            () => json({ data: { attributes: { status: "processing", next_action: { code: { expires_at: new Date(Date.now() + 10 * 60_000).toISOString() } } } } }),
            () => json({ data: { attributes: { status: "awaiting_next_action", next_action: { code: {} } } } }),
            () => json({ data: { attributes: { status: "awaiting_next_action", next_action: { code: {} } } } }),
            () => json({ data: { attributes: { status: "succeeded" } } }),
        ]);
        stub.post(providerUrl("/v1/customers"), () => json({ data: { id: "cus_1" } }));
        stub.post(providerUrl("/v1/payment_intents"), () => json({ data: { id: "pi_new" } }));
        stub.post(providerUrl("/v1/payment_methods"), () => json({ data: { id: "pm_1" } }));
        stub.on("GET", providerUrl("/v1/payment_intents/pi_new"), () => json({ data: { attributes: { client_key: "pi_new_client" } } }));
        stub.post(providerUrl("/v1/payment_intents/pi_new/attach"), () => json({ data: { attributes: { next_action: { redirect: { url: PAY_URL } } } } }));
        const pendingRow = (updatedAt: Date): SubRow => ({ plan: "premium", status: "incomplete", current_period_end: null, provider_subscription_id: "pi_x", updated_at: updatedAt });

        await withConfig(PERIOD, async () => {
            await seedRow(pendingRow(new Date()));
            const reShow = await failure(() => startCheckout(BUYER));
            expect(reShow.status).toBe(409);
            expect(String(reShow.detail)).toContain("min left");

            await seedRow(pendingRow(new Date()));
            expect(await startCheckout(BUYER)).toEqual({ url: PAY_URL });

            await seedRow(pendingRow(new Date()));
            expect(String((await failure(() => startCheckout(BUYER))).detail)).toContain("processed");

            await seedRow(pendingRow(new Date()));
            expect(String((await failure(() => startCheckout(BUYER))).detail)).toContain("min left");

            await seedRow(pendingRow(new Date(Date.now() - 2 * 3600_000)));
            expect(await startCheckout(BUYER)).toEqual({ url: PAY_URL });

            await seedRow(pendingRow(new Date()));
            const before = Date.now();
            const paid = await failure(() => startCheckout(BUYER));
            expect(paid.status).toBe(409);
            expect(String(paid.detail)).toContain("already received");
            const row = await rowFor();
            expect(row).toMatchObject({ plan: "premium", status: "active" });
            const days = (endMs(row) - before) / DAY_MS;
            expect(days).toBeGreaterThanOrEqual(config.premiumPeriodDays);
            expect(days).toBeLessThan(config.premiumPeriodDays + 0.01);
        });
    });
});

describe("invoice webhooks", () => {
    it("recovers a subscription from an invoice paid on its subscription id", async () => {
        await seedRow({ provider_subscription_id: "subs_123", plan: "premium", status: "past_due" });
        await handleWebhookEvent(invoiceEvent("subscription.invoice.paid"));
        expect(await rowFor()).toMatchObject({ plan: "premium", status: "active" });

        await seedRow({ provider_subscription_id: "subs_123", plan: "premium", status: "cancelled" });
        await handleWebhookEvent(invoiceEvent("subscription.invoice.paid"));
        expect(await rowFor()).toMatchObject({ status: "cancelled" });
    });

    it("marks the row past due when the invoice payment fails", async () => {
        await seedRow({ provider_subscription_id: "subs_123", plan: "premium", status: "active", current_period_end: inDays(9) });
        await handleWebhookEvent(invoiceEvent("subscription.invoice.payment_failed", { status: "open" }));
        expect(await rowFor()).toMatchObject({ status: "past_due" });
    });

    it("writes nothing for draft invoice churn", async () => {
        await seedRow({ provider_subscription_id: "subs_123", plan: "premium", status: "active", updated_at: new Date(Date.now() - 3600_000) });
        const before = await rowFor();
        for (const etype of ["subscription.invoice.created", "subscription.invoice.finalized", "subscription.invoice.updated"]) {
            await handleWebhookEvent(invoiceEvent(etype, { status: "draft" }));
        }
        expect(await rowFor()).toEqual(before);
    });

    it("ignores an event type it does not handle", async () => {
        const stub = stubHttp();
        await handleWebhookEvent({ data: { type: "payout.deposited", livemode: false, data: { id: "po_1", type: "payout", attributes: {} } } });
        expect(stub.calls).toEqual([]);
        expect(await countRows()).toBe(0);
    });
});

describe("customer reuse", () => {
    it("reuses only a customer this provider issued", async () => {
        const stale = stubHttp();
        stubRedirectFlow(stale, "pi_1");
        await seedRow({ provider: "stripe", provider_customer_id: "cus_from_stripe" });
        await withConfig(PERIOD, async () => {
            expect(await startCheckout(BUYER)).toEqual({ url: PAY_URL });
        });
        expect(paths(stale)).toContain("POST /v1/customers");
        expect((await rowFor())?.provider_customer_id).toBe("cus_1");

        const mine = stubHttp();
        stubRedirectFlow(mine, "pi_2");
        await seedRow({ provider: "paymongo", provider_customer_id: "cus_pm" });
        await withConfig(PERIOD, async () => {
            expect(await startCheckout(BUYER)).toEqual({ url: PAY_URL });
        });
        expect(paths(mine)).not.toContain("POST /v1/customers");
        expect((await rowFor())?.provider_customer_id).toBe("cus_pm");
    });

    it("reuses the customer paymongo holds when the create conflicts", async () => {
        const email = "payer@example.com";
        const listUrl = providerUrl("/v1/customers", { email, limit: 100 });
        const payer = ClerkUser.parse({ sub: OWNER, email, name: "A B" });

        const reused = stubHttp();
        reused.post(providerUrl("/v1/customers"), () => json({ detail: "conflict" }, 409));
        reused.on("GET", listUrl, () => json({ data: [{ id: "cus_old", attributes: { email } }] }));
        stubRedirectFlow(reused, "pi_1");
        await withConfig(PERIOD, async () => {
            expect(await startCheckout(payer)).toEqual({ url: PAY_URL });
        });
        expect(reused.calls[1]).toMatchObject({ method: "GET", url: listUrl });
        expect((await rowFor())?.provider_customer_id).toBe("cus_old");

        const dropped = stubHttp();
        dropped.post(providerUrl("/v1/customers"), () => json({ detail: "conflict" }, 409));
        dropped.on("GET", listUrl, () => json({ data: [] }));
        await withConfig(PERIOD, async () => {
            expect((await failure(() => startCheckout(ClerkUser.parse({ sub: `${OWNER}-2`, email, name: "A B" })))).status).toBe(502);
        });
    });
});

describe("payment webhooks", () => {
    it("credits the pending row on payment.paid", async () => {
        await seedRow({ plan: "premium", status: "incomplete", provider_subscription_id: "pi_1" });
        const before = Date.now();
        await handleWebhookEvent(paymentEvent());
        const row = await rowFor();
        expect(row).toMatchObject({ plan: "premium", status: "active" });
        const days = (endMs(row) - before) / DAY_MS;
        expect(days).toBeGreaterThanOrEqual(config.premiumPeriodDays);
        expect(days).toBeLessThan(config.premiumPeriodDays + 0.01);
    });

    it("credits on payment_intent.succeeded too", async () => {
        await seedRow({ plan: "premium", status: "incomplete", provider_subscription_id: "pi_2" });
        await handleWebhookEvent(paymentEvent({ etype: "payment_intent.succeeded", intentId: "pi_2" }));
        expect(await rowFor()).toMatchObject({ plan: "premium", status: "active" });
    });

    it("grants no extra time to a second delivery", async () => {
        await seedRow({ plan: "premium", status: "incomplete", provider_subscription_id: "pi_1" });
        await handleWebhookEvent(paymentEvent());
        const first = endMs(await rowFor());
        await handleWebhookEvent(paymentEvent({ etype: "payment_intent.succeeded" }));
        expect(endMs(await rowFor())).toBe(first);
    });

    it("writes nothing for a payment that cannot credit", async () => {
        await handleWebhookEvent(paymentEvent({ etype: "payment.failed" }));
        await handleWebhookEvent(paymentEvent({ intentId: "pi_from_another_key" }));
        await handleWebhookEvent({ data: { type: "payment.paid", livemode: false, data: { id: "pay_9", type: "payment", attributes: { status: "paid" } } } });
        expect(await countRows()).toBe(0);
    });

    it("leaves a row that moved on to a newer intent uncredited", async () => {
        await seedRow({ plan: "premium", status: "incomplete", provider_subscription_id: "pi_1" });
        const guard = postgres(process.env.DATABASE_URL ?? "", { max: 1, onnotice: () => {} });
        let delivery: Promise<void> | null = null;
        try {
            await guard.unsafe("BEGIN");
            await guard`SELECT id FROM subscriptions WHERE owner_id = ${OWNER} FOR UPDATE`;
            delivery = handleWebhookEvent(paymentEvent());
            // The owner lookup has returned once the UPDATE parks behind the row lock. Committing the move
            // then makes that UPDATE re-check its WHERE against pi_2: the row a checkout replaced the intent on.
            for (let waited = 0; !(await parked(guard)); waited += 1) {
                if (waited === 200) throw new Error("the webhook's UPDATE never parked behind the row lock");
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            await guard`UPDATE subscriptions SET provider_subscription_id = ${`pi_2`} WHERE owner_id = ${OWNER}`;
            await guard.unsafe("COMMIT");
        } finally {
            await guard.end({ timeout: 1 });
            await delivery?.catch(() => {});
        }
        expect(await rowFor()).toMatchObject({ provider_subscription_id: "pi_2", plan: "premium", status: "incomplete", current_period_end: null });
    });
});

describe("refund webhooks", () => {
    const paidRow: SubRow = { plan: "premium", status: "active", provider_subscription_id: "pi_1", current_period_end: inDays(10) };

    it("revokes the paid period on payment.refunded", async () => {
        await seedRow(paidRow);
        await handleWebhookEvent(refundedPaymentEvent());
        const row = await rowFor();
        expect(row).toMatchObject({ plan: "free", status: "refunded" });
        await withConfig({ clerkEnabled: true }, async () => {
            expect(await resolveTier(ClerkUser.parse({ sub: OWNER, tier: "free" }))).toBe("free");
        });
    });

    it("resolves a thin refund event through the provider", async () => {
        const stub = stubHttp();
        stub.on("GET", providerUrl("/v1/refunds/ref_1"), () => json({ data: { attributes: { status: "succeeded", payment_id: "pay_1" } } }));
        stub.on("GET", providerUrl("/v1/payments/pay_1"), () => json({ data: { attributes: { payment_intent_id: "pi_1" } } }));
        await seedRow(paidRow);
        await handleWebhookEvent(refundResourceEvent());
        expect(paths(stub)).toEqual(["GET /v1/refunds/ref_1", "GET /v1/payments/pay_1"]);
        expect(await rowFor()).toMatchObject({ plan: "free", status: "refunded" });

        await seedRow(paidRow);
        await handleWebhookEvent(refundResourceEvent("refund.succeeded", { status: "succeeded", payment_id: "pay_1" }));
        expect(paths(stub).at(-1)).toBe("GET /v1/payments/pay_1");
        expect(await rowFor()).toMatchObject({ status: "refunded" });
    });

    it("writes nothing for an unsettled refund", async () => {
        const stub = stubHttp();
        stub.on("GET", providerUrl("/v1/refunds/ref_1"), () => json({ data: { attributes: { status: "pending" } } }));
        await seedRow(paidRow);
        await handleWebhookEvent(refundResourceEvent("payment.refund.updated", { status: "pending" }));
        await handleWebhookEvent(refundResourceEvent("payment.refund.updated"));
        await handleWebhookEvent({ data: { type: "payment.refund.updated", livemode: false, data: { id: "pay_1", type: "payment", attributes: { status: "paid", payment_intent_id: "pi_1" } } } });
        expect(await rowFor()).toMatchObject({ plan: "premium", status: "active" });
    });

    it("writes nothing for a refund it cannot attribute", async () => {
        const stub = stubHttp();
        stub.on("GET", providerUrl("/v1/refunds/ref_1"), () => json({ data: { attributes: { status: "succeeded" } } }));
        stub.on("GET", providerUrl("/v1/payments/pay_unknown"), () => json({ data: { attributes: { status: "succeeded" } } }));
        await handleWebhookEvent(refundResourceEvent("payment.refunded", { status: "succeeded" }));
        await handleWebhookEvent(refundResourceEvent("payment.refunded", { status: "succeeded", payment_id: "pay_unknown" }));
        expect(await countRows()).toBe(0);

        const down = stubHttp();
        down.on("GET", providerUrl("/v1/refunds/ref_1"), () => json({ detail: "Payment provider error" }, 502));
        await handleWebhookEvent(refundResourceEvent("payment.refund.updated", { payment_id: "pay_1" }));
        expect(await countRows()).toBe(0);
    });
});

describe("webhook signature", () => {
    it("accepts the test and the live slot", async () => {
        await withConfig({ paymongoWebhookSecret: SECRET }, async () => {
            expect(verifySignature(SIGNED_BODY, sign(SIGNED_BODY, { key: "te" }))).toBe(true);
            expect(verifySignature(SIGNED_BODY, sign(SIGNED_BODY, { key: "li" }))).toBe(true);
        });
    });

    it("rejects tampering, a stale replay and the wrong secret", async () => {
        await withConfig({ paymongoWebhookSecret: SECRET }, async () => {
            expect(verifySignature(Buffer.concat([SIGNED_BODY, Buffer.from(" ")]), sign(SIGNED_BODY))).toBe(false);
            expect(verifySignature(SIGNED_BODY, sign(SIGNED_BODY, { secret: "whsec_other" }))).toBe(false);
            const stale = Math.floor(Date.now() / 1000) - (config.paymongoSignatureToleranceS + 60);
            expect(verifySignature(SIGNED_BODY, sign(SIGNED_BODY, { stamp: stale }))).toBe(false);
            expect(verifySignature(SIGNED_BODY, "")).toBe(false);
            expect(verifySignature(SIGNED_BODY, "t=123,te=")).toBe(false);
        });
    });

    it("fails closed without a server secret", async () => {
        await withConfig({ paymongoWebhookSecret: "" }, async () => {
            const body = Buffer.from("{}");
            expect(verifySignature(body, sign(body))).toBe(false);
        });
    });
});

describe("period end shapes", () => {
    it("reads every date shape the provider sends", async () => {
        const deliver = async (schedule: unknown): Promise<Row> => {
            await seedRow({ provider_customer_id: "cus_123", provider_subscription_id: "subs_123", plan: "free", status: "active", current_period_end: null });
            await handleWebhookEvent(subscriptionEvent("subscription.activated", { attrs: { next_billing_schedule: schedule } }));
            return await rowFor();
        };
        expect(iso((await deliver("2026-10-14"))?.current_period_end)).toBe("2026-10-14T00:00:00.000Z");
        expect(new Date(endMs(await deliver(1788678469))).getUTCFullYear()).toBe(new Date(1788678469 * 1000).getUTCFullYear());
        expect(iso((await deliver(""))?.current_period_end)).toBeNull();
        expect(iso((await deliver("not-a-date"))?.current_period_end)).toBeNull();
    });
});

describe("provider variants", () => {
    it("takes the first accepted variant without a speculative second call", async () => {
        const stub = stubHttp();
        const attachUrl = stubRedirectFlow(stub, "pi_1");
        await withConfig(PERIOD, async () => {
            expect(await startCheckout(BUYER)).toEqual({ url: PAY_URL });
        });
        const attach = stub.calls.filter((call) => call.url === attachUrl);
        expect(attach).toHaveLength(1);
        expect((parse(attach[0]).data as { attributes: { client_key: string } }).attributes.client_key).toBe("pi_1_client");
    });

    const attachRoutes = (stub: HttpStub, replies: (() => Response) | (() => Response)[]): string => {
        const intentId = "pi_1";
        const attachUrl = providerUrl(`/v1/payment_intents/${intentId}/attach`);
        stub.post(providerUrl("/v1/customers"), () => json({ data: { id: "cus_1" } }));
        stub.post(providerUrl("/v1/payment_intents"), () => json({ data: { id: intentId } }));
        stub.post(providerUrl("/v1/payment_methods"), () => json({ data: { id: "pm_1" } }));
        stub.on("GET", providerUrl(`/v1/payment_intents/${intentId}`), () => json({ data: { attributes: { client_key: `${intentId}_client` } } }));
        stub.post(attachUrl, replies);
        return attachUrl;
    };

    it("falls back to the second variant and re-raises when both fail", async () => {
        const stub = stubHttp();
        const attachUrl = attachRoutes(stub, [() => json({ detail: "Payment provider error" }, 502), () => json({ data: { attributes: { next_action: { redirect: { url: PAY_URL } } } } })]);
        await withConfig(PERIOD, async () => {
            expect(await startCheckout(BUYER)).toEqual({ url: PAY_URL });
        });
        const attach = stub.calls.filter((call) => call.url === attachUrl);
        expect(attach).toHaveLength(2);
        expect((parse(attach[1]).data as { attributes: { client_key?: string } }).attributes.client_key).toBeUndefined();

        await clearRows();
        const failing = stubHttp();
        attachRoutes(failing, () => json({ detail: "Payment provider error" }, 502));
        await withConfig(PERIOD, async () => {
            expect((await failure(() => startCheckout(BUYER))).status).toBe(502);
        });
    });

    it("falls back to the unversioned invoice path", async () => {
        const stub = stubHttp();
        const params = { resource_id: "subs_1", limit: 1, order: "desc" };
        stub.post(providerUrl("/v1/customers"), () => json({ data: { id: "cus_1" } }));
        stub.post(providerUrl("/v1/subscriptions"), () => json({ data: { id: "subs_1" } }));
        stub.on("GET", providerUrl("/v1/subscriptions/invoices", params), () => json({ detail: "404" }, 404));
        stub.on("GET", providerUrl("/subscriptions/invoices", params), () => json({ data: [{ attributes: { payment_intent: { id: "pi_1" } } }] }));
        stub.post(providerUrl("/v1/payment_methods"), () => json({ data: { id: "pm_1" } }));
        stub.on("GET", providerUrl("/v1/payment_intents/pi_1"), () => json({ data: { attributes: { client_key: "pi_1_client" } } }));
        stub.post(providerUrl("/v1/payment_intents/pi_1/attach"), () => json({ data: { attributes: { next_action: { redirect: { url: PAY_URL } } } } }));
        await withConfig(SUBSCRIPTION, async () => {
            expect(await startSubscription(BUYER)).toBe(PAY_URL);
        });
        const invoiceReads = paths(stub).filter((path) => path.includes("invoices"));
        expect(invoiceReads).toEqual(["GET /v1/subscriptions/invoices", "GET /subscriptions/invoices"]);
    });

    it("answers 502 when the first invoice holds no intent", async () => {
        const stub = stubHttp();
        const params = { resource_id: "subs_1", limit: 1, order: "desc" };
        stub.post(providerUrl("/v1/customers"), () => json({ data: { id: "cus_1" } }));
        stub.post(providerUrl("/v1/subscriptions"), () => json({ data: { id: "subs_1" } }));
        stub.on("GET", providerUrl("/v1/subscriptions/invoices", params), () => json({ data: [] }));
        stub.on("GET", providerUrl("/subscriptions/invoices", params), () => json({ data: [] }));
        await withConfig(SUBSCRIPTION, async () => {
            expect((await failure(() => startSubscription(BUYER))).status).toBe(502);
        });
    });
});

describe("checkout start", () => {
    it("needs an email and a free slot for a subscription", async () => {
        stubHttp();
        await withConfig(SUBSCRIPTION, async () => {
            expect((await failure(() => startSubscription(ClerkUser.parse({ sub: `${OWNER}-noemail`, email: null, name: "A" })))).status).toBe(409);
            await seedRow({ owner_id: `${OWNER}-covered`, plan: "premium", status: "active", current_period_end: inDays(120) });
            expect((await failure(() => startSubscription(ClerkUser.parse({ sub: `${OWNER}-covered`, email: "a@b.co", name: "A B" })))).status).toBe(409);
        });
    });

    it("refuses to start a subscription without config", async () => {
        await withConfig({ paymongoSecretKey: "", paymongoPlanId: "" }, async () => {
            expect((await failure(() => startSubscription(ClerkUser.parse({ sub: `${OWNER}`, email: "a@b.co" })))).status).toBe(503);
        });
    });

    it("needs a secret key but no plan id in period mode", async () => {
        const stub = stubHttp();
        stubRedirectFlow(stub, "pi_1");
        await withConfig({ paymongoSecretKey: "sk_test_x", paymongoPlanId: "", billingMode: "period" }, async () => {
            expect(await startCheckout(BUYER)).toEqual({ url: PAY_URL });
            expect((await failure(() => startSubscription(BUYER))).status).toBe(503);
        });
        await withConfig({ paymongoSecretKey: "", paymongoPlanId: "" }, async () => {
            expect((await failure(() => startCheckout(BUYER))).status).toBe(503);
        });
    });

    it("dispatches checkout on the billing mode", async () => {
        const stub = stubHttp();
        stubRedirectFlow(stub, "pi_1");
        stubSubscriptionFlow(stub, "subs_1", "pi_sub");
        await withConfig({ ...PERIOD, billingMode: "period" }, async () => {
            expect(await startCheckout(BUYER)).toEqual({ url: PAY_URL });
            expect(paths(stub)).not.toContain("POST /v1/subscriptions");
        });
        await clearRows();
        await withConfig({ ...SUBSCRIPTION }, async () => {
            expect(await startCheckout(BUYER)).toEqual({ url: PAY_URL });
            expect(paths(stub)).toContain("POST /v1/subscriptions");
        });
    });

    it("records the intent once a link exists", async () => {
        const stub = stubHttp();
        let intentBody: Record<string, never> = {};
        let rowAtAttach: Row = {};
        stub.post(providerUrl("/v1/customers"), () => json({ data: { id: "cus_1" } }));
        stub.post(providerUrl("/v1/payment_intents"), (call) => {
            intentBody = parse(call);
            return json({ data: { id: "pi_new" } });
        });
        stub.post(providerUrl("/v1/payment_methods"), () => json({ data: { id: "pm_1" } }));
        stub.on("GET", providerUrl("/v1/payment_intents/pi_new"), () => json({ data: { attributes: { client_key: "pi_new_client_x" } } }));
        stub.post(providerUrl("/v1/payment_intents/pi_new/attach"), async () => {
            rowAtAttach = await rowFor();
            return json({ data: { attributes: { next_action: { redirect: { url: PAY_URL } } } } });
        });
        await withConfig(PERIOD, async () => {
            expect(await startCheckout(BUYER)).toEqual({ url: PAY_URL });
        });

        expect(rowAtAttach).toBeUndefined();
        const attrs = (intentBody.data as { attributes: Record<string, unknown> }).attributes;
        expect([attrs.amount, attrs.currency, attrs.capture_type]).toEqual([config.premiumPriceCentavos, "PHP", "automatic"]);
        expect(attrs.payment_method_allowed).toEqual(["qrph"]);
        expect(attrs.metadata).toEqual({ owner_id: OWNER });
        expect("plan" in attrs).toBe(false);
        expect(await rowFor()).toMatchObject({ provider_subscription_id: "pi_new", plan: "premium", status: "incomplete" });
    });

    it("uses the clerk lookup when the token has no email", async () => {
        const stub = stubHttp();
        let customerEmail: unknown = null;
        stub.on("GET", `${config.clerkApiBase}/v1/users/${OWNER}-clerk`, () => json({ email_addresses: [{ id: "id_1", email_address: "payer@example.com" }], primary_email_address_id: "id_1" }));
        stub.post(providerUrl("/v1/customers"), (call) => {
            customerEmail = ((parse(call).data as { attributes: Record<string, unknown> }).attributes as Record<string, unknown>).email;
            return json({ data: { id: "cus_1" } });
        });
        stub.post(providerUrl("/v1/payment_intents"), () => json({ data: { id: "pi_1" } }));
        stub.post(providerUrl("/v1/payment_methods"), () => json({ data: { id: "pm_1" } }));
        stub.on("GET", providerUrl("/v1/payment_intents/pi_1"), () => json({ data: { attributes: { client_key: "pi_1_client" } } }));
        stub.post(providerUrl("/v1/payment_intents/pi_1/attach"), () => json({ data: { attributes: { next_action: { redirect: { url: PAY_URL } } } } }));
        await withConfig({ ...PERIOD, clerkSecretKey: "sk_clerk" }, async () => {
            expect(await startCheckout(ClerkUser.parse({ sub: `${OWNER}-clerk`, email: null, name: "A" }))).toEqual({ url: PAY_URL });
        });
        expect(customerEmail).toBe("payer@example.com");
        expect(stub.calls.filter((call) => call.url.includes("/v1/users/"))).toHaveLength(1);
    });

    it("hands back the qr the rail uses", async () => {
        const stub = stubHttp();
        const expiresAt = "2026-09-26T04:03:57.145658523Z";
        let methodType: unknown = null;
        stub.post(providerUrl("/v1/customers"), () => json({ data: { id: "cus_1" } }));
        stub.post(providerUrl("/v1/payment_intents"), () => json({ data: { id: "pi_qr" } }));
        stub.post(providerUrl("/v1/payment_methods"), (call) => {
            methodType = (parse(call).data as { attributes: Record<string, unknown> }).attributes.type;
            return json({ data: { id: "pm_1" } });
        });
        stub.on("GET", providerUrl("/v1/payment_intents/pi_qr"), () => json({ data: { attributes: { client_key: "pi_qr_client" } } }));
        stub.post(providerUrl("/v1/payment_intents/pi_qr/attach"), () => json({ data: { attributes: { next_action: { type: "consume_qr", code: { image_url: QR_IMAGE, expires_at: expiresAt } } } } }));
        await withConfig(PERIOD, async () => {
            const payable = (await startCheckout(BUYER)) as { qr: { image_url: string } };
            expect(payable.qr.image_url.startsWith("data:image/png;base64,")).toBe(true);
        });
        expect(methodType).toBe("qrph");
    });

    it("needs an email and a free slot in period mode", async () => {
        stubHttp();
        await withConfig(PERIOD, async () => {
            expect((await failure(() => startCheckout(ClerkUser.parse({ sub: `${OWNER}-noemail`, email: null, name: "A" })))).status).toBe(409);
            await seedRow({ plan: "premium", status: "active", current_period_end: inDays(120) });
            expect((await failure(() => startCheckout(BUYER))).status).toBe(409);
        });
    });
});

describe("cancel renewal", () => {
    it("keeps the paid time and calls no provider", async () => {
        const stub = stubHttp();
        await seedRow({ plan: "premium", status: "active", current_period_end: inDays(50) });
        await withConfig(PERIOD, async () => {
            await cancelRenewal(BUYER);
        });
        expect(stub.calls).toEqual([]);
        expect(await rowFor()).toMatchObject({ plan: "premium", status: "cancelled" });
        await withConfig({ clerkEnabled: true }, async () => {
            expect(await resolveTier(ClerkUser.parse({ sub: OWNER, tier: "free" }))).toBe("premium");
        });
    });

    it("answers 404 without a live period", async () => {
        await seedRow({ plan: "premium", status: "active", current_period_end: null });
        await withConfig(PERIOD, async () => {
            expect((await failure(() => cancelRenewal(BUYER))).status).toBe(404);
        });
    });
});
