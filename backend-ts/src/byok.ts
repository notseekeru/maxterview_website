import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { fetchrow, sql } from "./db.ts";
import { config } from "./env.ts";
import { HttpError } from "./errors.ts";
import * as llm from "./llm.ts";
import { log } from "./logs.ts";
import type { ClerkUser, LLMProvider } from "./models.ts";

export const DISABLED_DETAIL = "BYOK is not enabled on this deployment: set BYOK_ENCRYPTION_KEY on the backend, then save again.";

// Long enough to be a key, and no whitespace: it goes verbatim into an Authorization header, where a
// stray space or newline is a malformed (or injected) request.
const KEY_MIN = 8;
const KEY_MAX = 500;
const DNS_TIMEOUT_MS = 5000;
const FERNET_VERSION = 0x80;
const FERNET_OVERHEAD = 1 + 8 + 16 + 32;

const BASE_URL_DETAIL = "Base URL must look like https://api.openai.com/v1 (http/https, no credentials, no query).";
const OWN_PROVIDER_DETAIL = "That is this deployment's own provider. BYOK is for an endpoint you pay for - point it at your own, or clear it to use the system default.";
const PRIVATE_HOST_DETAIL = "That address is inside a private network, or a name that points into one. BYOK needs a provider reachable on the public internet - this deployment's own model and internal services are off limits.";

type CredentialRow = { base_url: string; model: string; api_key: string; key_hint: string };

// cryptography's Fernet: AES-128-CBC + HMAC-SHA256 over a version byte, a timestamp and a random IV.
// The 32-byte key is signing half first, encryption half second. Reading the existing llm_credentials
// column depends on every byte of this staying in step with cryptography.fernet.
function fernetEncrypt(key: Buffer, plaintext: Buffer): string {
    const iv = randomBytes(16);
    const stamp = Buffer.alloc(8);
    stamp.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
    const cipher = createCipheriv("aes-128-cbc", key.subarray(16), iv);
    const body = Buffer.concat([Buffer.from([FERNET_VERSION]), stamp, iv, cipher.update(plaintext), cipher.final()]);
    const mac = createHmac("sha256", key.subarray(0, 16)).update(body).digest();
    return Buffer.concat([body, mac]).toString("base64").replaceAll("+", "-").replaceAll("/", "_");
}

// Null is both of byok.py's failure modes: a MAC that does not verify (a rotated key) and a plaintext
// that is not UTF-8, which cryptography hands back and Python's .decode() rejects.
function fernetDecrypt(key: Buffer, token: string): string | null {
    const raw = Buffer.from(token, "base64url");
    if (raw.length < FERNET_OVERHEAD || raw[0] !== FERNET_VERSION) return null;
    const body = raw.subarray(0, raw.length - 32);
    const expected = createHmac("sha256", key.subarray(0, 16)).update(body).digest();
    if (!timingSafeEqual(raw.subarray(raw.length - 32), expected)) return null;
    try {
        const decipher = createDecipheriv("aes-128-cbc", key.subarray(16), body.subarray(9, 25));
        return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat([decipher.update(body.subarray(25)), decipher.final()]));
    } catch {
        return null;
    }
}

let cached: { raw: string; key: Buffer | null } | null = null;

// byok.py's lru_cache: a malformed key logs once per process, not once per request.
function fernet(): Buffer | null {
    const raw = config.byokEncryptionKey;
    if (cached !== null && cached.raw === raw) return cached.key;
    let key: Buffer | null = null;
    if (raw !== "") {
        const decoded = Buffer.from(raw, "base64url");
        if (decoded.length === 32) key = decoded;
        else log.error("byok.encryption_key_invalid");
    }
    cached = { raw, key };
    return key;
}

export function enabled(): boolean {
    return fernet() !== null;
}

// `not is_global`, not `is_private`: 100.64/10 (CGNAT) is private to no one and global to nobody,
// and that is where this deployment's own model lives. Anything not routable from the public
// internet is refused, so a range added here only ever tightens the boundary.
const SPECIAL = new BlockList();
for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
] as const) {
    SPECIAL.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
] as const) {
    SPECIAL.addSubnet(network, prefix, "ipv6");
}

// The URL parser serializes an IPv4-mapped IPv6 host as ::ffff:102:304 (hex groups), and getaddrinfo
// hands one back as ::ffff:1.2.3.4: both forms have to land on the IPv4 the guard classifies.
function mappedIpv4(host: string): string {
    const match = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/i.exec(host);
    if (match === null) return host;
    const [, dotted, high, low] = match;
    if (dotted !== undefined) return dotted;
    const value = (Number.parseInt(high, 16) << 16) | Number.parseInt(low, 16);
    return `${value >>> 24}.${(value >>> 16) & 255}.${(value >>> 8) & 255}.${value & 255}`;
}

function offnet(host: string): boolean {
    const ip = mappedIpv4(host);
    const family = isIP(ip);
    if (family === 0) return false;
    return SPECIAL.check(ip, family === 4 ? "ipv4" : "ipv6");
}

// An unresolvable name is not refused: the call fails at use time anyway, and a save must not hinge
// on this deployment's resolver being up. A timeout lands here too, as OSError did in byok.py.
async function resolveHost(host: string): Promise<string[]> {
    try {
        const timeout = new Promise<never>((_, reject) => {
            setTimeout(() => reject(new Error("dns timeout")), DNS_TIMEOUT_MS).unref();
        });
        const found = await Promise.race([lookup(host, { all: true }), timeout]);
        return found.map((entry) => entry.address);
    } catch {
        return [];
    }
}

function origin(raw: string): [string, number] {
    try {
        const url = new URL(raw);
        const host = mappedIpv4(url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.+$/, ""));
        return [host, url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port)];
    } catch {
        return ["", 0];
    }
}

function sameOrigin(a: string, b: string): boolean {
    const [hostA, portA] = origin(a);
    const [hostB, portB] = origin(b);
    return hostA === hostB && portA === portB;
}

async function assertBaseUrl(raw: string): Promise<string> {
    let url: URL;
    try {
        url = new URL(raw.trim().replace(/\/+$/, ""));
    } catch {
        throw new HttpError(422, BASE_URL_DETAIL);
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
        throw new HttpError(422, BASE_URL_DETAIL);
    }
    // A junk key against our own keyless provider trades the tier cap for the BYOK ceiling.
    const own = llm.SYSTEM_CONFIG;
    if (!llm.isStub(own) && own.api_key === "" && sameOrigin(raw, own.base_url)) {
        throw new HttpError(422, OWN_PROVIDER_DETAIL);
    }
    // AI HERE: resolved at SAVE only, so DNS rebinding gets through, exactly as in byok.py. Closing
    // that needs the address pinned at call time in llm.ts, which this boundary cannot reach.
    if (!config.byokAllowPrivateHosts) {
        const host = url.hostname.replace(/^\[|\]$/g, "");
        if (offnet(host) || (await resolveHost(host)).some(offnet)) throw new HttpError(422, PRIVATE_HOST_DETAIL);
    }
    return `${url.protocol}//${url.host}${url.pathname}`.replace(/\/+$/, "");
}

function assertKey(raw: string): string {
    const key = raw.trim();
    if (key.length < KEY_MIN || key.length > KEY_MAX || /\s/.test(key)) {
        throw new HttpError(422, "That does not look like an API key: 8-500 characters, no spaces.");
    }
    return key;
}

async function credentialRow(ownerId: string): Promise<CredentialRow | undefined> {
    return await fetchrow(sql<CredentialRow[]>`SELECT base_url, model, api_key, key_hint FROM llm_credentials WHERE owner_id = ${ownerId}`);
}

export async function resolveConfig(user: ClerkUser): Promise<llm.LLMConfig> {
    const key = fernet();
    const row = key === null ? undefined : await credentialRow(user.sub);
    if (key === null || row === undefined) return llm.SYSTEM_CONFIG;
    const plaintext = fernetDecrypt(key, row.api_key);
    if (plaintext === null) {
        // Rotated wrong: the stored key is unrecoverable, so the user must re-save.
        log.warning("byok.undecryptable_row");
        return llm.SYSTEM_CONFIG;
    }
    return llm.llmConfig({ base_url: row.base_url, model: row.model, api_key: plaintext, byok: true });
}

export async function save(ownerId: string, baseUrl: string, model: string, apiKey: string): Promise<void> {
    const key = fernet();
    if (key === null) throw new HttpError(503, DISABLED_DETAIL);
    const target = await assertBaseUrl(baseUrl);
    const id = model.trim();
    if (id === "") throw new HttpError(422, "A model id is required.");
    let cipher: string;
    let hint: string;
    if (apiKey !== "") {
        const value = assertKey(apiKey);
        cipher = fernetEncrypt(key, Buffer.from(value));
        hint = value.slice(-4);
    } else {
        // Empty is legitimate on a first save: self-hosted endpoints authenticate nothing.
        const existing = await credentialRow(ownerId);
        cipher = existing === undefined ? fernetEncrypt(key, Buffer.alloc(0)) : existing.api_key;
        hint = existing?.key_hint ?? "";
    }
    await fetchrow(sql`
        INSERT INTO llm_credentials (owner_id, base_url, model, api_key, key_hint, updated_at) VALUES (${ownerId}, ${target}, ${id}, ${cipher}, ${hint}, now())
        ON CONFLICT (owner_id) DO UPDATE SET base_url = EXCLUDED.base_url, model = EXCLUDED.model, api_key = EXCLUDED.api_key, key_hint = EXCLUDED.key_hint, updated_at = now()
        `);
}

export async function clear(ownerId: string): Promise<void> {
    await fetchrow(sql`DELETE FROM llm_credentials WHERE owner_id = ${ownerId} RETURNING owner_id`);
}

export async function publicView(user: ClerkUser): Promise<LLMProvider> {
    const row = fernet() === null ? undefined : await credentialRow(user.sub);
    const system = llm.SYSTEM_CONFIG;
    return {
        enabled: enabled(),
        byok: row !== undefined,
        base_url: row?.base_url ?? "",
        model: row?.model ?? "",
        key_hint: row?.key_hint || null,
        system: { configured: !llm.isStub(system), base_url: system.base_url, model: system.model },
    };
}

export async function test(user: ClerkUser): Promise<{ ok: boolean; detail: string }> {
    const current = await resolveConfig(user);
    if (!current.byok) throw new HttpError(400, "Save a provider first - there is nothing to test.");
    const [ok, detail] = await llm.testProvider(current);
    return { ok, detail };
}

// cryptography.fernet wrote this token for the key below: rows already in llm_credentials stay
// readable only while the layout above does. The empty-string case is what a keyless save stores.
const PYTHON_KEY = Buffer.from("a0AEmNn56dRHMlcSpFRNSkN4QjDI4D8hV9J9bEyLA2A=", "base64url");
const PYTHON_TOKEN = "gAAAAABq-HVz548nX7dt7F2XZKX0YeNzaLApYeDRWw322JkMAqSki7AcpImQFenCfXDaoolFVT6Dhpcf9jCjz7WIcAHwXwUsWcTs3q7ff1KI6McpDoCvi50=";

if (fernetDecrypt(PYTHON_KEY, PYTHON_TOKEN) !== "sk-python-written-key" || fernetDecrypt(PYTHON_KEY, fernetEncrypt(PYTHON_KEY, Buffer.alloc(0))) !== "") {
    throw new Error("byok cipher is not the Fernet format cryptography wrote");
}

for (const host of ["100.64.2.2", "10.1.2.3", "172.16.5.5", "192.168.1.10", "127.0.0.1", "169.254.169.254", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:100.64.2.2"]) {
    if (!offnet(host)) throw new Error(`byok private-host guard does not refuse ${host}`);
}
for (const host of ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:102:304", "api.deepseek.com"]) {
    if (offnet(host)) throw new Error(`byok private-host guard refuses the public ${host}`);
}
