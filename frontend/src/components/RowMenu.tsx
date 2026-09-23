import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

interface RowMenuItem {
    label: string;
    onSelect: () => void;
    destructive?: boolean;
}

/** The row's ⋮ menu. `<details>` gives open/close, the summary is the hit target, and two listeners
 *  keep it behaving like a menu: outside click and Escape close it.
 *
 *  AI HERE: no focus trap and no arrow-key navigation - it is a two-to-three item menu on a list row,
 *  and the items are ordinary buttons, so Tab reaches them. Upgrade path: a real menu primitive if
 *  the item count grows.
 */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
    const ref = useRef<HTMLDetailsElement>(null);
    const close = () => {
        if (ref.current) ref.current.open = false;
    };

    useEffect(() => {
        // Written against the ref, not the `close` helper: a dependency on a per-render closure would
        // rebind both listeners on every render for no reason.
        const onDocDown = (e: MouseEvent) => {
            const el = ref.current;
            if (el?.open && !el.contains(e.target as Node)) el.open = false;
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && ref.current) ref.current.open = false;
        };
        document.addEventListener("mousedown", onDocDown);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onDocDown);
            document.removeEventListener("keydown", onKey);
        };
    }, []);

    return (
        <details ref={ref} className="relative">
            <summary aria-label={label} title={label} className="flex h-8 w-8 cursor-pointer list-none items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&::-webkit-details-marker]:hidden">
                <span aria-hidden className="text-base leading-none">
                    ⋮
                </span>
            </summary>
            {/* z-40 is above the fixed nav rail (z-30): a left-opening panel from a chip at the card's
                left edge crosses the rail, and at z-20 the rail painted over it. */}
            <div className="absolute right-0 z-40 mt-1 w-36 rounded-md border bg-popover p-1 shadow-md">
                {items.map((item) => (
                    <button
                        key={item.label}
                        type="button"
                        onClick={() => {
                            close();
                            item.onSelect();
                        }}
                        className={cn("block w-full rounded-sm px-3 py-1.5 text-left text-sm hover:bg-accent", item.destructive && "text-destructive hover:bg-destructive/10")}
                    >
                        {item.label}
                    </button>
                ))}
            </div>
        </details>
    );
}
