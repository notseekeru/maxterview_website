import type * as React from "react";

import { cn } from "@/lib/utils";

// Native range input tinted through `--primary`, so light/dark and the monochrome palette come free.
// Deliberately not Radix: no new dependency, and keyboard/AT semantics are already correct.
export function Slider({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
    return <input type="range" className={cn("h-5 w-full cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-50", className)} {...props} />;
}
