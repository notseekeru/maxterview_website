// Runtime config. `clerkEnabled` is true only when a publishable key is present.
// Matches the backend's CLERK_ENABLED=false -> DEV_USER fallback (no-auth dev mode).
const embeddedKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

export const clerkEnabled = Boolean(embeddedKey);
export const clerkPublishableKey = embeddedKey ?? "";

// The opening line shown at the top of a fresh interview thread. The interviewer is a
// mock-interview coach, so we kick off by asking the candidate to share their resume /
// background (the "first starting tool"). Exposed as a variable so it is easy to reword
// or disable per-deployment; an env override keeps it reusable and scalable:
//   VITE_OPENING_ASKS_RESUME="<text>"  -> custom opening
//   VITE_OPENING_ASKS_RESUME=""        -> hide the opening entirely
const envOpening = import.meta.env.VITE_OPENING_ASKS_RESUME as string | undefined;
export const OPENING_ASKS_RESUME = envOpening === "" ? "" : (envOpening ?? "Before we begin — could you share your resume / background so I can interview you specifically on it?");
