import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    plugins: [react(), tailwindcss()],
    // Sentry tree shaking (Sentry docs: platforms/javascript/configuration/tree-shaking). The SDK is
    // lazily imported, so this only trims the chunk that loads after first paint — but without these
    // it carries debug statements and tracing support this app never calls.
    define: {
        __SENTRY_DEBUG__: false,
        __SENTRY_TRACING__: false,
        __RRWEB_EXCLUDE_IFRAME__: true,
        __RRWEB_EXCLUDE_SHADOW_DOM__: true,
    },
    // No `build.sourcemap`: maps are never generated, so they can never be uploaded or served. Sentry
    // stacks are minified as a result — an accepted trade for never publishing source from nginx.
    resolve: {
        alias: {
            "@": path.resolve(dirname, "./src"),
        },
    },
    server: {
        proxy: {
            // The app owns the /api prefix (backend `API_PREFIX`) and forwards the path unchanged.
            // Dev-server convenience only: prod routes /api at the ingress straight to the backend.
            "/api": "http://backend:8000",
        },
    },
});
