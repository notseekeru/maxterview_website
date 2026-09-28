import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Inline feedback line: the app's one voice for "nothing here yet" and "this failed".
 *
 *  `danger` is not decoration: it carries role="alert". The error paths it replaces were plain
 *  <p class="text-destructive">, which a screen reader announces only if the user happens to
 *  navigate into them. Anything that must interrupt (a submit that failed, a quota wall) belongs
 *  in `danger`; anything the user should read when they get there stays `muted`. */
export function StateNote({ tone = "muted", children, className }: { tone?: "muted" | "danger"; children: ReactNode; className?: string }) {
    return (
        <p role={tone === "danger" ? "alert" : undefined} className={cn("text-sm", tone === "danger" ? "text-destructive" : "text-muted-foreground", className)}>
            {children}
        </p>
    );
}
