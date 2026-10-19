import { type ReactNode, useEffect, useId, useRef } from "react";

import { cn } from "@/lib/utils";

// AI HERE: no open/close animation and one modal at a time (nothing here queues). Upgrade path is a
// Radix dialog if we ever need stacked modals or transitions.
export function Modal({ open, onClose, title, children, className }: { open: boolean; onClose: () => void; title: string; children: ReactNode; className?: string }) {
    const ref = useRef<HTMLDialogElement>(null);
    // <dialog> is named by aria-* alone: the <h2> inside does not name it.
    const titleId = useId();

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        if (open && !el.open) el.showModal();
        else if (!open && el.open) el.close();
    }, [open]);

    return (
        <dialog
            ref={ref}
            aria-labelledby={titleId}
            onClose={onClose}
            // Padding lives on the inner div: with padding on the dialog itself, a click on the
            // padding reads as a backdrop click and closes the modal under the user's cursor.
            className={cn("m-auto w-[calc(100vw-2rem)] max-w-md overscroll-contain rounded-xl border bg-background p-0 text-foreground shadow-lg backdrop:bg-black/50", className)}
            // mousedown, not click: a drag that starts inside the modal and ends on the backdrop
            // should not close it. Escape is the platform's own (dialog onClose).
            onMouseDown={(e) => {
                if (e.target === ref.current) onClose();
            }}
        >
            {/* pr-2, not px-4: the close button carries its own 44px box, so this is what keeps the
                title's left gutter and the button's right gutter equal. */}
            <div className="flex items-center justify-between gap-4 border-b py-1.5 pr-2 pl-4">
                <h2 id={titleId} className="text-sm font-semibold">
                    {title}
                </h2>
                <button type="button" onClick={onClose} aria-label="Close" className="grid h-11 w-11 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                    ✕
                </button>
            </div>
            <div className="space-y-3 p-4 text-sm">{children}</div>
        </dialog>
    );
}
