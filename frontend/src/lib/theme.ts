// Light/dark/system theme, persisted to localStorage and applied as a `.dark`
// class on <html> (matches the recharts `.dark` convention in chart.tsx).

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "maxterview.theme";

function safeParse(raw: string | null): Theme | null {
    return raw === "light" || raw === "dark" || raw === "system" ? raw : null;
}

function systemPrefersDark(): boolean {
    return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)")?.matches === true;
}

function effectiveDark(theme: Theme): boolean {
    const resolved: Theme = theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;
    return resolved === "dark";
}

// Inert under SSR (not used).
export function applyTheme(theme: Theme): void {
    if (typeof document === "undefined") return;
    document.documentElement.classList.toggle("dark", effectiveDark(theme));
}

export function readStoredTheme(): Theme {
    return safeParse(typeof window !== "undefined" ? window.localStorage.getItem(STORAGE_KEY) : null) ?? "system";
}

export function storeTheme(theme: Theme): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
        // Private-mode localStorage unavailable — theme just won't persist.
    }
}
