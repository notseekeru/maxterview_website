import { useCallback, useEffect, useState } from "react";

import { applyTheme, readStoredTheme, storeTheme, type Theme } from "@/lib/theme";

// React state around lib/theme. `setTheme` flips storage AND the DOM
// synchronously (not via the mount effect below) so the choice lands even if
// the calling page unmounts right after — the .dark class then survives any
// SPA navigation.
export function useTheme() {
    const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());

    // Re-apply on mount + whenever the stored choice changes (defensive: in case
    // storage changed in another tab or the boot <script> was skipped).
    useEffect(() => {
        applyTheme(theme);
    }, [theme]);

    // When the user picks "system", also react to live OS preference changes.
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    useEffect(() => {
        if (theme !== "system" || !mq) return;
        const onChange = () => applyTheme("system");
        mq.addEventListener("change", onChange);
        return () => mq.removeEventListener("change", onChange);
    }, [theme, mq]);

    const setTheme = useCallback((t: Theme) => {
        storeTheme(t);
        applyTheme(t);
        setThemeState(t);
    }, []);

    return { theme, setTheme };
}
