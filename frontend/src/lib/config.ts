// Runtime config. `clerkEnabled` is true only when a publishable key is present.
// Matches the backend's CLERK_ENABLED=false -> DEV_USER fallback (no-auth dev mode).
const embeddedKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

export const clerkEnabled = Boolean(embeddedKey);
export const clerkPublishableKey = embeddedKey ?? "";
