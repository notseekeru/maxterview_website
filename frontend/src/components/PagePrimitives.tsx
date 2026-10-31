import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { cn } from "@/lib/utils";

const WIDE_MAX = "max-w-[100rem]";

export const LABEL = "font-mono text-[0.65rem] uppercase tracking-[0.18em] text-foreground/70";

export function Page({ title, heading, children, actions, wide }: { title: string; heading?: ReactNode; children: ReactNode; actions?: ReactNode; wide?: boolean }) {
    useDocumentTitle(title);
    return (
        <div className={cn("mx-auto w-full space-y-6 px-4 py-6 sm:px-6", wide ? WIDE_MAX : "max-w-4xl")}>
            <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-t pt-4">
                <h1 className="font-serif text-[clamp(1.75rem,2.8vw,2.5rem)] leading-[1.06] tracking-[-0.025em] text-balance">{heading ?? title}</h1>
                {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
            </header>
            {children}
        </div>
    );
}

export function SectionHeading({ title }: { title: string }) {
    return (
        <div className="border-b pb-2">
            <h2 className="font-serif text-xl tracking-[-0.015em]">{title}</h2>
        </div>
    );
}

export function Stat({ label, value, delta }: { label: string; value: string; delta?: ReactNode }) {
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
            </CardContent>
        </Card>
    );
}

export function Sparkline({ data }: { data: number[] }) {
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

export function Panel({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
    return (
        <Card className={cn("flex flex-col", className)}>
            <CardHeader className="pb-2">
                <CardTitle className="text-sm">{title}</CardTitle>
            </CardHeader>
            <CardContent className="min-h-0 grow">{children}</CardContent>
        </Card>
    );
}
