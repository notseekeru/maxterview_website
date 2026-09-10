import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";

const config: ChartConfig = {
    score: { label: "Score", color: "var(--chart-1)" },
};

// Monochrome score trend (M12): simple monotone area of the last N interview scores.
// `grow` (not a fixed h-52) so the chart fills whatever height the card gives it;
// a hardcoded height left dead space under the chart when the sibling card stretched.
export function ScoreTrendChart({ data }: { data: { label: string; score: number }[] }) {
    return (
        <ChartContainer config={config} className="h-full min-h-40 w-full grow">
            <AreaChart data={data} accessibilityLayer margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                {/* Labels are pre-formatted in useInterviewData (MM/DD, or MM/DD HH:MM when two
                    runs share a day) — no formatter here, or we'd re-trim the time away. */}
                <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" />
                {/* Whole-number domain so recharts emits whole-number ticks. The raw
                    dataMin-1/dataMax+1 domain produced a mixed scale (0, 3, 6, 8.5) because
                    the bounds were fractional. */}
                <YAxis dataKey="score" domain={[(min: number) => Math.max(0, Math.floor(min - 1)), (max: number) => Math.min(10, Math.ceil(max + 1))]} tickCount={5} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
                {/* dot: with only a few runs, visible anchors stop the area reading as a smudge. */}
                <Area dataKey="score" type="monotone" fill="var(--color-score)" fillOpacity={0.25} stroke="var(--color-score)" strokeWidth={2} dot={{ r: 3, fillOpacity: 1 }} activeDot={{ r: 4 }} />
            </AreaChart>
        </ChartContainer>
    );
}
