import { BookOpen, ChartLine, CreditCard, FileText, LayoutDashboard, LogOut, type LucideIcon, Menu, MessageSquare, Monitor, Moon, Settings, ShieldCheck, Sun, User, X } from "lucide-react";
import type { ComponentProps } from "react";

export type IconName = "dashboard" | "chat" | "chart" | "file" | "settings" | "user" | "shield" | "card" | "book" | "sun" | "moon" | "monitor" | "logout" | "menu" | "x";

const MAP: Record<IconName, LucideIcon> = {
    dashboard: LayoutDashboard,
    chat: MessageSquare,
    chart: ChartLine,
    file: FileText,
    settings: Settings,
    user: User,
    shield: ShieldCheck,
    card: CreditCard,
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
