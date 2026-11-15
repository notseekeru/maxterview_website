import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { app } from "../src/app.ts";
import { config } from "../src/env.ts";

const RAW = '{"data": {"attributes": {}},  "extra": 1}';
const SECRET = "whsec_unit";

// A signature over re-serialised JSON: catchable only if the route verifies the bytes PayMongo sent.
function sign(body: string, secret = SECRET): string {
    const stamp = Math.floor(Date.now() / 1000);
    const mac = createHmac("sha256", secret).update(`${stamp}.${body}`).digest("hex");
    return `t=${stamp},te=${mac}`;
}

describe("billing webhook", () => {
    it("verifies the signature over the raw body, whitespace and key order included", async () => {
        config.paymongoWebhookSecret = SECRET;
        const res = await app.request("/api/billing/webhook", { method: "POST", body: RAW, headers: { "paymongo-signature": sign(RAW) } });
        config.paymongoWebhookSecret = "";
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("ok");
    });

    it("refuses a signature computed over the same JSON reshaped", async () => {
        config.paymongoWebhookSecret = SECRET;
        const res = await app.request("/api/billing/webhook", { method: "POST", body: RAW, headers: { "paymongo-signature": sign(JSON.stringify(JSON.parse(RAW))) } });
        config.paymongoWebhookSecret = "";
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ detail: "Invalid signature" });
    });

    it("feeds the simulator to the same handler, and hides it outside dev and test", async () => {
        const ok = await app.request("/api/billing/webhook/simulate", { method: "POST", body: "{}" });
        expect(ok.status).toBe(200);
        expect(await ok.text()).toBe("ok");

        config.appEnv = "production";
        const hidden = await app.request("/api/billing/webhook/simulate", { method: "POST", body: "{}" });
        config.appEnv = "development";
        expect(hidden.status).toBe(404);
        expect(await hidden.json()).toEqual({ detail: "Not Found" });
    });
});
