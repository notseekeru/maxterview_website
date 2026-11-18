import { strict as assert } from "node:assert";
import { createHmac, timingSafeEqual } from "node:crypto";
import * as auth from "./auth.ts";
import { fetchrow, sql } from "./db.ts";
import { config } from "./env.ts";
import { HttpError } from "./errors.ts";
import type { ClerkUser } from "./models.ts";
import { log } from "./observability.ts";

const API_BASE = "https://api.paymongo.com";
const PROVIDER = "paymongo";
const HTTP_TIMEOUT_MS = 20_000;

// Only rail this LIVE account accepts. Test mode allows the rest, so probe the
// live key before adding one: a test-mode pass proves nothing.
const PERIOD_METHODS = ["qrph"];

// Provider statuses that mean "no more money is coming" -> the row stops being premium. The other
// statuses stay `premium` so `past_due`/`unpaid` can recover on a later invoice.paid.
const TERMINAL_STATUSES = ["cancelled", "incomplete_cancelled"];

// SUBSCRIPTION mode only: mirrors PayMongo's own first-payment window. Period mode cannot use it, a
// QR Ph code lives 30 minutes, so a 24h lock would outlive the thing it waits on.
const FIRST_PAYMENT_WINDOW_H = 24;

// Intent statuses meaning no money can arrive. Anything else fails CLOSED: blocking costs minutes
// (the QR expires on its own), a wrong unblock sells a second charge.
const DEAD_INTENT_STATUSES = ["expired", "canceled", "cancelled", "failed"];

// QR Ph cannot be refunded through the API (`Refunds are not allowed for ...qrph`), so a dashboard
// refund is only ever visible as one of these. The newer catalog names are refused.
const REFUND_EVENTS = ["payment.refunded", "payment.refund.updated"];
// A refund settles asynchronously (PayMongo holds one while the balance is short), so only the settled
// state revokes: a pending or failed refund must leave the paid period serving.
const REFUND_SETTLED = "succeeded";
// Row status written by `revoke`. Deliberately absent from `billing.ENTITLED_STATUSES`: that is what
// makes the downgrade take effect on the next read with no scheduled job.
const REVOKED_REFUND = "refunded";

const QR_TTL_MIN = 30;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

type Payload = Record<string, unknown>;
type ApiOptions = { json?: unknown; params?: Record<string, string | number> };

function isPayload(value: unknown): value is Payload {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown): Payload {
    return isPayload(value) ? value : {};
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

// Python's `_period_end` re-stamps a naive timestamp as UTC. `new Date("2024-01-01T00:00:00")` reads
// local time instead, so the zone is added rather than assumed; a bare day is already UTC by spec.
const WITH_ZONE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

function periodEnd(value: unknown): Date | null {
    if (value === null || value === undefined || value === "" || value === 0 || value === false) return null;
    const moment = typeof value === "number" ? new Date(value * 1000) : typeof value === "string" ? new Date(/[T ]/.test(value) && !WITH_ZONE.test(value) ? `${value.replace(" ", "T")}Z` : value) : null;
    return moment === null || Number.isNaN(moment.getTime()) ? null : moment;
}

function resubscribeBlock(row: Payload | undefined, now = new Date()): string {
    if (row === undefined) return "";
    if (row.status === "incomplete") {
        // A second subscription while the first payment link is alive is a second charge.
        const started = periodEnd(row.updated_at);
        if (started === null || (now.getTime() - started.getTime()) / 1000 < FIRST_PAYMENT_WINDOW_H * 3600) {
            return "A first payment is already pending. Finish it, or retry after it expires (24h)";
        }
        return "";
    }
    const end = periodEnd(row.current_period_end);
    if (row.plan === "premium" && (end === null || end > now)) {
        // active, past_due, or cancelled-with-time-left: all still inside a period they paid for.
        return "Your subscription already covers the current period";
    }
    return "";
}

function requireConfig(): void {
    if (!(config.paymongoSecretKey && config.paymongoPlanId)) throw new HttpError(503, "Billing is not configured");
}

function requirePeriodConfig(): void {
    if (!config.paymongoSecretKey) throw new HttpError(503, "Billing is not configured");
}

async function api(method: string, path: string, options: ApiOptions = {}): Promise<Payload> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(options.params ?? {})) url.searchParams.set(key, String(value));
    const headers: Record<string, string> = { authorization: `Basic ${Buffer.from(`${config.paymongoSecretKey}:`).toString("base64")}` };
    if (options.json !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(url, {
        method,
        headers,
        body: options.json === undefined ? undefined : JSON.stringify(options.json),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (response.status >= 400) {
        // Log the provider body (it explains 400s that would otherwise be opaque); never return it
        // to the client: it can echo request metadata.
        log.warning("paymongo.request_failed", { method, path, status: response.status, body: (await response.text()).slice(0, 500) });
        throw new HttpError(502, "Payment provider error");
    }
    return record(await response.json());
}

// AI HERE: hedges two documented-but-unguaranteed PayMongo shapes that could not be exercised
// before launch (no activated account), the invoice-list path prefix and whether a server-side
// attach tolerates `client_key`. Collapse this to the winning variant once a sandbox run proves it.
async function tryVariants<T>(variants: T[], attempt: (variant: T) => Promise<Payload>): Promise<Payload> {
    for (const [index, variant] of variants.entries()) {
        try {
            return await attempt(variant);
        } catch (error) {
            if (!(error instanceof HttpError) || index === variants.length - 1) throw error;
            log.warning("paymongo.variant_retry", { variant_index: index });
        }
    }
    throw new HttpError(502, "Payment provider error");
}

export async function startSubscription(user: ClerkUser): Promise<string> {
    requireConfig();
    const email = await requireEmail(user);
    const existing = await fetchrow(sql`SELECT plan, status, current_period_end, updated_at FROM subscriptions WHERE owner_id = ${user.sub}`);
    const block = resubscribeBlock(existing);
    if (block) throw new HttpError(409, block);

    const customerId = await ensureCustomer(user, email);
    const subscription = await api("POST", "/v1/subscriptions", { json: { data: { attributes: { plan_id: config.paymongoPlanId, customer_id: customerId } } } });
    const subscriptionId = text(record(subscription.data).id);
    // Record the ids *before* the redirect: the customer may never come back from Maya, and the
    // webhook that follows needs a row to resolve the owner from.
    await upsert(user.sub, customerId, subscriptionId, config.paymongoPlanId, "premium", "incomplete", null);

    return text((await payableIntent(await firstInvoiceIntent(subscriptionId), "paymaya")).url);
}

async function payableIntent(intentId: string, methodType: string): Promise<Payload> {
    const method = await api("POST", "/v1/payment_methods", { json: { data: { attributes: { type: methodType } } } });
    // AI HERE: one extra GET for `client_key` so the attach body satisfies both the secret-key and
    // the public-key flow. Drop it once a sandbox attach proves the key is unnecessary.
    const intent = await api("GET", `/v1/payment_intents/${intentId}`);
    const body = { payment_method: text(record(method.data).id), return_url: `${config.frontendBaseUrl}/dashboard?upgrade=pending` };
    const attach = await tryVariants(
        // `client_key` is documented for the public-key attach and is a browser-safe token, so send it
        // first (matching the only documented shape) and fall back to a secret-key-only body.
        [{ ...body, client_key: text(record(record(intent.data).attributes).client_key) }, body],
        async (attributes) => await api("POST", `/v1/payment_intents/${intentId}/attach`, { json: { data: { attributes } } }),
    );
    const action = record(record(record(attach.data).attributes).next_action);
    const payable = artifact(action);
    if (Object.keys(payable).length === 0) throw new HttpError(502, "Payment provider returned nothing payable");
    return payable;
}

function artifact(action: Payload): Payload {
    const url = text(record(action.redirect).url);
    if (url) return { url };
    const code = record(action.code);
    const image = text(code.image_url);
    if (image) return { qr: { image_url: image, expires_at: text(code.expires_at) } };
    return {};
}

async function startPeriodPurchase(user: ClerkUser): Promise<Payload> {
    requirePeriodConfig();
    const email = await requireEmail(user);
    const existing = await fetchrow(sql`SELECT owner_id, plan, status, current_period_end, updated_at, provider_subscription_id FROM subscriptions WHERE owner_id = ${user.sub}`);
    let block: string;
    if (existing !== undefined && existing.status === "incomplete") {
        // A pending row is judged by the provider, and a code that is STILL payable is handed back as
        // it is: closing the popup, reloading, or coming back later must not strand the payment.
        const [resumed, pending] = await resumeOrBlock(existing);
        if (Object.keys(resumed).length > 0) return resumed;
        block = pending;
    } else {
        block = resubscribeBlock(existing);
    }
    if (block) throw new HttpError(409, block);

    const customerId = await ensureCustomer(user, email);
    const intent = await api("POST", "/v1/payment_intents", {
        json: {
            data: {
                attributes: {
                    amount: config.premiumPriceCentavos,
                    currency: "PHP",
                    payment_method_allowed: PERIOD_METHODS,
                    capture_type: "automatic",
                    description: `Maxterview Premium (${config.premiumPeriodDays} days)`,
                    metadata: { owner_id: user.sub },
                },
            },
        },
    });
    const intentId = text(record(intent.data).id);
    // `provider_subscription_id` holds the intent id, the column `ownerFor` resolves from.
    // A refused method must not leave a row blocking the owner's retry.
    const payable = await payableIntent(intentId, PERIOD_METHODS[0]);
    await upsert(user.sub, customerId, intentId, "", "premium", "incomplete", null);
    return payable;
}

export async function startCheckout(user: ClerkUser): Promise<Payload> {
    if (config.billingMode === "subscription") return { url: await startSubscription(user) };
    return await startPeriodPurchase(user);
}

export async function cancelRenewal(user: ClerkUser): Promise<void> {
    if (config.billingMode === "subscription") {
        await cancelSubscription(user);
        return;
    }
    // Nothing is scheduled provider-side, so this only records "do not renew": the paid time keeps
    // serving (billing.ENTITLED_STATUSES). No live period -> nothing to cancel.
    const row = await fetchrow(sql`SELECT current_period_end FROM subscriptions WHERE owner_id = ${user.sub}`);
    const end = periodEnd(row?.current_period_end);
    if (end === null || end.getTime() <= Date.now()) throw new HttpError(404, "No active period to cancel");
    await fetchrow(sql`UPDATE subscriptions SET plan = 'premium', status = 'cancelled', updated_at = now() WHERE owner_id = ${user.sub} RETURNING id`);
}

export async function cancelSubscription(user: ClerkUser): Promise<void> {
    const row = await fetchrow(sql`SELECT provider_subscription_id FROM subscriptions WHERE owner_id = ${user.sub}`);
    const subscriptionId = text(row?.provider_subscription_id);
    if (!subscriptionId) throw new HttpError(404, "No subscription found");
    requireConfig();
    await api("DELETE", `/v1/subscriptions/${subscriptionId}`);
    await fetchrow(sql`UPDATE subscriptions SET plan = 'premium', status = 'cancelled', updated_at = now() WHERE owner_id = ${user.sub} RETURNING id`);
}

async function requireEmail(user: ClerkUser): Promise<string> {
    const email = await auth.userEmail(user);
    if (!(email ?? "").includes("@")) throw new HttpError(409, "Add an email to your account before upgrading");
    return email ?? "";
}

async function ensureCustomer(user: ClerkUser, email: string): Promise<string> {
    const row = await fetchrow(sql`SELECT provider, provider_customer_id FROM subscriptions WHERE owner_id = ${user.sub}`);
    const existing = text(row?.provider_customer_id);
    // Only trust an id this provider issued: 0008 renamed Stripe's `stripe_id` into
    // `provider_customer_id`, so a pre-swap row still carries a `cus_…` PayMongo never saw.
    if (existing && row?.provider === PROVIDER) return existing;
    const [first, ...rest] = (user.name ?? "").trim().split(" ");
    let customer: Payload;
    try {
        customer = await api("POST", "/v1/customers", {
            json: {
                data: {
                    attributes: {
                        first_name: first || "Maxterview",
                        last_name: rest.length > 0 ? rest.join(" ") : "Member",
                        email,
                        // Required by PayMongo; the upgrade path already refuses to start without an
                        // email, so `email` is the only honest value.
                        default_device: "email",
                    },
                },
            },
        });
    } catch (error) {
        // Re-raising would wedge that address on checkout for good.
        if (!(error instanceof HttpError)) throw error;
        const found = (await api("GET", "/v1/customers", { params: { email, limit: 100 } })).data;
        const match = (Array.isArray(found) ? found : []).find((candidate) => customerEmail(candidate).toLowerCase() === email.toLowerCase());
        if (match === undefined) throw error;
        log.info("paymongo.customer_reused", { owner_id: user.sub });
        return text(record(match).id);
    }
    return text(record(customer.data).id);
}

function customerEmail(candidate: unknown): string {
    return text(record(record(candidate).attributes).email);
}

async function firstInvoiceIntent(subscriptionId: string): Promise<string> {
    const params = { resource_id: subscriptionId, limit: 1, order: "desc" };
    // The docs list the collection endpoint both with and without the `/v1` prefix, so try both.
    const invoices = await tryVariants(["/v1/subscriptions/invoices", "/subscriptions/invoices"], async (path) => await api("GET", path, { params }));
    const rows = invoices.data;
    const first = Array.isArray(rows) ? record(rows[0]) : {};
    const intent = record(record(first.attributes).payment_intent);
    const intentId = text(intent.id);
    if (!intentId) throw new HttpError(502, "Payment provider returned no first invoice");
    return intentId;
}

export function verifySignature(rawBody: Uint8Array, header: string): boolean {
    const secret = config.paymongoWebhookSecret;
    if (!secret || !header) return false;
    const parts = new Map<string, string>();
    for (const part of header.split(",")) {
        const at = part.indexOf("=");
        if (at !== -1) parts.set(part.slice(0, at), part.slice(at + 1));
    }
    const stamp = parts.get("t") ?? "";
    const given = ["te", "li"].map((key) => parts.get(key) ?? "").filter((value) => value !== "");
    if (!stamp || given.length === 0) {
        log.warning("paymongo.webhook_signature.malformed", { header: header.slice(0, 80) });
        return false;
    }
    if (!/^[+-]?\d+$/.test(stamp)) return false;
    const age = Math.abs(Date.now() / 1000 - Number(stamp));
    if (age > config.paymongoSignatureToleranceS) {
        // Worth a loud log: a genuine event rejected here (provider retries reusing an old `t`)
        // would leave a paying user un-entitled until the next delivery.
        log.warning("paymongo.webhook_signature.stale", { age_s: Math.trunc(age), tolerance_s: config.paymongoSignatureToleranceS });
        return false;
    }
    const expected = createHmac("sha256", secret).update(`${stamp}.`).update(rawBody).digest("hex");
    const mine = Buffer.from(expected, "utf8");
    for (const candidate of given) {
        const presented = Buffer.from(candidate, "utf8");
        // Length differs -> not our signature; timingSafeEqual throws on a length mismatch.
        if (presented.length === mine.length && timingSafeEqual(presented, mine)) return true;
    }
    log.warning("paymongo.webhook_signature.mismatch", { livemode_slot: (parts.get("li") ?? "") !== "" });
    return false;
}

function envelope(event: Payload): { etype: string; resource: Payload } {
    const outer = record(event.data);
    const attrs = isPayload(outer.attributes) ? outer.attributes : outer;
    return { etype: text(attrs.type), resource: record(attrs.data) };
}

export async function handleWebhookEvent(event: Payload): Promise<void> {
    const { etype, resource } = envelope(event);
    const attrs = record(resource.attributes);
    const type = text(resource.type);
    if (type === "subscription") {
        await onSubscription(attrs);
    } else if (type === "invoice") {
        await onInvoice(etype, attrs);
    } else if (REFUND_EVENTS.includes(etype) || type === "refund") {
        // `payment.refunded` can embed the payment, which `onPayment` ignores (it credits only `*.paid`).
        await onRefund(etype, resource, attrs);
    } else if (type === "payment" || type === "payment_intent") {
        await onPayment(etype, resource, attrs);
    }
    // invoice.created/finalized/updated are draft/open churn: no entitlement change, no write.
}

async function onPayment(etype: string, resource: Payload, attrs: Payload): Promise<void> {
    if (etype !== "payment.paid" && etype !== "payment_intent.succeeded") return;
    // `payment` carries the intent it was charged against; a `payment_intent` event IS the intent.
    const intentId = text(attrs.payment_intent_id) || (text(resource.type) === "payment_intent" ? text(resource.id) : "");
    if (!intentId) {
        log.warning("paymongo.webhook.payment_without_intent", { event_type: etype });
        return;
    }
    const owner = await ownerFor({ subscriptionId: intentId });
    if (owner === null) {
        // An intent we never issued: ack it, write nothing.
        log.info("paymongo.webhook.unknown_payment_intent", { payment_intent_id: intentId, event_type: etype });
        return;
    }
    if (!(await creditPeriod(owner, intentId))) {
        // Already credited (replay), or the row moved on to a newer intent.
        log.info("paymongo.webhook.payment_not_credited", { payment_intent_id: intentId, event_type: etype });
    }
}

async function onRefund(etype: string, resource: Payload, attrs: Payload): Promise<void> {
    const refundId = text(resource.type) === "refund" ? text(resource.id) : "";
    let refund = refundId ? attrs : {};
    if (refundId && !text(refund.status)) refund = await getAttributes(`/v1/refunds/${refundId}`);
    // A status is only ever read off a REFUND resource: a payment's own `status` is `paid` (or
    // `refunded`), never the refund's state, so reading it there would compare the wrong words.
    const status = text(refund.status) || (etype === "payment.refunded" ? REFUND_SETTLED : "");
    if (status !== REFUND_SETTLED) {
        log.info("paymongo.webhook.refund_not_settled", { event_type: etype, status, refund_id: refundId });
        return;
    }
    const paymentId = text(attrs.payment_id) || text(refund.payment_id);
    const intentId = text(attrs.payment_intent_id) || (paymentId ? await intentOfPayment(paymentId) : "");
    const owner = intentId ? await ownerFor({ subscriptionId: intentId }) : null;
    if (owner === null) {
        log.warning("paymongo.webhook.unattributable_refund", { event_type: etype, refund_id: refundId, payment_id: paymentId, payment_intent_id: intentId });
        return;
    }
    await revoke(owner, REVOKED_REFUND, etype);
}

async function getAttributes(path: string): Promise<Payload> {
    try {
        return record(record((await api("GET", path)).data).attributes);
    } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        return {};
    }
}

async function intentOfPayment(paymentId: string): Promise<string> {
    return text((await getAttributes(`/v1/payments/${paymentId}`)).payment_intent_id);
}

async function revoke(ownerId: string, status: string, eventType: string): Promise<void> {
    const row = await fetchrow(sql`UPDATE subscriptions SET plan = 'free', status = ${status}, updated_at = now() WHERE owner_id = ${ownerId} AND plan = 'premium' RETURNING id`);
    log.info("paymongo.webhook.revoke", { owner_id: ownerId, status, event_type: eventType, revoked: row !== undefined });
}

async function creditPeriod(ownerId: string, intentId: string): Promise<boolean> {
    const row = await fetchrow(sql`
        UPDATE subscriptions SET plan = 'premium', status = 'active', current_period_end = ${new Date(Date.now() + config.premiumPeriodDays * DAY_MS)}, updated_at = now()
        WHERE owner_id = ${ownerId} AND provider_subscription_id = ${intentId} AND status = 'incomplete'
        RETURNING id
        `);
    if (row !== undefined) {
        // The only durable record that money bought a period: the webhook and the checkout resume
        // path both land here, and neither the tier read nor the credit write leaves another trace.
        log.info("paymongo.payment.credited", { owner_id: ownerId, payment_intent_id: intentId });
    }
    return row !== undefined;
}

async function resumeOrBlock(row: Payload): Promise<[Payload, string]> {
    const intentId = text(row.provider_subscription_id);
    const intent = await intentView(intentId);
    if (intent.status === "succeeded") {
        // Money arrived but no delivery credited it. Credit it here through the same compare-and-set
        // the webhook uses (a late delivery then no-ops) instead of selling a second period.
        await creditPeriod(text(row.owner_id), intentId);
        return [{}, "Payment already received. Refresh to see your Pro access"];
    }
    const now = Date.now();
    const deadline = intent.expiresAt ?? (periodEnd(row.updated_at)?.getTime() ?? now) + QR_TTL_MIN * MINUTE_MS;
    if (DEAD_INTENT_STATUSES.includes(intent.status) || deadline <= now) return [{}, ""];
    if (intent.status === "processing") {
        // The wallet is mid-payment. Re-showing the code here would invite a second scan.
        return [{}, "Your payment is being processed. One moment"];
    }
    if (Object.keys(intent.artifact).length > 0) return [intent.artifact, ""];
    const left = Math.max(1, Math.floor((deadline - now) / MINUTE_MS));
    return [{}, `A payment is already pending, ${left} min left`];
}

async function intentView(intentId: string): Promise<{ status: string; expiresAt: number | null; artifact: Payload }> {
    if (!intentId) return { status: "", expiresAt: null, artifact: {} };
    let data: Payload;
    try {
        data = record((await api("GET", `/v1/payment_intents/${intentId}`)).data);
    } catch (error) {
        if (!(error instanceof HttpError)) throw error;
        return { status: "", expiresAt: null, artifact: {} };
    }
    const attrs = record(data.attributes);
    const nextAction = record(attrs.next_action);
    return { status: text(attrs.status), expiresAt: periodEnd(record(nextAction.code).expires_at)?.getTime() ?? null, artifact: artifact(nextAction) };
}

async function onSubscription(attrs: Payload): Promise<void> {
    const subscriptionId = text(attrs.id);
    // A `customer_id` fallback would let a stale event for a replaced subscription downgrade a payer.
    let owner = await ownerFor({ subscriptionId });
    if (owner === null) {
        if (subscriptionId) {
            log.info("paymongo.webhook.unknown_subscription", { subscription_id: subscriptionId, status: text(attrs.status) });
            return;
        }
        owner = await ownerFor({ customerId: text(attrs.customer_id) });
    }
    if (owner === null) return;
    const status = text(attrs.status);
    await upsert(owner, text(attrs.customer_id), subscriptionId, text(attrs.plan_id), TERMINAL_STATUSES.includes(status) ? "free" : "premium", status, periodEnd(attrs.next_billing_schedule));
}

async function onInvoice(etype: string, attrs: Payload): Promise<void> {
    const owner = await ownerFor({ subscriptionId: text(attrs.resource_id) });
    if (owner === null) return;
    if (etype === "subscription.invoice.paid") {
        // Recovers a lapsed-but-live subscription, never a cancelled or self-cancelled one.
        await fetchrow(sql`
            UPDATE subscriptions SET plan = 'premium', status = 'active', updated_at = now()
            WHERE owner_id = ${owner} AND status IN ('past_due', 'unpaid', 'incomplete')
            RETURNING id
            `);
    } else if (etype === "subscription.invoice.payment_failed") {
        await fetchrow(sql`UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE owner_id = ${owner} RETURNING id`);
    }
}

async function ownerFor({ subscriptionId = "", customerId = "" }: { subscriptionId?: string; customerId?: string }): Promise<string | null> {
    if (subscriptionId) {
        const row = await fetchrow(sql`SELECT owner_id FROM subscriptions WHERE provider_subscription_id = ${subscriptionId} LIMIT 1`);
        if (row !== undefined) return text(row.owner_id);
    }
    if (customerId) {
        const row = await fetchrow(sql`SELECT owner_id FROM subscriptions WHERE provider_customer_id = ${customerId} LIMIT 1`);
        if (row !== undefined) return text(row.owner_id);
    }
    return null;
}

async function upsert(ownerId: string, customerId: string, subscriptionId: string, planId: string, plan: string, status: string, end: Date | null): Promise<void> {
    await fetchrow(sql`
        INSERT INTO subscriptions (owner_id, provider, provider_customer_id, provider_subscription_id, provider_plan_id, plan, status, current_period_end)
        VALUES (${ownerId}, ${PROVIDER}, ${customerId}, ${subscriptionId}, ${planId}, ${plan}, ${status}, ${end})
        ON CONFLICT (owner_id) DO UPDATE SET
            provider = EXCLUDED.provider,
            provider_customer_id = EXCLUDED.provider_customer_id,
            provider_subscription_id = EXCLUDED.provider_subscription_id,
            provider_plan_id = EXCLUDED.provider_plan_id,
            plan = EXCLUDED.plan,
            status = EXCLUDED.status,
            current_period_end = COALESCE(EXCLUDED.current_period_end, subscriptions.current_period_end),
            updated_at = now()
        RETURNING id
        `);
}

// A naive timestamp is the trap: read as local time it shifts a paid period by the host's offset.
assert(periodEnd("2024-01-01T00:00:00")?.toISOString() === "2024-01-01T00:00:00.000Z" && periodEnd("2024-01-01")?.toISOString() === "2024-01-01T00:00:00.000Z" && periodEnd(0) === null && periodEnd("nonsense") === null);
