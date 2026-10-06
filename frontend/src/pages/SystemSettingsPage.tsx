import { Icon } from "@/components/AppIcons";
import { LLMProviderCard } from "@/components/LLMProviderCard";
import { Page } from "@/components/PagePrimitives";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { useTheme } from "@/hooks/useTheme";
import type { Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const THEME_OPTIONS: { value: Theme; label: string; icon: "sun" | "moon" | "monitor" }[] = [
    { value: "light", label: "Light", icon: "sun" },
    { value: "dark", label: "Dark", icon: "moon" },
    { value: "system", label: "System", icon: "monitor" },
];

// /settings/system — per-user app preferences. Appearance (theme) and the LLM provider
// (BYOK, see LLMProviderCard).
export function SystemSettingsPage() {
    const { theme, setTheme } = useTheme();

    return (
        <Page title="System" description="Appearance and interview engine for your account.">
            <Card>
                <CardHeader>
                    <CardTitle>Appearance</CardTitle>
                    <CardDescription>Applies to every page and chart.</CardDescription>
                </CardHeader>
                <CardFooter className="flex flex-wrap gap-2">
                    {THEME_OPTIONS.map((opt) => (
                        <button
                            key={opt.value}
                            type="button"
                            aria-pressed={theme === opt.value}
                            onClick={() => setTheme(opt.value)}
                            className={cn("flex w-32 items-center justify-center gap-2 rounded-md border px-4 py-2 text-sm font-medium transition-colors", theme === opt.value ? "border-ring bg-accent text-accent-foreground" : "border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground")}
                        >
                            <Icon name={opt.icon} className="h-4 w-4" />
                            {opt.label}
                        </button>
                    ))}
                </CardFooter>
            </Card>

            {/* Default LLM source: BYOK. Free/Pro alike can point interviews at their own
                OpenAI-compatible provider; the key is encrypted at rest and never returned
                (backend app/byok.py, BYOK.md). */}
            <LLMProviderCard />
        </Page>
    );
}
