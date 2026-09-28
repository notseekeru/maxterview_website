import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export function StateNote({ tone = "muted", children, className }: { tone?: "muted" | "danger"; children: ReactNode; className?: string }) {
    return (
        <p role={tone === "danger" ? "alert" : undefined} className={cn("text-sm", tone === "danger" ? "text-destructive" : "text-muted-foreground", className)}>
            {children}
        </p>
    );
}
