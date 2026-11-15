import { afterEach } from "vitest";

export type Call = { method: string; url: string; headers: Headers; body: string };

type Responder = (call: Call) => Response | Promise<Response>;

export type HttpStub = {
    /** Responds to every matching call with the same reply, or drains the list and fails when it runs out. */
    on: (method: string, url: string, responder: Responder | Responder[]) => void;
    post: (url: string, responder: Responder | Responder[]) => void;
    calls: Call[];
    restore: () => void;
};

type Route = { method: string; url: string; queue: Responder[]; drain: boolean };

const installed: HttpStub[] = [];

// Registered at import, so the fetch a stub replaces cannot outlive the test that installed it.
afterEach(() => {
    for (const stub of installed.splice(0).reverse()) stub.restore();
});

/**
 * respx for `fetch`: llm.ts, auth.ts and voice.ts all reach the network through globalThis.fetch.
 * An unmatched call throws by name rather than hitting the network, as respx does.
 */
export function stubHttp(): HttpStub {
    const original = globalThis.fetch;
    const routes: Route[] = [];
    const calls: Call[] = [];
    let restored = false;

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        const method = (init?.method ?? "GET").toUpperCase();
        const call: Call = {
            method,
            url,
            headers: new Headers(init?.headers),
            body: typeof init?.body === "string" ? init.body : "",
        };
        calls.push(call);
        const route = routes.find((candidate) => candidate.method === method && candidate.url === url);
        const responder = route === undefined ? undefined : route.drain ? route.queue.shift() : route.queue[0];
        if (responder === undefined) {
            throw new Error(route === undefined ? `unstubbed ${method} ${url}` : `no stubbed response left for ${method} ${url}`);
        }
        return await responder(call);
    };

    const stub: HttpStub = {
        on: (method, url, responder) => {
            routes.push({ method: method.toUpperCase(), url, queue: Array.isArray(responder) ? [...responder] : [responder], drain: Array.isArray(responder) });
        },
        post: (url, responder) => stub.on("POST", url, responder),
        calls,
        restore: () => {
            if (restored) return;
            restored = true;
            globalThis.fetch = original;
        },
    };
    installed.push(stub);
    return stub;
}

export function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** The chat path reads deltas off `data:` lines, so the stub has to stream rather than hand back a string. */
export function sse(deltas: string[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const delta of deltas) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`));
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
        },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}
