import { type ReactNode, useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/** Native <dialog showModal()>: backdrop, focus trap, Esc-to-close and an inert background come from
 *  the platform, which is why this needs no Radix dialog dependency.
 *
 *  AI HERE: no open/close animation and one modal at a time (nothing here queues). Upgrade path is a
 *  Radix dialog if we ever need stacked modals or transitions.
 */
export function Modal({ open, onClose, title, children, className }: { open: boolean; onClose: () => void; title: string; children: ReactNode; className?: string }) {
    const ref = useRef<HTMLDialogElement>(null);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        if (open && !el.open) el.showModal();
        else if (!open && el.open) el.close();
    }, [open]);

    return (
        <dialog
            ref={ref}
            onClose={onClose}
            // Padding lives on the inner div: with padding on the dialog itself, a click on the
            // padding reads as a backdrop click and closes the modal under the user's cursor.
            className={cn("m-auto w-[calc(100vw-2rem)] max-w-md rounded-lg border bg-background p-0 text-foreground shadow-lg backdrop:bg-black/50", className)}
            // mousedown, not click: a drag that starts inside the modal and ends on the backdrop
            // should not close it. Escape is the platform's own (dialog onClose).
            onMouseDown={(e) => {
                if (e.target === ref.current) onClose();
            }}
        >
            <div className="flex items-center justify-between gap-4 border-b px-4 py-3">
                <h2 className="text-sm font-semibold">{title}</h2>
                <button type="button" onClick={onClose} aria-label="Close" className="rounded-md px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                    ✕
                </button>
            </div>
            <div className="space-y-3 p-4 text-sm">{children}</div>
        </dialog>
    );
}
