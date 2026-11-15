import { config, type Config } from "../../src/env.ts";

/**
 * The shared config is one mutable object, so a patch has to be undone or the next test inherits it.
 * Every key is restored, not just the patched ones: a body that writes config directly still leaves
 * the object as it found it.
 */
export async function withConfig<T>(patch: Partial<Config>, body: () => T | Promise<T>): Promise<T> {
    const saved = { ...config };
    Object.assign(config, patch);
    try {
        return await body();
    } finally {
        Object.assign(config, saved);
    }
}
