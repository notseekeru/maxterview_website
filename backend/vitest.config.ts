import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        // Both have to beat the first src/ import, and both are per test file: files run in parallel, so a
        // shared throwaway DB would let one file's rows answer another file's count assertions.
        setupFiles: ["tests/helpers/db.ts", "tests/helpers/env.ts"],
    },
});
