import { generateKeyPairSync } from "node:crypto";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { getCurrentUser, userEmail, verifyJwt } from "../src/auth.ts";
import { config } from "../src/env.ts";
import { HttpError } from "../src/errors.ts";
import { ClerkUser } from "../src/models.ts";
import { withConfig } from "./helpers/config.ts";
import { json, stubHttp } from "./helpers/http.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS = { keys: [{ ...publicKey.export({ format: "jwk" }), alg: "RS256", kid: "test-kid" }] };

// The Python's _FakeRequest: a real request through a throwaway route is the same seam without
// inventing a Context by hand.
const probe = new Hono();
probe.get("/who", async (c) => c.json(await getCurrentUser(c)));

async function makeToken(options: { kid?: string; sub?: string; exp?: number; iss?: string; aud?: string; iat?: number } = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const payload: Record<string, unknown> = {
        sub: options.sub ?? "user_123",
        iss: options.iss ?? "https://test.clerk.accounts",
        iat: options.iat ?? now,
        exp: options.exp ?? now + 3600,
    };
    if (options.aud !== undefined) payload.aud = options.aud;
    return await new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: options.kid ?? "test-kid" }).sign(privateKey);
}

async function rejection(call: Promise<unknown>): Promise<number> {
    try {
        await call;
    } catch (error) {
        if (error instanceof HttpError) return error.status;
        throw error;
    }
    throw new Error("expected the call to be rejected");
}

describe("auth", () => {
    it("dev fallback returns the fixed user", async () => {
        expect(config.clerkEnabled).toBe(false);
        const user = await (await probe.request("/who")).json();
        expect(user).toEqual({ sub: "dev-user", email: "dev@example.com", name: "Dev User", session_id: null, tier: "free" });
    });

    it("verifies a valid token", async () => {
        await withConfig({ clerkAudience: "" }, async () => {
            expect((await verifyJwt(await makeToken(), JWKS)).sub).toBe("user_123");
        });
    });

    it("rejects a none-alg token", async () => {
        expect(await rejection(verifyJwt("eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.", JWKS))).toBe(401);
    });

    it("rejects a bad signature", async () => {
        const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-kid" })).toString("base64url");
        const payload = Buffer.from(JSON.stringify({ sub: "user_123", iss: "https://test.clerk.accounts" })).toString("base64url");
        expect(await rejection(verifyJwt(`${header}.${payload}.garbage`, JWKS))).toBe(401);
    });

    it("rejects an unknown kid", async () => {
        expect(await rejection(verifyJwt(await makeToken({ kid: "other-kid" }), JWKS))).toBe(401);
    });

    it("rejects an expired token", async () => {
        expect(await rejection(verifyJwt(await makeToken({ exp: Math.floor(Date.now() / 1000) - 100 }), JWKS))).toBe(401);
    });

    // Clerk stamps `iat` from its own clock, so a brand-new session 401'd its FIRST request and worked a
    // second later. Leeway covers that rounding without covering real skew.
    it("tolerates a freshly issued token from ahead of our clock", async () => {
        expect((await verifyJwt(await makeToken({ iat: Math.floor(Date.now() / 1000) + 1 }), JWKS)).sub).toBe("user_123");
        expect(await rejection(verifyJwt(await makeToken({ iat: Math.floor(Date.now() / 1000) + 60 }), JWKS))).toBe(401);
    });

    it("rejects the wrong issuer", async () => {
        expect(await rejection(verifyJwt(await makeToken({ iss: "https://evil.clerk.accounts" }), JWKS))).toBe(401);
    });

    it("enforces the audience when one is configured", async () => {
        await withConfig({ clerkAudience: "maxterview" }, async () => {
            expect((await verifyJwt(await makeToken({ aud: "maxterview" }), JWKS)).sub).toBe("user_123");
            expect(await rejection(verifyJwt(await makeToken({ aud: "other-app" }), JWKS))).toBe(401);
        });
    });

    it("takes the user email from the claim when the token carries one", async () => {
        expect(await userEmail(ClerkUser.parse({ sub: "user_123", email: "claim@example.com" }))).toBe("claim@example.com");
    });

    it("has no user email without a claim or a secret key", async () => {
        expect(await userEmail(ClerkUser.parse({ sub: "user_123", email: null }))).toBeNull();
    });

    // auth.ts keeps the address picker private, so the three bodies go in through the Clerk lookup that uses it.
    it("primary email prefers the flagged address and survives a stale flag", async () => {
        const stub = stubHttp();
        const addresses = [
            { id: "id_1", email_address: "a@example.com" },
            { id: "id_2", email_address: "b@example.com" },
        ];
        const bodies: Record<string, unknown> = {
            user_flagged: { email_addresses: addresses, primary_email_address_id: "id_2" },
            user_stale: { email_addresses: addresses, primary_email_address_id: "gone" },
            user_unset: {},
        };
        for (const [sub, body] of Object.entries(bodies)) stub.on("GET", `https://api.clerk.com/v1/users/${sub}`, () => json(body));
        await withConfig({ clerkSecretKey: "sk_test", clerkDomain: "https://test.clerk.accounts" }, async () => {
            expect(await userEmail(ClerkUser.parse({ sub: "user_flagged" }))).toBe("b@example.com");
            expect(await userEmail(ClerkUser.parse({ sub: "user_stale" }))).toBe("a@example.com");
            expect(await userEmail(ClerkUser.parse({ sub: "user_unset" }))).toBeNull();
        });
    });
});
