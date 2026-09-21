import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent, DRAW_MS } from "@/components/ui/chart";

const config: ChartConfig = {
    accuracy: { label: "Accuracy", color: "var(--chart-1)" },
};

export function AccuracyTrendChart({ data, defer }: { data: { label: string; accuracy: number }[]; defer?: boolean }) {
    return (
        <ChartContainer defer={defer} config={config} className="h-full min-h-40 w-full grow">
            <AreaChart data={data} accessibilityLayer margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                {/* Labels are pre-formatted in useInterviewData (MM/DD, or MM/DD HH:MM when two
                    runs share a day) — no formatter here, or we'd re-trim the time away. */}
                <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" />
                {/* Whole-number, 10%-wide ticks: a 62%-vs-71% series should not render as a
                    full-height cliff, and the raw dataMin-1/dataMax+1 bounds are fractional. */}
                <YAxis dataKey="accuracy" domain={[(min: number) => Math.max(0, Math.floor((min - 10) / 10) * 10), (max: number) => Math.min(100, Math.ceil((max + 10) / 10) * 10)]} tickCount={5} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
                {/* Visible anchors keep a short series from reading as a smudge. */}
                <Area dataKey="accuracy" type="monotone" animationDuration={DRAW_MS} fill="var(--color-accuracy)" fillOpacity={0.25} stroke="var(--color-accuracy)" strokeWidth={2} dot={{ r: 3, fillOpacity: 1 }} activeDot={{ r: 4 }} />
            </AreaChart>
        </ChartContainer>
    );
}
