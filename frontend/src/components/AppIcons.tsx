import { ArrowLeft, BookOpen, ChartLine, Check, ChevronDown, CreditCard, FileText, LayoutDashboard, LogOut, type LucideIcon, Menu, MessageSquare, Mic, Monitor, Moon, PanelLeft, RotateCcw, Send, Settings, ShieldCheck, SlidersHorizontal, Square, Sun, User, Volume2, VolumeX, X } from "lucide-react";
import type { ComponentProps } from "react";

export type IconName = "dashboard" | "chat" | "chart" | "file" | "settings" | "user" | "shield" | "card" | "book" | "sun" | "moon" | "monitor" | "logout" | "menu" | "x" | "panel" | "retry" | "sound" | "mute" | "mic" | "stop" | "send" | "complete" | "back" | "chevron" | "sliders";

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
    panel: PanelLeft,
    retry: RotateCcw,
    sound: Volume2,
    mute: VolumeX,
    mic: Mic,
    stop: Square,
    send: Send,
    complete: Check,
    back: ArrowLeft,
    chevron: ChevronDown,
    sliders: SlidersHorizontal,
};

type IconProps = ComponentProps<LucideIcon> & { name: IconName };

export function Icon({ name, ...rest }: IconProps) {
    const Cmp = MAP[name];
    return <Cmp className={rest.className ?? "h-4 w-4"} aria-hidden="true" {...rest} />;
}
