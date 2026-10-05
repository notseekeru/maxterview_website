import { Link } from "react-router-dom";

import { LABEL } from "@/components/PagePrimitives";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

// Catch-all for unknown top-level paths, deliberately OUTSIDE <Gate> so an unknown URL 404s whatever
// the auth state, rather than rendering behind a sign-in wall.
export function NotFound() {
    useDocumentTitle("Page not found");
    return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center">
            <div className="space-y-2">
                <p className={LABEL}>404</p>
                <h1 className="font-serif text-[clamp(2rem,4vw,3rem)] leading-[1.06] tracking-[-0.03em]">Page not found</h1>
                <p className="max-w-sm text-sm text-muted-foreground">That address doesn&apos;t match anything here.</p>
            </div>
            <Button asChild variant="outline">
                <Link to="/">Back to home</Link>
            </Button>
        </div>
    );
}
