import { useTheme } from "@/hooks/useTheme";

// Mount once at the app root so the stored theme applies on every route (not only
// the System Settings page). Renders nothing.
export function AppThemeSync() {
    useTheme();
    return null;
}
