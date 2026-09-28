import { cn } from "@/lib/utils";

export function Spinner({ className, label }: { className?: string; label: string }) {
    return <span role="status" aria-label={label} className={cn("size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent", className)} />;
}
