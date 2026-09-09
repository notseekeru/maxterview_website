// Sidebar navigation model shared by the shell layout. Pure data-structure; the
// renderer lives in components/AppShell.tsx. Kept framework-free for easy lint + test.

import type { IconName } from "@/components/AppIcons";

export interface NavItem {
    label: string;
    to: string;
    icon: IconName;
    // Optional end-exact matching note; most entries are exact on `to`.
    index?: boolean;
}

export interface NavSection {
    id: string;
    title?: string; // absent => rendered as a plain top-level item row (no grouping label)
    items: NavItem[];
}

// Information architecture:
//   top-level: Dashboard, Interviews, Analytics, Resume
//   group "Settings": System, Account
//   group "Management": Managed accounts, Docs
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
