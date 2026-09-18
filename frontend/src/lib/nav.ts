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
            { label: "Dashboard", to: "/dashboard", icon: "dashboard", index: true },
            { label: "Resume", to: "/resume", icon: "file" },
            { label: "Interviews", to: "/interviews", icon: "chat" },
            { label: "Analytics", to: "/analytics", icon: "chart" },
        ],
    },
    {
        id: "settings",
        title: "Settings",
        items: [
            { label: "System", to: "/settings/system", icon: "settings" },
            { label: "Account", to: "/settings/account", icon: "user" },
            { label: "Billing", to: "/settings/billing", icon: "card" },
            { label: "Docs", to: "/settings/docs", icon: "book" },
        ],
    },
];
