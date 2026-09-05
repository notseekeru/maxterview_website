import { useTheme } from "@/hooks/useTheme";

// Mount once at the app root. Ensures the stored theme is applied on every
// route (Dashboard, Interviews, ...) and that live OS changes are followed when
// the stored choice is "system" — not just while the System Settings page is
// open. Renders nothing; it exists solely to own the side effect infrastructure.
export function AppThemeSync() {
    useTheme();
    return null;
}
