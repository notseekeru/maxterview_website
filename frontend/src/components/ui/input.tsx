import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(({ className, type, ...props }, ref) => (
    <input
        type={type}
        className={cn("flex h-9 w-full rounded-full border border-input bg-background px-3 py-1 text-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50", className)}
        // Before {...props}: every identifier-ish field this app has (url, model, key, role, preset name)
        // is not prose, and a spellchecker underlines all of them.
        spellCheck={false}
        ref={ref}
        {...props}
    />
));
Input.displayName = "Input";

export { Input };
