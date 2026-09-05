import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/AppIcons";
import { Separator } from "@/components/ui/separator";

// Consistent inner-width wrapper + heading used by every sidebar page so the
// shell rail and the content look cohesive across routes.
export function Page({ title, description, children, actions }: { title: string; description?: string; children: ReactNode; actions?: ReactNode }) {
    return (
        <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 sm:px-6">
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

// Graceful stand-in for sections whose backend work is not built yet (see the
// `AI HERE:` note next to any such route). Shows intent + a "coming soon" body.
export function ComingSoon({ icon, title, description }: { icon: IconName; title: string; description: string }) {
    return (
        <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-8 text-center">
            <Icon name={icon} className="h-8 w-8 text-muted-foreground" />
            <div>
                <h2 className="text-lg font-medium">{title}</h2>
                <p className="mt-1 max-w-sm text-sm text-muted-foreground">{description}</p>
            </div>
        </div>
    );
}

export function SectionDivider() {
    return <Separator />;
}
