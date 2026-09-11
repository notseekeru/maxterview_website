// Sidebar navigation model shared by the shell layout. Renderer: components/AppShell.tsx.

import type { IconName } from "@/components/AppIcons";

export interface NavItem {
    label: string;
    to: string;
    icon: IconName;
    index?: boolean;
}

export interface NavSection {
    id: string;
    title?: string; // absent => rendered as a plain top-level item row (no grouping label)
    items: NavItem[];
}

export const NAV: NavSection[] = [
    {
        id: "main",
        items: [
            { label: "Dashboard", to: "/app", icon: "dashboard", index: true },
            { label: "Resume", to: "/app/resume", icon: "file" },
            { label: "Interviews", to: "/app/interviews", icon: "chat" },
            { label: "Analytics", to: "/app/analytics", icon: "chart" },
        ],
    },
    {
        id: "settings",
        title: "Settings",
        items: [
            { label: "System", to: "/app/settings/system", icon: "settings" },
            { label: "Account", to: "/app/settings/account", icon: "user" },
            { label: "Billing", to: "/app/settings/billing", icon: "card" },
        ],
    },
    {
        id: "management",
        title: "Management",
        items: [
            { label: "Managed accounts", to: "/app/manage/accounts", icon: "users" },
            { label: "Docs", to: "/app/manage/docs", icon: "book" },
        ],
    },
];
