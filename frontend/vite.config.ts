import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    plugins: [react(), tailwindcss()],
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
