import { UserButton } from "@clerk/react";
import { useCallback, useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Icon } from "@/components/AppIcons";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { LABEL } from "@/components/PagePrimitives";
import { UsageBadge } from "@/components/UsageBadge";
import { Button } from "@/components/ui/button";
import { clerkEnabled } from "@/lib/config";
import { NAV, type NavItem } from "@/lib/nav";
import { cn } from "@/lib/utils";

const RAIL_KEY = "maxterview.rail";

export function AppShell() {
    // Persisted so the rail the user chose survives a reload; the mobile drawer is its own thing.
    const [collapsed, setCollapsed] = useState(() => typeof localStorage !== "undefined" && localStorage.getItem(RAIL_KEY) === "collapsed");
    useEffect(() => {
        localStorage.setItem(RAIL_KEY, collapsed ? "collapsed" : "expanded");
    }, [collapsed]);

    return (
        <div className="min-h-screen">
            <aside className={cn("fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-border bg-background transition-[width] duration-200 lg:flex", collapsed ? "w-16" : "w-60")}>
                <div className={cn("flex h-14 shrink-0 items-center gap-1 border-b border-border", collapsed ? "justify-center px-2" : "justify-between pr-2")}>
                    {!collapsed && <Brand />}
                    <Button variant="ghost" size="icon" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>
                        <Icon name="panel" className={cn("h-4 w-4 transition-transform", collapsed && "rotate-180")} />
                    </Button>
                </div>
                <NavBody collapsed={collapsed} onNavigate={() => undefined} />
                <aside className={cn("mt-auto border-t border-border p-3", collapsed && "px-2")}>
                    <div className={cn("flex items-center", collapsed ? "justify-center" : "justify-between gap-2")}>
                        {!collapsed && <UsageBadge />}
                        <SessionFooter />
                    </div>
                </aside>
            </aside>

            <div className={cn("flex min-h-screen flex-col transition-[padding-left] duration-200", collapsed ? "lg:pl-16" : "lg:pl-60")}>
                <MobileTopBar />
                <main className="min-w-0 flex-1">
                    <ErrorBoundary inline>
                        <Outlet />
                    </ErrorBoundary>
                </main>
            </div>
        </div>
    );
}

function Brand() {
    const navigate = useNavigate();
    return (
        <button type="button" onClick={() => navigate("/")} className="flex h-14 shrink-0 items-center border-b border-transparent px-4 text-left font-serif text-lg tracking-[-0.015em]">
            maxterview
        </button>
    );
}

function NavBody({ collapsed, onNavigate }: { collapsed: boolean; onNavigate: () => void }) {
    return (
        <nav className={cn("flex-1 overflow-y-auto py-3", collapsed ? "px-2" : "px-3")}>
            <div className="space-y-6">
                {NAV.map((section) => (
                    <div key={section.id} className="space-y-1">
                        {section.title && !collapsed && <p className={cn("px-3 pt-2 pb-1", LABEL)}>{section.title}</p>}
                        {section.items.map((item) => (
                            <RailItem key={item.to} item={item} collapsed={collapsed} onNavigate={onNavigate} />
                        ))}
                    </div>
                ))}
            </div>
        </nav>
    );
}

function RailItem({ item, collapsed, onNavigate }: { item: NavItem; collapsed: boolean; onNavigate: () => void }) {
    return (
        <NavLink
            to={item.to}
            end={item.index}
            onClick={onNavigate}
            title={collapsed ? item.label : undefined}
            aria-label={collapsed ? item.label : undefined}
            className={({ isActive }) => cn("flex items-center gap-3 rounded-md py-2 text-sm font-medium transition-colors", collapsed ? "justify-center px-0" : "px-3", isActive ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}
        >
            <Icon name={item.icon} className="h-4 w-4 shrink-0" />
            {!collapsed && <span className="truncate">{item.label}</span>}
        </NavLink>
    );
}

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

function MobileTopBar() {
    const [open, setOpen] = useState(false);
    const navigate = useNavigate();
    const close = useCallback(() => setOpen(false), []);
    return (
        <>
            <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border bg-background/95 px-4 backdrop-blur lg:hidden">
                <button type="button" className="font-serif text-lg tracking-[-0.015em]" onClick={() => navigate("/")}>
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
                            <span className="font-serif text-lg tracking-[-0.015em]">maxterview</span>
                            <Button variant="ghost" size="icon" aria-label="Close navigation" onClick={close}>
                                <Icon name="x" className="h-5 w-5" />
                            </Button>
                        </div>
                        <NavBody collapsed={false} onNavigate={close} />
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
