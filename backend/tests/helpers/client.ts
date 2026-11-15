import { app } from "../../src/app.ts";

export type FilePart = { name: string; data: Uint8Array | string; type?: string };

export type RequestOptions = {
    json?: unknown;
    body?: string;
    headers?: Record<string, string>;
    files?: Record<string, FilePart>;
};

// The body is read once here: httpx's Response parses as often as a test asks.
export type TestResponse = {
    status: number;
    headers: Headers;
    json: <T = unknown>() => Promise<T>;
    text: () => Promise<string>;
};

async function send(method: string, path: string, options: RequestOptions = {}): Promise<TestResponse> {
    const headers = new Headers(options.headers);
    let body: RequestInit["body"];
    if (options.files !== undefined) {
        const form = new FormData();
        for (const [field, part] of Object.entries(options.files)) {
            const bytes = typeof part.data === "string" ? part.data : Uint8Array.from(part.data);
            form.append(field, new Blob([bytes], { type: part.type ?? "application/octet-stream" }), part.name);
        }
        body = form;
    } else if (options.json !== undefined) {
        headers.set("content-type", "application/json");
        body = JSON.stringify(options.json);
    } else if (options.body !== undefined) {
        body = options.body;
    }
    const response = await app.request(path, { method, headers, body });
    const text = await response.text();
    return {
        status: response.status,
        headers: response.headers,
        json: async <T>() => JSON.parse(text) as T,
        text: async () => text,
    };
}

/** TestClient's verbs, driving the real Hono app in-process: no socket, no port, no server. */
export const client = {
    get: (path: string, options?: RequestOptions) => send("GET", path, options),
    post: (path: string, options?: RequestOptions) => send("POST", path, options),
    put: (path: string, options?: RequestOptions) => send("PUT", path, options),
    delete: (path: string, options?: RequestOptions) => send("DELETE", path, options),
    options: (path: string, options?: RequestOptions) => send("OPTIONS", path, options),
};
