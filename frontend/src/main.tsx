import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { initErrorBeacon } from "./lib/errorBeacon.ts";

// No ClerkProvider here on purpose: the public landing route must not download the auth SDK.
// The provider lives in the lazy <ClerkGate> (see App.tsx).
const rootElement = document.getElementById("root");

if (!rootElement) {
    throw new Error("Failed to find the root element");
}

createRoot(rootElement).render(
    <StrictMode>
        <App />
    </StrictMode>,
);

initErrorBeacon();
