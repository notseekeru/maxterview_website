// Runtime config. `clerkEnabled` is true ONLY when a real publishable key (pk_…) is present —
// a non-empty key that isn't pk_ (e.g. a stray secret pasted in) does NOT count and keeps the
// app in no-auth/dev mode + raises the misconfig banner. Delegates to authHealth.ts so the
// shape check is the single source of truth across main.tsx / api.ts / the shell.
import { clerkEnabled, clerkPublishableKey } from "./authHealth";

export { clerkEnabled, clerkPublishableKey };
