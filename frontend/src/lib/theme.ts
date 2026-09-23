// Light/dark/system theme, persisted to localStorage and applied as a `.dark`
// DARK IS THE DEFAULT: with no stored choice we pick `dark`, not the OS preference.

export type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "maxterview.theme";

const DEFAULT_THEME: Theme = "dark";

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

export function applyTheme(theme: Theme): void {
    document.documentElement.classList.toggle("dark", effectiveDark(theme));
}

export function readStoredTheme(): Theme {
    return safeParse(window.localStorage.getItem(STORAGE_KEY)) ?? DEFAULT_THEME;
}

export function storeTheme(theme: Theme): void {
    try {
        window.localStorage.setItem(STORAGE_KEY, theme);
    } catch {
        // Private-mode localStorage unavailable — theme just won't persist.
    }
}
