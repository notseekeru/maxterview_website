import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context, MiddlewareHandler } from "hono";
import { config } from "./env.ts";

const EXEMPT = new Set(["/api/health", "/api/billing/webhook"]);
const UNITS: Record<string, number> = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000, month: 2_592_000_000, year: 31_536_000_000 };

type FixedWindow = { amount: number; windowMs: number };

function parseSpec(spec: string): FixedWindow {
    const match = /^(\d+)\s*\/\s*(\d*)\s*([a-z]+)s?$/.exec(spec);
    const unit = match === null ? undefined : UNITS[match[3]];
    if (match === null || unit === undefined || Number(match[1]) < 1) throw new Error(`RATE_LIMIT is not a rate: ${spec}`);
    return { amount: Number(match[1]), windowMs: unit * Math.max(Number(match[2]), 1) };
}

function enabled(): boolean {
    return config.rateLimit !== "" && config.rateLimit.toLowerCase() !== "off";
}

let parsed: { spec: string; limit: FixedWindow } | null = null;

function limit(): FixedWindow {
    const spec = config.rateLimit;
    if (parsed?.spec !== spec) parsed = { spec, limit: parseSpec(spec) };
    return parsed.limit;
}

// Fail at boot on a typo, rather than 500 on the first request.
if (enabled()) parseSpec(config.rateLimit);

// AI HERE: fixed windows live in this process, so N replicas grant N× the budget. Upgrade path when the
// app stops being a single pod: back the same counter with Redis.
let window: { spec: string; index: number; counts: Map<string, number> } = { spec: "", index: 0, counts: new Map() };

function hit(spec: string, specLimit: FixedWindow, key: string): boolean {
    const index = Math.floor(Date.now() / specLimit.windowMs);
    if (window.spec !== spec || window.index !== index) window = { spec, index, counts: new Map() };
    const count = window.counts.get(key) ?? 0;
    if (count >= specLimit.amount) return false;
    window.counts.set(key, count + 1);
    return true;
}

function clientKey(c: Context): string {
    const forwarded = c.req.header("x-forwarded-for") ?? "";
    if (forwarded !== "") return forwarded.slice(forwarded.lastIndexOf(",") + 1).trim();
    try {
        return getConnInfo(c).remote.address ?? "unknown";
    } catch {
        return "unknown";
    }
}

export const rateLimit: MiddlewareHandler = async (c, next) => {
    if (enabled() && !EXEMPT.has(c.req.path) && !hit(config.rateLimit, limit(), clientKey(c))) {
        return c.json({ detail: "Too many requests. Slow down and retry in a moment." }, 429, { "Retry-After": "60" });
    }
    await next();
};
