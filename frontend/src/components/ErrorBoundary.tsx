import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { reportRenderCrash } from "@/lib/errorBeacon";

interface Props {
    children: ReactNode;
    inline?: boolean;
}

interface State {
    error: Error | null;
}

// React unmounts the whole tree on an uncaught render throw, which without this is a blank page and no
// way back. A class is the only way to get componentDidCatch; a reload is the only honest recovery.
export class ErrorBoundary extends Component<Props, State> {
    state: State = { error: null };

    static getDerivedStateFromError(error: Error): State {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        // The card shows only `error.message`, so nobody at the screen can report what broke: the
        // message and component stack go to Loki, the full error stays on the console.
        console.error("unhandled render error", error, info.componentStack);
        reportRenderCrash(error, info.componentStack);
    }

    render() {
        if (!this.state.error) return this.props.children;
        if (this.props.inline) {
            return (
                <div className="m-6 space-y-2 rounded-xl border border-dashed p-4">
                    <p className="text-sm font-medium">This page failed to render</p>
                    <p className="text-sm text-muted-foreground">Your interviews are stored server-side and are not affected. Pick another page from the rail, or reload.</p>
                    <p className="font-mono text-xs text-muted-foreground">{this.state.error.message}</p>
                </div>
            );
        }
        return (
            <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-center">
                <h1 className="font-serif text-3xl tracking-[-0.025em]">Something broke on this screen</h1>
                <p className="max-w-md text-sm text-muted-foreground">Your interviews are stored server-side and are not affected. Reload to get back to the dashboard.</p>
                <p className="max-w-md font-mono text-xs text-muted-foreground">{this.state.error.message}</p>
                <Button onClick={() => window.location.assign("/dashboard")}>Back to dashboard</Button>
            </div>
        );
    }
}
