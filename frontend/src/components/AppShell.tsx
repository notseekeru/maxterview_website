import { UserButton } from "@clerk/react";
import { useCallback, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Icon } from "@/components/AppIcons";
import { Button } from "@/components/ui/button";
import { clerkEnabled } from "@/lib/config";
import { NAV, type NavItem } from "@/lib/nav";
import { cn } from "@/lib/utils";

// Persistent shell around the Dashboard + its sub-pages: a fixed left rail on
// ≥lg screens and a slide-over drawer below. `/interviews/:id` is not wrapped here.
export function AppShell() {
    return (
        <div className="min-h-screen">
            <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-background lg:flex">
                <Brand />
                <NavBody onNavigate={() => undefined} />
                <aside className="mt-auto border-t border-border p-3">
                    <SessionFooter />
                </aside>
            </aside>

            <div className="flex min-h-screen flex-col lg:pl-60">
                <MobileTopBar />
                <main className="min-w-0 flex-1">
                    <Outlet />
                </main>
            </div>
        </div>
    );
}

function Brand() {
    const navigate = useNavigate();
    return (
        <button type="button" onClick={() => navigate("/")} className="flex h-14 shrink-0 items-center border-b border-border px-4 text-left text-base font-semibold tracking-tight">
            maxterview
        </button>
    );
}

function NavBody({ onNavigate }: { onNavigate: () => void }) {
    return (
        <nav className="flex-1 overflow-y-auto px-3 py-3">
            <div className="space-y-6">
                {NAV.map((section) => (
                    <div key={section.id} className="space-y-1">
                        {section.title && <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{section.title}</p>}
                        {section.items.map((item) => (
                            <RailItem key={item.to} item={item} onNavigate={onNavigate} />
                        ))}
                    </div>
                ))}
            </div>
        </nav>
    );
}

function RailItem({ item, onNavigate }: { item: NavItem; onNavigate: () => void }) {
    return (
        <NavLink to={item.to} end={item.index} onClick={onNavigate} className={({ isActive }) => cn("flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors", isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}>
            <Icon name={item.icon} className="h-4 w-4 shrink-0" />
            <span className="truncate">{item.label}</span>
        </NavLink>
    );
}

// Account / session footer shown in the rail. Clerk => UserButton (avoids a
// bespoke useUser + sign-out). In no-Clerk dev mode we render a quiet DEV tag.
function SessionFooter() {
    return clerkEnabled ? <UserButton /> : <DevTag />;
}

function DevTag() {
    return (
        <div role="status" className="text-xs text-muted-foreground">
            <span className="rounded border border-dashed border-border px-2 py-0.5">DEV</span>
        </div>
    );
}

// Mobile/tablet: slim top bar with a menu toggle that opens the same NAV in an
// overlay drawer (no nav dep needed).
function MobileTopBar() {
    const [open, setOpen] = useState(false);
    const navigate = useNavigate();
    const close = useCallback(() => setOpen(false), []);
    return (
        <>
            <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur lg:hidden">
                <button type="button" className="text-base font-semibold tracking-tight" onClick={() => navigate("/")}>
                    maxterview
                </button>
                <Button variant="ghost" size="icon" aria-label="Open navigation" onClick={() => setOpen(true)}>
                    <Icon name="menu" className="h-5 w-5" />
                </Button>
            </header>

            {open && (
                <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Navigation">
                    <button type="button" aria-label="Close navigation" className="absolute inset-0 bg-black/50" onClick={close} />
                    <div className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-border bg-background">
                        <div className="flex h-14 items-center justify-between border-b border-border px-4">
                            <span className="text-base font-semibold tracking-tight">maxterview</span>
                            <Button variant="ghost" size="icon" aria-label="Close navigation" onClick={close}>
                                <Icon name="x" className="h-5 w-5" />
                            </Button>
                        </div>
                        <NavBody onNavigate={close} />
                        <div className="mt-auto border-t border-border p-3">
                            <Button
                                variant="ghost"
                                size="sm"
                                className="w-full justify-start text-muted-foreground"
                                onClick={() => {
                                    close();
                                    navigate("/");
                                }}
                            >
                                <Icon name="logout" className="h-4 w-4" />
                                Exit to landing
                            </Button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
