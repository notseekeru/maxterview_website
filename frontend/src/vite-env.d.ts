/// <reference types="vite/client" />

interface ImportMetaEnv {
    readonly VITE_API_BASE: string;
    readonly VITE_CLERK_PUBLISHABLE_KEY: string;
    /** Absent in dev: with no DSN, src/lib/sentry.ts is a no-op. */
    readonly VITE_SENTRY_DSN?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
