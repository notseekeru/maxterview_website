import { cn } from "@/lib/utils";

/** The only spinner in the app. Two hand-rolled copies had already drifted (size-3.5 in the chat
 *  composer, size-4 in the finish overlay); `className` carries the size, `label` the accessible
 *  name, because "Loading" is wrong above a button that is generating. */
export function Spinner({ className, label }: { className?: string; label: string }) {
    return <span role="status" aria-label={label} className={cn("size-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent", className)} />;
}
