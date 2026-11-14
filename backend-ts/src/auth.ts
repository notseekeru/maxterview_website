import { strict as assert } from "node:assert";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { decodeProtectedHeader, importJWK, type JWK, type JWTPayload, jwtVerify, type ProtectedHeaderParameters } from "jose";
import { config } from "./env.ts";
import { HttpError } from "./errors.ts";
import { log } from "./logs.ts";
import { ClerkUser } from "./models.ts";

declare module "hono" {
    interface ContextVariableMap {
        user_sub: string;
    }
}

// Clerk's clock is not ours: sub-second skew 401s a brand-new session without this leeway.
const JWT_LEEWAY_S = 10;

const JWKS_CACHE_TTL_MS = 3600 * 1000;
const USER_EMAIL_TTL_MS = 3600 * 1000;
const HTTP_TIMEOUT_MS = 10_000;

const DEV_SUB = /^[A-Za-z0-9._:-]{1,128}$/;

type Jwks = { keys?: JWK[] };

let jwksCache: Jwks | null = null;
let jwksFetchedAt = 0;

const userEmailCache = new Map<string, { expiresAt: number; email: string }>();

function devUser(): ClerkUser {
    return ClerkUser.parse({ sub: config.devUserSub, email: "dev@example.com", name: "Dev User" });
}

function unauthorized(): HttpError {
    return new HttpError(401, "Invalid credentials");
}

async function fetchJwks(): Promise<Jwks> {
    const now = Date.now();
    if (jwksCache !== null && now - jwksFetchedAt < JWKS_CACHE_TTL_MS) return jwksCache;
    const response = await fetch(config.clerkJwksUrl, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`clerk jwks: ${response.status}`);
    const data = (await response.json()) as Jwks;
    jwksCache = data;
    jwksFetchedAt = now;
    return data;
}

function claim(payload: JWTPayload, key: string): string | null {
    const value = payload[key];
    return typeof value === "string" ? value : null;
}

export async function verifyJwt(token: string, jwks: Jwks): Promise<ClerkUser> {
    let header: ProtectedHeaderParameters;
    try {
        header = decodeProtectedHeader(token);
    } catch {
        throw unauthorized();
    }
    if (header.alg !== "RS256") throw unauthorized();

    const jwk = (jwks.keys ?? []).find((key) => key.kid === header.kid);
    if (jwk === undefined) throw unauthorized();
    const publicKey = await importJWK(jwk, "RS256");

    let payload: JWTPayload;
    try {
        ({ payload } = await jwtVerify(token, publicKey, {
            algorithms: ["RS256"],
            issuer: config.clerkDomain,
            audience: config.clerkAudience || undefined,
            clockTolerance: JWT_LEEWAY_S,
        }));
    } catch {
        throw unauthorized();
    }

    // `parse` rather than a literal: a token without `sub` is a 500 here exactly as the Python's
    // `payload["sub"]` KeyError was, and Pydantic's defaults fill the rest.
    return ClerkUser.parse({
        sub: payload.sub,
        email: claim(payload, "email"),
        name: claim(payload, "name") || claim(payload, "first_name"),
        session_id: claim(payload, "sid"),
    });
}

type EmailAddress = { id?: string; email_address?: string };
type ClerkUserBody = { email_addresses?: EmailAddress[]; primary_email_address_id?: string };

function primaryEmail(body: unknown): string | null {
    const record = (typeof body === "object" && body !== null ? body : {}) as ClerkUserBody;
    const addresses = record.email_addresses ?? [];
    for (const address of addresses) {
        if (address.id === record.primary_email_address_id && address.email_address) return address.email_address;
    }
    // No primary flag, or it points nowhere: any address beats refusing a paying customer.
    return addresses.find((address) => address.email_address)?.email_address ?? null;
}

export async function userEmail(user: ClerkUser): Promise<string | null> {
    if (user.email) return user.email;
    if (!(config.clerkSecretKey && config.clerkDomain)) return null;
    const cached = userEmailCache.get(user.sub);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.email;
    let email: string | null;
    try {
        const response = await fetch(`${config.clerkApiBase}/v1/users/${encodeURIComponent(user.sub)}`, {
            headers: { authorization: `Bearer ${config.clerkSecretKey}` },
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`clerk user lookup: ${response.status}`);
        email = primaryEmail(await response.json());
    } catch (error) {
        log.warning("clerk.user_lookup_failed", { sub: user.sub, reason: error instanceof Error ? error.name : typeof error });
        return null;
    }
    if (email) userEmailCache.set(user.sub, { expiresAt: Date.now() + USER_EMAIL_TTL_MS, email });
    return email;
}

// `__session` cookie is primary (frontend/src/lib/api.ts sends it); Bearer accepted for API clients/tests.
function extractToken(c: Context): string | null {
    const token = getCookie(c, "__session");
    if (token) return token;
    const header = c.req.header("authorization") ?? "";
    if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
    return null;
}

function attributed(c: Context, user: ClerkUser): ClerkUser {
    c.set("user_sub", user.sub);
    return user;
}

export async function getCurrentUser(c: Context): Promise<ClerkUser> {
    if (!config.clerkEnabled) {
        const sub = config.appEnv === "development" || config.appEnv === "test" ? c.req.header("x-dev-sub") : undefined;
        if (sub === undefined) return attributed(c, devUser());
        if (!DEV_SUB.test(sub)) throw new HttpError(400, "Invalid X-Dev-Sub");
        return attributed(c, { ...devUser(), sub });
    }
    const token = extractToken(c);
    if (token === null) throw new HttpError(401, "Missing credentials");
    return attributed(c, await verifyJwt(token, await fetchJwks()));
}

assert(DEV_SUB.test("k6-sweep-r1-7") && !DEV_SUB.test("bad sub/slash") && !DEV_SUB.test(""));
