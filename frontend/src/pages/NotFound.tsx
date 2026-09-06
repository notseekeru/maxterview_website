import { Link } from "react-router-dom";

import { Button } from "@/components/ui/button";

// Catch-all for unknown top-level paths (/foo) that match no client route.
// Rendered inside <Gate> so signed-out users still hit the auth lightbox first.
export function NotFound() {
    return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center">
            <div className="space-y-2">
                <p className="text-sm font-medium text-muted-foreground">404</p>
                <h1 className="text-3xl font-semibold tracking-tight">Page not found</h1>
                <p className="max-w-sm text-sm text-muted-foreground">That address doesn&apos;t match anything here.</p>
            </div>
            <Button asChild variant="outline">
                <Link to="/">Back to home</Link>
            </Button>
        </div>
    );
}
