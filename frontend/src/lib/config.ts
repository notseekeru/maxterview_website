// `clerkEnabled` is true only for a real pk_ key: a non-empty key that is not one keeps the app in
// no-auth/dev mode and raises the misconfig banner. authHealth.ts owns the check.
import { clerkEnabled, clerkPublishableKey } from "./authHealth";

export { clerkEnabled, clerkPublishableKey };
