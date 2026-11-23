import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import * as byok from "../src/byok.ts";
import { fetchrow, sql } from "../src/db.ts";
import * as llm from "../src/llm.ts";
import { ClerkUser } from "../src/models.ts";
import { withConfig } from "./helpers/config.ts";
import { json, stubHttp } from "./helpers/http.ts";

// byok.py's tests patched byok._resolve, which an ESM import cannot do. The resolver is a module seam
// here: answers are per host, and a name with no entry resolves to nothing, which is the NXDOMAIN
// byok.py's stub returned too. Nothing leaves the process, so a host with no network answers the same.
const dns = vi.hoisted(() => ({ answers: new Map<string, string[]>() }));
vi.mock("node:dns/promises", () => ({
    lookup: async (host: string) => (dns.answers.get(host) ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
}));

type Row = { base_url: string; model: string; api_key: string; key_hint: string };

const user = (sub: string) => ClerkUser.parse({ sub });
const stored = (ownerId: string) => fetchrow(sql<Row[]>`SELECT base_url, model, api_key, key_hint FROM llm_credentials WHERE owner_id = ${ownerId}`);

// conftest.py's encryption_key fixture: a fresh Fernet key per test, restored after it.
const withFreshKey = <T>(body: () => T | Promise<T>): Promise<T> => withConfig({ byokEncryptionKey: randomBytes(32).toString("base64url") }, body);

async function withSystemProvider<T>(provider: Pick<Row, "base_url"> & { model: string; api_key: string }, body: () => Promise<T>): Promise<T> {
    const saved = { ...llm.SYSTEM_CONFIG };
    Object.assign(llm.SYSTEM_CONFIG, provider);
    try {
        return await body();
    } finally {
        Object.assign(llm.SYSTEM_CONFIG, saved);
    }
}

describe("byok", () => {
    it("save stores ciphertext and only a hint", async () => {
        const key = "sk-test-abcdefgh-1234";
        await withFreshKey(async () => {
            await byok.save("user_byok_cipher", "https://api.openai.com/v1/", "gpt-4o-mini", key);
            const row = await stored("user_byok_cipher");

            expect([row?.base_url, row?.model]).toEqual(["https://api.openai.com/v1", "gpt-4o-mini"]);
            expect(row?.api_key).not.toBe(key);
            expect(row?.api_key).not.toContain(key);
            // the column decrypts back to the key through the same cipher the read path uses
            expect((await byok.resolveConfig(user("user_byok_cipher"))).api_key).toBe(key);
            expect(row?.key_hint).toBe("1234");
        });
    });

    // `not is_global`, not `is_private`: 100.64/10 (CGNAT, i.e. Tailscale) is private to no one and
    // global to nobody, and that is where this deployment's own model lives. A regressed predicate
    // reopens the free ride and the network probe at once.
    it("offnet predicate covers cgnat and internal ranges", () => {
        for (const host of ["100.64.0.1", "100.64.0.2", "10.1.2.3", "172.16.5.5", "192.168.1.10", "127.0.0.1", "169.254.169.254", "::1", "fd00::1", "::ffff:100.64.0.1", "0.0.0.0"]) {
            expect(byok.offnet(host), host).toBe(true);
        }
        for (const host of ["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "api.deepseek.com"]) {
            expect(byok.offnet(host), host).toBe(false);
        }
    });

    // The BACKEND is the one making the request, so a private base_url is a probe into (and a free
    // ride on) this deployment's own network - the tailnet, the LAN, the k8s API, node metadata. On a
    // hosted deployment `localhost` means the pod, not the user's laptop; a single-operator fork that
    // really does run Ollama on that box flips BYOK_ALLOW_PRIVATE_HOSTS.
    it("private endpoints are refused unless the deployment opts in", async () => {
        dns.answers.set("localhost", ["127.0.0.1", "::1"]);
        await withFreshKey(async () => {
            const refused = byok.save("user_byok_private", "http://localhost:11434/v1", "qwen3:8b", "");
            await expect(refused).rejects.toMatchObject({ status: 422 });
            await expect(refused).rejects.toThrow("inside a private network");
            expect(await stored("user_byok_private")).toBeUndefined(); // refused before the write

            await withConfig({ byokAllowPrivateHosts: true }, () => byok.save("user_byok_private", "http://localhost:11434/v1", "qwen3:8b", ""));
            expect((await stored("user_byok_private"))?.base_url).toBe("http://localhost:11434/v1");
        });
    });

    // `evil.example A 100.64.0.1` is one DNS record away, so the check has to run on what the name
    // resolves to and not only on IP literals.
    it("a name pointing into the network is refused", async () => {
        dns.answers.set("llama.internal", ["100.64.0.1"]);
        await withFreshKey(async () => {
            const refused = byok.save("user_byok_named", "http://llama.internal:8080/v1", "qwen", "");
            await expect(refused).rejects.toMatchObject({ status: 422 });
            await expect(refused).rejects.toThrow("inside a private network");
            expect(await stored("user_byok_named")).toBeUndefined();
        });
    });

    // An unresolvable name is allowed: the call fails at use time anyway, and a save must not hinge on
    // this deployment's resolver being up (a transient lookup failure would lock the user out).
    it("a name that does not resolve is not refused", async () => {
        await withFreshKey(async () => {
            await byok.save("user_byok_unresolved", "https://api.example.com/v1", "m", "");
            expect((await stored("user_byok_unresolved"))?.base_url).toBe("https://api.example.com/v1");
        });
    });

    // Keyless system provider (a self-hosted model): BYOK pointed back at it with a junk key is a free
    // ride at the higher BYOK ceiling. Keyed system provider (the documented managed swap): no free
    // ride exists, so the same origin must stay saveable - it is how an owner brings THEIR key for the
    // provider this deployment happens to pay for.
    it("the deployment's own provider is refused only while it needs no key", async () => {
        await withFreshKey(async () => {
            await withSystemProvider({ base_url: "http://93.184.216.34:8080/v1", model: "qwen", api_key: "" }, async () => {
                const refused = byok.save("user_byok_own", "http://93.184.216.34:8080/v1", "qwen", "sk-junk-key-1234");
                await expect(refused).rejects.toMatchObject({ status: 422 });
                await expect(refused).rejects.toThrow("own provider");
            });
            await withSystemProvider({ base_url: "https://9.9.9.9/v1", model: "managed", api_key: "sk-deployment-key" }, async () => {
                await byok.save("user_byok_own", "https://9.9.9.9/v1", "managed", "sk-own-key-1234");
            });
            expect((await stored("user_byok_own"))?.base_url).toBe("https://9.9.9.9/v1");
        });
    });

    it("update without a key reuses the stored ciphertext", async () => {
        const ownerId = "user_byok_update";
        await withFreshKey(async () => {
            await fetchrow(sql`INSERT INTO llm_credentials (owner_id, base_url, model, api_key, key_hint) VALUES (${ownerId}, ${"https://old"}, ${"old"}, ${"cipher-old"}, ${"9999"})`);
            await byok.save(ownerId, "https://api.deepseek.com", "deepseek-chat", "");

            const row = await stored(ownerId);
            expect([row?.base_url, row?.model]).toEqual(["https://api.deepseek.com", "deepseek-chat"]); // target moved
            expect([row?.api_key, row?.key_hint]).toEqual(["cipher-old", "9999"]); // key untouched
        });
    });

    // Self-hosted BYOK (Ollama/llama.cpp/vLLM): no key exists, and none is required. Stored as the
    // encrypted empty string so "empty = keep the key" stays one uniform rule. The endpoint is a
    // PUBLIC one: a private address is refused by default, see the ALLOW_PRIVATE_HOSTS test above.
    it("first save without a key is a keyless row", async () => {
        await withFreshKey(async () => {
            await byok.save("user_byok_keyless", "http://93.184.216.34:11434/v1", "qwen3:8b", "");

            const row = await stored("user_byok_keyless");
            expect(row?.api_key).not.toBe(""); // still ciphertext, not a bare empty string
            expect((await byok.resolveConfig(user("user_byok_keyless"))).api_key).toBe("");
            expect(row?.key_hint).toBe("");
        });
    });

    it("keyless row resolves without an authorization header", async () => {
        const ownerId = "user_byok_headerless";
        await withFreshKey(async () => {
            // save() would refuse this address, so the row is written public and moved afterwards.
            await byok.save(ownerId, "http://93.184.216.34:11434/v1", "qwen3:8b", "");
            await fetchrow(sql`UPDATE llm_credentials SET base_url = ${"http://192.168.1.9:8080/v1"}, model = ${"qwen"} WHERE owner_id = ${ownerId}`);

            const config = await byok.resolveConfig(user(ownerId));
            expect([config.byok, config.api_key]).toEqual([true, ""]);

            const stub = stubHttp();
            stub.post("http://192.168.1.9:8080/v1/chat/completions", () => json({ choices: [{ message: { content: "pong" } }] }));
            expect((await llm.testProvider(config))[0]).toBe(true);
            expect(stub.calls[0].headers.get("authorization")).toBeNull(); // no key means no Authorization header at all
            expect((await byok.publicView(user(ownerId))).key_hint).toBeNull();
        });
    });

    it.each([
        { url: "ftp://api.openai.com", model: "gpt-4o-mini", key: "sk-test-abcdefgh" }, // not http(s)
        { url: "api.openai.com/v1", model: "gpt-4o-mini", key: "sk-test-abcdefgh" }, // no scheme/host
        { url: "https://user:pw@api.openai.com/v1", model: "gpt-4o-mini", key: "sk-test-abcdefgh" }, // credentials in URL
        { url: "https://api.openai.com/v1?x=1", model: "gpt-4o-mini", key: "sk-test-abcdefgh" }, // query
        { url: "https://api.openai.com/v1", model: "", key: "sk-test-abcdefgh" }, // no model
        { url: "https://api.openai.com/v1", model: "gpt-4o-mini", key: "short" }, // key floor
        { url: "https://api.openai.com/v1", model: "gpt-4o-mini", key: "sk-two words" }, // key must be header-safe
    ])("save rejects malformed input $url $model $key", async ({ url, model, key }) => {
        await withFreshKey(async () => {
            await expect(byok.save("user_byok_malformed", url, model, key)).rejects.toMatchObject({ status: 422 });
        });
    });

    it("save is unavailable without an encryption key", async () => {
        await withConfig({ byokEncryptionKey: "" }, async () => {
            await expect(byok.save("user_byok_nokey", "https://api.openai.com/v1", "gpt-4o-mini", "sk-test-abcdefgh")).rejects.toMatchObject({ status: 503 });
            expect(byok.enabled()).toBe(false);
        });
    });

    it("save is unavailable when the encryption key is malformed", async () => {
        await withConfig({ byokEncryptionKey: "not-a-fernet-key" }, async () => {
            expect(byok.enabled()).toBe(false); // fail closed; the app still boots
        });
    });

    it("resolve falls back to the system default without a row", async () => {
        await withFreshKey(async () => {
            expect(await byok.resolveConfig(user("user_byok_norow"))).toBe(llm.SYSTEM_CONFIG);
        });
    });

    // A rotated BYOK_ENCRYPTION_KEY: interviews keep working on the system provider.
    it("resolve falls back when the ciphertext cannot be decrypted", async () => {
        const ownerId = "user_byok_rotated";
        await withFreshKey(() => byok.save(ownerId, "https://api.openai.com/v1", "gpt-4o-mini", "sk-lost-key"));
        await withFreshKey(async () => {
            expect(await byok.resolveConfig(user(ownerId))).toBe(llm.SYSTEM_CONFIG);
        });
    });

    // One provider for both stages: the grader falls back to the owner's target, key included.
    it("resolve returns the owner's config and derives the grader", async () => {
        const key = "sk-test-abcdefgh";
        await withFreshKey(async () => {
            await byok.save("user_byok_owner", "https://openrouter.ai/api/v1", "openai/gpt-4o-mini", key);

            const config = await byok.resolveConfig(user("user_byok_owner"));
            expect([config.base_url, config.model, config.api_key, config.byok]).toEqual(["https://openrouter.ai/api/v1", "openai/gpt-4o-mini", key, true]);
            expect(llm.graderConfig(config)).toEqual(config);
        });
    });

    it("public view never returns the key", async () => {
        const key = "sk-test-abcdefgh";
        await withFreshKey(async () => {
            await byok.save("user_byok_view", "https://api.openai.com/v1", "gpt-4o-mini", key);

            const view = await byok.publicView(user("user_byok_view"));
            expect([view.byok, view.key_hint]).toEqual([true, "efgh"]);
            expect(view).not.toHaveProperty("api_key");
            expect(JSON.stringify(view)).not.toContain(key); // not even in a nested field added later
        });
    });

    it("clear deletes the row", async () => {
        await withFreshKey(async () => {
            await byok.save("user_byok_clear", "https://api.openai.com/v1", "gpt-4o-mini", "sk-test-abcdefgh");
            await byok.clear("user_byok_clear");
            expect(await stored("user_byok_clear")).toBeUndefined();
        });
    });

    it("probe reports success and sends the key", async () => {
        const stub = stubHttp();
        stub.post("https://api.openai.com/v1/chat/completions", () => json({ choices: [{ message: { content: "pong" } }] }));

        const [ok, detail] = await llm.testProvider(llm.llmConfig({ base_url: "https://api.openai.com/v1", model: "gpt-4o-mini", api_key: "sk-test-abcdefgh" }));
        expect(ok).toBe(true);
        expect(detail).toContain("gpt-4o-mini");
        expect(stub.calls[0].headers.get("authorization")).toBe("Bearer sk-test-abcdefgh");
    });

    // The provider body is untrusted: it can echo the request, and the request carries the key.
    it("probe never echoes the body or the key", async () => {
        const stub = stubHttp();
        stub.post("https://api.openai.com/v1/chat/completions", () => json({ error: { message: "invalid key sk-test-abcdefgh" } }, 401));

        const [ok, detail] = await llm.testProvider(llm.llmConfig({ base_url: "https://api.openai.com/v1", model: "gpt-4o-mini", api_key: "sk-test-abcdefgh" }));
        expect(ok).toBe(false);
        expect(detail).toContain("401");
        expect(detail).not.toContain("sk-test-abcdefgh");
    });

    it("test endpoint refuses to probe without a saved provider", async () => {
        await withFreshKey(async () => {
            await expect(byok.test(user("user_byok_probe"))).rejects.toMatchObject({ status: 400 });
        });
    });
});
