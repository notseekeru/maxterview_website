import { BookOpen, ChartLine, FileText, LayoutDashboard, LogOut, type LucideIcon, Menu, MessageSquare, Monitor, Moon, Settings, ShieldCheck, Sun, User, Users, X } from "lucide-react";
import type { ComponentProps } from "react";

// ---------------------------------------------------------------- facade
// Single typed icon namespace so pages/nav never import lucide directly. Adding
// an icon here (name -> lucide component) makes it available app-wide; unused
// MAP entries are retained because MAP is a static object, so this deliberately
// serves the handful of nav/app icons we use. Swap/rename maps in one place.

export type IconName = "dashboard" | "chat" | "chart" | "file" | "settings" | "user" | "users" | "shield" | "book" | "sun" | "moon" | "monitor" | "logout" | "menu" | "x";

const MAP: Record<IconName, LucideIcon> = {
    dashboard: LayoutDashboard,
    chat: MessageSquare,
    chart: ChartLine,
    file: FileText,
    settings: Settings,
    user: User,
    users: Users,
    shield: ShieldCheck,
    book: BookOpen,
    sun: Sun,
    moon: Moon,
    monitor: Monitor,
    logout: LogOut,
    menu: Menu,
    x: X,
};

type IconProps = ComponentProps<LucideIcon> & { name: IconName };

export function Icon({ name, ...rest }: IconProps) {
    const Cmp = MAP[name];
    return <Cmp className={rest.className ?? "h-4 w-4"} aria-hidden="true" {...rest} />;
}
