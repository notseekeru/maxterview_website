// Runtime config. `clerkEnabled` is true ONLY when a real publishable key (pk_…) is present —
// a non-empty key that isn't pk_ (e.g. a stray secret pasted in) does NOT count and keeps the
// app in no-auth/dev mode + raises the misconfig banner. Delegates to authHealth.ts so the
// shape check is the single source of truth across main.tsx / api.ts / the shell.
import { clerkEnabled, clerkPublishableKey } from "./authHealth";

export { clerkEnabled, clerkPublishableKey };

// The opening line shown at the top of a fresh interview thread (mock-interview coach
// kicks off by asking for the resume / background). Env-overridable per deployment:
//   VITE_OPENING_ASKS_RESUME="<text>"  -> custom opening
//   VITE_OPENING_ASKS_RESUME=""        -> hide the opening entirely
const envOpening = import.meta.env.VITE_OPENING_ASKS_RESUME as string | undefined;
export const OPENING_ASKS_RESUME = envOpening === "" ? "" : (envOpening ?? "Before we begin — could you share your resume / background so I can interview you specifically on it?");
