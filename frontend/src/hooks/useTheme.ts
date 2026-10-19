import { useCallback, useEffect, useState } from "react";

import { applyTheme, readStoredTheme, storeTheme, type Theme } from "@/lib/theme";

export function useTheme() {
    const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());

    // Defensive: covers another tab changing storage, or the boot <script> not running.
    useEffect(() => {
        applyTheme(theme);
    }, [theme]);

    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    // When the user picks "system", also react to live OS preference changes.
    // This listener is load-bearing, not dead code.
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
