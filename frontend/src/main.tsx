import { ClerkProvider } from "@clerk/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;

if (!clerkKey) {
    throw new Error("VITE_CLERK_PUBLISHABLE_KEY is required in frontend/.env");
}

const rootElement = document.getElementById("root");

if (!rootElement) {
    throw new Error("Failed to find the root element");
}

createRoot(rootElement).render(
    <StrictMode>
        <ClerkProvider publishableKey={clerkKey}>
            <App />
        </ClerkProvider>
    </StrictMode>,
);
