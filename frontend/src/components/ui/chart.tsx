"use client";

import * as React from "react";
import type { TooltipValueType } from "recharts";
import * as RechartsPrimitive from "recharts";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// AI HERE: stock shadcn v4 chart, monochrome-light only (M12). A dark theme
// would add a `.dark` token entry to THEMES and a dark palette.
const THEMES = { light: "", dark: ".dark" } as const;

const INITIAL_DIMENSION = { width: 320, height: 200 } as const;
type TooltipNameType = number | string;

// Recharts' 1500ms default draw-in is most of what a mount costs in frames; 350ms still reads as a
// draw. Per series, not on the chart root: the root does not reliably forward it.
export const DRAW_MS = 350;

// AI HERE: /analytics mounts five recharts trees, and several landing in one commit measured as a
// ~0.5s main-thread block (notes.md § PERF). Deferred charts queue at mount and are released in DOM
// order, 250ms apart, one slot open at a time. Ceiling: this spreads the mounts, it does not make any
// of them cheaper, and the gap is a constant rather than a frame-budget measurement.
const GAP_MS = 250;

type Claim = (handBack: () => void) => void;

const queued: Claim[] = [];
let scheduled = false;
let mounting = false;
let lastReleased = 0;

function schedule() {
    if (scheduled) return;
    scheduled = true;
    const wait = lastReleased ? Math.max(0, GAP_MS - (performance.now() - lastReleased)) : 0;
    const fire = () => {
        scheduled = false;
        release();
    };
    if (wait > 0) setTimeout(fire, wait);
    // Safari has no requestIdleCallback; a timeout is the same delay without the slack check.
    else if (typeof requestIdleCallback === "function") requestIdleCallback(fire, { timeout: 400 });
    else setTimeout(fire, 120);
}

function release() {
    if (mounting) return; // the chart holding the slot schedules the next release when it commits
    const next = queued.shift();
    if (!next) return;
    mounting = true;
    lastReleased = performance.now();
    let handed = false;
    next(() => {
        if (import.meta.env.DEV && handed) throw new Error("ChartContainer handed one slot back twice: two charts would mount in the same frame.");
        handed = true;
        mounting = false;
        if (queued.length) schedule();
    });
}

function enqueue(claim: Claim) {
    queued.push(claim);
    schedule();
}

function forget(claim: Claim) {
    const i = queued.indexOf(claim);
    if (i >= 0) queued.splice(i, 1);
}

export type ChartConfig = Record<
    string,
    {
        label?: React.ReactNode;
        icon?: React.ComponentType;
    } & ({ color?: string; theme?: never } | { color?: never; theme: Record<keyof typeof THEMES, string> })
>;

type ChartContextProps = {
    config: ChartConfig;
};

const ChartContext = React.createContext<ChartContextProps | null>(null);

function useChart() {
    const context = React.useContext(ChartContext);
    if (!context) {
        throw new Error("useChart must be used within a <ChartContainer />");
    }
    return context;
}

function ChartContainer({
    id,
    className,
    children,
    config,
    defer,
    initialDimension = INITIAL_DIMENSION,
    ...props
}: React.ComponentProps<"div"> & {
    config: ChartConfig;
    children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
    initialDimension?: { width: number; height: number };
    defer?: boolean;
}) {
    const uniqueId = React.useId();
    const chartId = `chart-${id ?? uniqueId.replace(/:/g, "")}`;
    const ref = React.useRef<HTMLDivElement>(null);
    const [ready, setReady] = React.useState(!defer);
    const held = React.useRef<(() => void) | null>(null);
    // Derived, not just the state: flipping `defer` off has to reveal the chart right away.
    const show = !defer || ready;

    React.useEffect(() => {
        if (!defer || ready) return;
        const el = ref.current;
        if (el && import.meta.env.DEV && el.getBoundingClientRect().height === 0) {
            throw new Error("ChartContainer `defer` needs a sized box: give it a height class (h-60), or the page shifts when the chart mounts.");
        }
        const claim: Claim = (handBack) => {
            held.current = handBack;
            setReady(true);
        };
        enqueue(claim);
        return () => {
            forget(claim);
            // Released in the cleanup, not the effect body: this runs after the commit that mounted
            // the chart, and it also covers an unmount that beat the commit, which would stall the
            // queue for every chart behind it.
            const handBack = held.current;
            held.current = null;
            handBack?.();
        };
    }, [defer, ready]);

    return (
        <ChartContext.Provider value={{ config }}>
            <div
                ref={ref}
                data-slot="chart"
                data-chart={chartId}
                className={cn(
                    // NB: keep this container shape-neutral and full-width (no `aspect-video`,
                    // no `flex justify-center`) — `aspect-video` overrides explicit card
                    // heights and the flex wrapper makes ResponsiveContainer measure a
                    // shrink-to-fit box. Callers size the height (see AccuracyTrendChart).
                    "relative w-full min-w-0 text-xs [&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-sector]:outline-hidden [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-surface]:outline-hidden",
                    className,
                )}
                {...props}
            >
                <ChartStyle id={chartId} config={config} />
                {show ? <RechartsPrimitive.ResponsiveContainer initialDimension={initialDimension}>{children}</RechartsPrimitive.ResponsiveContainer> : <Skeleton className="absolute inset-0" />}
            </div>
        </ChartContext.Provider>
    );
}

const ChartStyle = ({ id, config }: { id: string; config: ChartConfig }) => {
    const colorConfig = Object.entries(config).filter(([, config]) => config.theme ?? config.color);

    if (!colorConfig.length) {
        return null;
    }

    return (
        <style
            // biome-ignore lint/security/noDangerouslySetInnerHtml: shadcn chart injects scoped CSS vars.
            dangerouslySetInnerHTML={{
                __html: Object.entries(THEMES)
                    .map(
                        ([theme, prefix]) => `
${prefix} [data-chart=${id}] {
${colorConfig
    .map(([key, itemConfig]) => {
        const color = itemConfig.theme?.[theme as keyof typeof itemConfig.theme] ?? itemConfig.color;
        return color ? `  --color-${key}: ${color};` : null;
    })
    .join("\n")}
}
`,
                    )
                    .join("\n"),
            }}
        />
    );
};

const ChartTooltip = RechartsPrimitive.Tooltip;

function ChartTooltipContent({
    active,
    payload,
    className,
    indicator = "dot",
    hideLabel = false,
    hideIndicator = false,
    label,
    labelFormatter,
    labelClassName,
    formatter,
    color,
    nameKey,
    labelKey,
}: React.ComponentProps<typeof RechartsPrimitive.Tooltip> &
    React.ComponentProps<"div"> & {
        hideLabel?: boolean;
        hideIndicator?: boolean;
        indicator?: "line" | "dot" | "dashed";
        nameKey?: string;
        labelKey?: string;
    } & Omit<RechartsPrimitive.DefaultTooltipContentProps<TooltipValueType, TooltipNameType>, "accessibilityLayer">) {
    const { config } = useChart();

    const tooltipLabel = React.useMemo(() => {
        if (hideLabel || !payload?.length) {
            return null;
        }

        const [item] = payload;
        const key = `${labelKey ?? item?.dataKey ?? item?.name ?? "value"}`;
        const itemConfig = getPayloadConfigFromPayload(config, item, key);
        const value = !labelKey && typeof label === "string" ? (config[label]?.label ?? label) : itemConfig?.label;

        if (labelFormatter) {
            return <div className={cn("font-medium", labelClassName)}>{labelFormatter(value, payload)}</div>;
        }

        if (!value) {
            return null;
        }

        return <div className={cn("font-medium", labelClassName)}>{value}</div>;
    }, [label, labelFormatter, payload, hideLabel, labelClassName, config, labelKey]);

    if (!active || !payload?.length) {
        return null;
    }

    const nestLabel = payload.length === 1 && indicator !== "dot";

    return (
        <div className={cn("grid min-w-[8rem] items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl", className)}>
            {!nestLabel ? tooltipLabel : null}
            <div className="grid gap-1.5">
                {payload
                    .filter((item) => item.type !== "none")
                    .map((item, index) => {
                        const key = `${nameKey ?? item.name ?? item.dataKey ?? "value"}`;
                        const itemConfig = getPayloadConfigFromPayload(config, item, key);
                        const indicatorColor = color ?? item.payload?.fill ?? item.color;

                        return (
                            // biome-ignore lint/suspicious/noArrayIndexKey: recharts payload is a fixed-order display list.
                            <div key={index} className={cn("flex w-full flex-wrap items-stretch gap-2 [&>svg]:h-2.5 [&>svg]:w-2.5 [&>svg]:text-muted-foreground", indicator === "dot" && "items-center")}>
                                {formatter && item?.value !== undefined && item.name ? (
                                    formatter(item.value, item.name, item, index, item.payload)
                                ) : (
                                    <>
                                        {itemConfig?.icon ? (
                                            <itemConfig.icon />
                                        ) : (
                                            !hideIndicator && (
                                                <div
                                                    className={cn("shrink-0 rounded-[2px] border-(--color-border) bg-(--color-bg)", {
                                                        "h-2.5 w-2.5": indicator === "dot",
                                                        "w-1": indicator === "line",
                                                        "w-0 border-[1.5px] border-dashed bg-transparent": indicator === "dashed",
                                                        "my-0.5": nestLabel && indicator === "dashed",
                                                    })}
                                                    style={{ "--color-bg": indicatorColor, "--color-border": indicatorColor } as React.CSSProperties}
                                                />
                                            )
                                        )}
                                        <div className={cn("flex flex-1 justify-between leading-none", nestLabel ? "items-end" : "items-center")}>
                                            <div className="grid gap-1.5">
                                                {nestLabel ? tooltipLabel : null}
                                                <span className="text-muted-foreground">{itemConfig?.label ?? item.name}</span>
                                            </div>
                                            {item.value != null && <span className="font-mono font-medium text-foreground tabular-nums">{typeof item.value === "number" ? item.value.toLocaleString() : String(item.value)}</span>}
                                        </div>
                                    </>
                                )}
                            </div>
                        );
                    })}
            </div>
        </div>
    );
}

function getPayloadConfigFromPayload(config: ChartConfig, payload: unknown, key: string) {
    if (typeof payload !== "object" || payload === null) {
        return undefined;
    }

    const payloadPayload = "payload" in payload && typeof payload.payload === "object" && payload.payload !== null ? payload.payload : undefined;

    let configLabelKey: string = key;

    if (key in payload && typeof payload[key as keyof typeof payload] === "string") {
        configLabelKey = payload[key as keyof typeof payload] as string;
    } else if (payloadPayload && key in payloadPayload && typeof payloadPayload[key as keyof typeof payloadPayload] === "string") {
        configLabelKey = payloadPayload[key as keyof typeof payloadPayload] as string;
    }

    return configLabelKey in config ? config[configLabelKey] : config[key];
}

export { ChartContainer, ChartTooltip, ChartTooltipContent };
