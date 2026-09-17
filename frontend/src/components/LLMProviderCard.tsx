import { useCallback, useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { apiDetail, clearLLMProvider, getLLMProvider, type LLMProviderStatus, saveLLMProvider, testLLMProvider } from "@/lib/api";

// Presets only fill the base URL + a known-good model id; both fields stay editable, so any
// OpenAI-compatible endpoint works (the API shape is the contract, not this list).
const PRESETS = [
    { label: "OpenAI", base_url: "https://api.openai.com/v1", model: "gpt-4o-mini" },
    { label: "DeepSeek", base_url: "https://api.deepseek.com", model: "deepseek-chat" },
    { label: "OpenRouter", base_url: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini" },
    { label: "Ollama", base_url: "http://localhost:11434/v1", model: "qwen3:8b" },
];

// BYOK: run your interviews on your own provider account (backend app/byok.py, BYOK.md).
// The key is sent once, stored encrypted, and never returned — only its last 4 characters.
export function LLMProviderCard() {
    const [status, setStatus] = useState<LLMProviderStatus | null>(null);
    const [baseUrl, setBaseUrl] = useState("");
    const [model, setModel] = useState("");
    const [apiKey, setApiKey] = useState("");
    const [busy, setBusy] = useState<"save" | "test" | "clear" | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const apply = useCallback((s: LLMProviderStatus) => {
        setStatus(s);
        // Prefill with the SAVED provider only. The system default is not a valid BYOK target (the
        // backend refuses its origin), so seeding the form with it only guarantees a 422 on save.
        setBaseUrl(s.byok ? s.base_url : "");
        setModel(s.byok ? s.model : "");
    }, []);

    const load = useCallback(async () => {
        try {
            apply(await getLLMProvider());
        } catch (e) {
            setError(apiDetail(e, "Could not read your provider settings."));
        }
    }, [apply]);

    useEffect(() => {
        void load();
    }, [load]);

    async function run(kind: "save" | "test" | "clear", action: () => Promise<string>) {
        setBusy(kind);
        setNote(null);
        setError(null);
        try {
            setNote(await action());
        } catch (e) {
            setError(apiDetail(e, "Something went wrong. Try again."));
        } finally {
            setBusy(null);
        }
    }

    const save = () =>
        run("save", async () => {
            const next = await saveLLMProvider({ base_url: baseUrl.trim(), model: model.trim(), api_key: apiKey.trim() || undefined });
            apply(next);
            setApiKey("");
            return "Saved. Your interviews now run on this provider.";
        });

    const test = () =>
        run("test", async () => {
            const { ok, detail } = await testLLMProvider();
            return `${ok ? "✓" : "✗"} ${detail}`;
        });

    const clear = () =>
        run("clear", async () => {
            await clearLLMProvider();
            const next = await getLLMProvider();
            apply(next);
            setApiKey("");
            return "Key removed. You are back on the system default.";
        });

    const disabled = !status?.enabled;
    // A key is optional: an empty field keeps the saved key, and a keyless save is how self-hosted
    // endpoints (Ollama, llama.cpp, vLLM) are configured.
    const canSave = !disabled && Boolean(baseUrl.trim()) && Boolean(model.trim());

    return (
        <Card>
            <CardHeader className="flex-row items-start justify-between space-y-0">
                <div>
                    <CardTitle>Interview engine (BYOK)</CardTitle>
                    <CardDescription className="mt-1">Bring your own key: any OpenAI-compatible provider — used for your interviews, scoring and feedback. Self-hosted endpoints (Ollama, llama.cpp) need no key at all; a saved key is stored encrypted and never shown again.</CardDescription>
                </div>
                {status && <Badge variant={status.byok ? "default" : "outline"}>{status.byok ? "Your key" : "System default"}</Badge>}
            </CardHeader>

            {disabled ? (
                // The form is unusable without the deployment key; say so instead of failing on save.
                <CardFooter>
                    <p className="text-sm text-muted-foreground">
                        BYOK is turned off on this deployment: the backend has no <code className="font-mono text-xs">BYOK_ENCRYPTION_KEY</code>. Interviews use the system provider.
                    </p>
                </CardFooter>
            ) : (
                <CardFooter className="flex flex-col items-stretch gap-4">
                    {status?.byok && (
                        <p className="text-sm text-muted-foreground">
                            Using <span className="font-medium text-foreground">{status.model}</span> at {status.base_url}
                            {status.key_hint ? ` · key ending ${status.key_hint}` : " · no API key (self-hosted)"}
                        </p>
                    )}
                    {!status?.byok && status?.system.configured && (
                        <p className="text-sm text-muted-foreground">
                            System default: {status.system.model} at {status.system.base_url}. The daily chat-turn limit applies to it.
                        </p>
                    )}

                    <div className="flex flex-wrap gap-2">
                        {PRESETS.map((p) => (
                            <Button
                                key={p.label}
                                type="button"
                                variant="outline"
                                size="sm"
                                onClick={() => {
                                    setBaseUrl(p.base_url);
                                    setModel(p.model);
                                }}
                            >
                                {p.label}
                            </Button>
                        ))}
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2">
                        <label htmlFor="llm-base-url" className="flex flex-col gap-1 text-sm">
                            <span className="text-muted-foreground">Base URL</span>
                            <Input id="llm-base-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.openai.com/v1" spellCheck={false} />
                        </label>
                        <label htmlFor="llm-model" className="flex flex-col gap-1 text-sm">
                            <span className="text-muted-foreground">Model</span>
                            <Input id="llm-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="gpt-4o-mini" spellCheck={false} />
                        </label>
                    </div>

                    <label htmlFor="llm-api-key" className="flex flex-col gap-1 text-sm">
                        <span className="text-muted-foreground">API key</span>
                        <Input id="llm-api-key" type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={status?.byok && status.key_hint ? "Leave blank to keep the saved key" : "sk-… (optional: Ollama, llama.cpp, vLLM need none)"} spellCheck={false} />
                    </label>

                    <div className="flex flex-wrap items-center gap-3">
                        <Button type="button" size="sm" onClick={() => void save()} disabled={busy !== null || !canSave}>
                            {busy === "save" ? "Saving…" : "Save"}
                        </Button>
                        <Button type="button" variant="outline" size="sm" onClick={() => void test()} disabled={busy !== null || !status?.byok}>
                            {busy === "test" ? "Testing…" : "Test connection"}
                        </Button>
                        {status?.byok && (
                            <Button type="button" variant="ghost" size="sm" onClick={() => void clear()} disabled={busy !== null}>
                                {busy === "clear" ? "Removing…" : "Remove key"}
                            </Button>
                        )}
                    </div>

                    {note && <p className="text-sm text-muted-foreground">{note}</p>}
                    {error && <p className="text-sm text-destructive">{error}</p>}
                </CardFooter>
            )}
        </Card>
    );
}
