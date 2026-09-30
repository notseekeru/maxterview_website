import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { cn } from "@/lib/utils";

// Inner-width wrapper + heading for every sidebar page. `wide` opts out of the reading-width cap:
// workspace surfaces have to use a large monitor's width or their grid tiles collapse.
const WIDE_MAX = "max-w-[100rem]";

export function Page({ title, description, children, actions, wide }: { title: string; description?: string; children: ReactNode; actions?: ReactNode; wide?: boolean }) {
    useDocumentTitle(title);
    return (
        <div className={cn("mx-auto w-full space-y-6 px-4 py-6 sm:px-6", wide ? WIDE_MAX : "max-w-4xl")}>
            <header className="flex flex-wrap items-end justify-between gap-3">
                <div className="space-y-1">
                    <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
                    {description && <p className="text-sm text-muted-foreground">{description}</p>}
                </div>
                {actions && <div className="flex items-center gap-2">{actions}</div>}
            </header>
            {children}
        </div>
    );
}

/** Headline number with its denominator under it: two pages (analytics, offers) open on a row of these,
 *  and a tile that cannot say what it is averaged over is a number nobody can act on.
 *
 *  The hint is pinned to the tile's floor rather than trailing the number: the grid stretches every tile
 *  in a row to the tallest, and a hint that floats leaves the shorter tiles with a band of dead space.
 *  Same for the number itself, which keeps the big figure on a shared baseline across the row. */
export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <Card className="flex flex-col">
            <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
            </CardHeader>
            <CardContent className="flex grow flex-col">
                <p className="text-3xl font-semibold tabular-nums">{value}</p>
                {hint && <p className="mt-auto pt-2 text-xs text-muted-foreground">{hint}</p>}
            </CardContent>
        </Card>
    );
}

/** One titled card, sized by the caller. `hint` is the panel's denominator or method, never a caption
 *  restating the title. */
export function Panel({ title, hint, children, className }: { title: string; hint?: string; children: ReactNode; className?: string }) {
    return (
        <Card className={cn("flex flex-col", className)}>
            <CardHeader className="pb-2">
                <CardTitle className="text-sm">{title}</CardTitle>
                {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
            </CardHeader>
            <CardContent className="min-h-0 grow">{children}</CardContent>
        </Card>
    );
}
