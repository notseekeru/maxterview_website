import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";

const config: ChartConfig = {
    score: { label: "Score", color: "var(--chart-1)" },
};

// Monochrome score trend (M12): simple monotone area of the last N interview scores.
export function ScoreTrendChart({ data }: { data: { label: string; score: number }[] }) {
    return (
        <ChartContainer config={config} className="h-52 w-full">
            <AreaChart data={data} accessibilityLayer margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(v: string) => v.slice(5)} />
                <YAxis dataKey="score" domain={[0, 10]} tickCount={6} tickLine={false} axisLine={false} width={24} />
                <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
                <Area dataKey="score" type="monotone" fill="var(--color-score)" fillOpacity={0.15} stroke="var(--color-score)" strokeWidth={2} />
            </AreaChart>
        </ChartContainer>
    );
}
