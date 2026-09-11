import { useState } from "react";
import { Icon } from "@/components/AppIcons";
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

// /app/settings/system — per-user app preferences. Appearance (theme) is live; the
// remaining cards are ops-facing knobs with no backend yet (inert, see `AI HERE:`).
export function SystemSettingsPage() {
    const { theme, setTheme } = useTheme();
    const [model, setModel] = useState<string>("default");

    return (
        <Page title="System Settings" description="Appearance and behaviour defaults for your workspace.">
            <Card>
                <CardHeader>
                    <CardTitle>Appearance</CardTitle>
                    <CardDescription>Maxterview look. Applies to every page and recharts.</CardDescription>
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

            {/* Language / region — stub, no backend persistence. */}
            {/* AI HERE: language + timezone are single-user prefs we could persist via a
                small per-account row (backend `accounts` object). Deferred: the account
                model (D4/D7) predates multi-account "managed accounts", so it'd live under
                the same accounts table when that lands. */}
            <Card>
                <CardHeader>
                    <CardTitle>Language & region</CardTitle>
                    <CardDescription>Responses default to your device language. Full translation is out of scope for the MVP.</CardDescription>
                </CardHeader>
                <CardFooter>
                    <span className="text-sm text-muted-foreground">Coming soon</span>
                </CardFooter>
            </Card>

            {/* Default LLM source — inert until we decide BYOK / model picker shape. */}
            {/* AI HERE: exposing a model/provider toggle collides with (a) credential
                storage (zero-touch policy in AGENTS.md) for user-owned keys, and (b) the
                M10 free/premium token budgets in MONETIZATION.md. Deliberately kept as a
                read-only "system default" until both are resolved (see PRD "BYOK"). */}
            <Card>
                <CardHeader>
                    <CardTitle>Interview engine</CardTitle>
                    <CardDescription>Which model drives mock interviews.</CardDescription>
                </CardHeader>
                <CardFooter>
                    <label className="flex items-center gap-2 text-sm">
                        <span className="text-muted-foreground">Provider:</span>
                        <select value={model} onChange={(e) => setModel(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                            <option value="default">System default</option>
                        </select>
                    </label>
                </CardFooter>
            </Card>
        </Page>
    );
}
