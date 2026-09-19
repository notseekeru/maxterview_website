import type { ReactNode } from "react";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";
import { cn } from "@/lib/utils";

// Consistent inner-width wrapper + heading used by every sidebar page. `wide` opts a page out of
// the reading-width cap: workspace surfaces (the dashboard) have to be able to use a large
// monitor's width, or their grid tiles collapse to ~100px inside the 3/5 column of a 896px page.
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
