import { ArrowLeft, BookOpen, ChartLine, Check, CreditCard, FileText, LayoutDashboard, LogOut, type LucideIcon, Menu, MessageSquare, Mic, Monitor, Moon, Send, Settings, ShieldCheck, Square, Sun, User, Volume2, VolumeX, X } from "lucide-react";
import type { ComponentProps } from "react";

export type IconName = "dashboard" | "chat" | "chart" | "file" | "settings" | "user" | "shield" | "card" | "book" | "sun" | "moon" | "monitor" | "logout" | "menu" | "x" | "sound" | "mute" | "mic" | "stop" | "send" | "complete" | "back";

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
    sound: Volume2,
    mute: VolumeX,
    mic: Mic,
    stop: Square,
    send: Send,
    complete: Check,
    back: ArrowLeft,
};

type IconProps = ComponentProps<LucideIcon> & { name: IconName };

export function Icon({ name, ...rest }: IconProps) {
    const Cmp = MAP[name];
    return <Cmp className={rest.className ?? "h-4 w-4"} aria-hidden="true" {...rest} />;
}
