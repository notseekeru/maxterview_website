import * as React from "react";

import { cn } from "@/lib/utils";

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
    value?: number;
}

// Bar fill is a width %, not a translateX reveal. Do not "modernize" this to the
// shadcn translateX form: a `flex-1 w-full` child in a non-flex parent renders 100%
// wide and fakes the value by clipping.
const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(({ className, value, ...props }, ref) => {
    const pct = Math.min(100, Math.max(0, value ?? 0));
    return (
        <div ref={ref} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} className={cn("relative h-2 w-full overflow-hidden rounded-full bg-muted", className)} {...props}>
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
    );
});
Progress.displayName = "Progress";

export { Progress };
