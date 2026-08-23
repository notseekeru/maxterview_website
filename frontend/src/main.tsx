import { ClerkProvider } from "@clerk/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { clerkEnabled, clerkPublishableKey } from "./lib/config.ts";
import "./index.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
    throw new Error("Failed to find the root element");
}

createRoot(rootElement).render(
    <StrictMode>
        {clerkEnabled ? (
            <ClerkProvider publishableKey={clerkPublishableKey}>
                <App />
            </ClerkProvider>
        ) : (
            // No Clerk key -> dev/no-auth mode (backed by the backend's DEV_USER).
            // Matches the documented CLERK_ENABLED=false dev fallback.
            <App />
        )}
    </StrictMode>,
);
