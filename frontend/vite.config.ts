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
            "/api": {
                target: "http://backend:8000",
                // Backend routes are at root (/interviews), not under /api.
                rewrite: (path) => path.replace(/^\/api/, ""),
            },
        },
    },
});
