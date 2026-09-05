import { useCallback, useEffect, useState } from "react";

import { applyTheme, readStoredTheme, storeTheme, type Theme } from "@/lib/theme";

// React state around lib/theme: materialises the stored choice, applies the
// `.dark` class immediately on change, and re-applies on mount so no stale
// document state survives a reload while still being flash-free enough for dev.
export function useTheme() {
    const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());

    // Keep the DOM in sync on mount (in case storage changed in another tab).
    useEffect(() => {
        applyTheme(theme);
    }, [theme]);

    // When the user picks "system", also react to live OS preference changes.
    // A matchMedia listener is cheap and idempotent; tear down on unmount/theme change.
    useEffect(() => {
        if (theme !== "system") return;
        const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
        if (!mq) return;
        const onChange = () => applyTheme(theme);
        mq.addEventListener("change", onChange);
        return () => mq.removeEventListener("change", onChange);
    }, [theme]);

    const setTheme = useCallback((t: Theme) => {
        storeTheme(t);
        setThemeState(t);
    }, []);

    return { theme, setTheme };
}
