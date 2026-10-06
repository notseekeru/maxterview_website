import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { cn } from "@/lib/utils";

// Inner-width wrapper + heading for every sidebar page. `wide` opts out of the reading-width cap:
// workspace surfaces have to use a large monitor's width or their grid tiles collapse.
const WIDE_MAX = "max-w-[100rem]";

/** Mono at 70% of --foreground, not --muted-foreground: these run at 10.4px, where the secondary
 *  token measures 4.74:1 on white and 4.35:1 over a --muted fill, under AA, against 8.6:1 and 8.3:1
 *  for /70. One constant for every eyebrow, column head, unit and tier tag across the app pages and
 *  the landing page, so the two cannot drift. Ratios measured 2026-10-05 on the light palette. */
export const LABEL = "font-mono text-[0.65rem] uppercase tracking-[0.18em] text-foreground/70";

export function Page({ title, description, heading, children, actions, wide }: { title: string; description?: ReactNode; heading?: ReactNode; children: ReactNode; actions?: ReactNode; wide?: boolean }) {
    useDocumentTitle(title);
    return (
        <div className={cn("mx-auto w-full space-y-6 px-4 py-6 sm:px-6", wide ? WIDE_MAX : "max-w-4xl")}>
            <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-t pt-4">
                <div className="space-y-2.5">
                    {/* `heading` replaces the h1's text without touching the document title: the
                        dashboard headlines the greeting while the tab still reads "Dashboard". */}
                    <h1 className="font-serif text-[clamp(1.75rem,2.8vw,2.5rem)] leading-[1.06] tracking-[-0.025em] text-balance">{heading ?? title}</h1>
                    {description && <p className="max-w-[56ch] text-sm leading-[1.75] text-muted-foreground">{description}</p>}
                </div>
                {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
            </header>
            {children}
        </div>
    );
}

/** One titled band inside a page. The dashboard and the analytics page both open sections with it, so
 *  a heading cannot end up two sizes on the two pages that sit next to each other in the nav. */
export function SectionHeading({ title, hint }: { title: string; hint?: string }) {
    return (
        <div className="space-y-1 border-b pb-2">
            <h2 className="font-serif text-xl tracking-[-0.015em]">{title}</h2>
            {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
    );
}

/** Headline number with its denominator under it: two pages (analytics, offers) open on a row of these,
 *  and a tile that cannot say what it is averaged over is a number nobody can act on.
 *
 *  The hint is pinned to the tile's floor rather than trailing the number: the grid stretches every tile
 *  in a row to the tallest, and a hint that floats leaves the shorter tiles with a band of dead space.
 *  Same for the number itself, which keeps the big figure on a shared baseline across the row. */
export function Stat({ label, value, hint, delta, spark }: { label: string; value: string; hint?: string; delta?: ReactNode; spark?: number[] }) {
    return (
        <Card className="flex flex-col">
            <CardHeader className="pb-2">
                <CardTitle className={LABEL}>{label}</CardTitle>
            </CardHeader>
            <CardContent className="flex grow flex-col">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <p className="font-serif text-4xl leading-none tracking-[-0.03em] tabular-nums">{value}</p>
                    {delta}
                </div>
                {spark && <Sparkline data={spark} />}
                {hint && <p className="mt-auto pt-3 font-mono text-[0.6rem] tabular-nums text-muted-foreground">{hint}</p>}
            </CardContent>
        </Card>
    );
}

/** Shape only: no axis, no tick, no scale. The number above it is the value; this is its direction,
 *  which is all a five-window tile has room for. */
function Sparkline({ data }: { data: number[] }) {
    if (data.length < 2) return null;
    const min = Math.min(...data);
    const span = Math.max(...data) - min || 1;
    const step = 100 / (data.length - 1);
    const points = data.map((v, i) => `${(i * step).toFixed(1)},${(26 - ((v - min) / span) * 24).toFixed(1)}`);
    return (
        <svg viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true" className="mt-3 h-7 w-full text-[var(--chart-1)]">
            <polygon points={`0,28 ${points.join(" ")} 100,28`} fill="currentColor" opacity={0.12} />
            <polyline points={points.join(" ")} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
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
