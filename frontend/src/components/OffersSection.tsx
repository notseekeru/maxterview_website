import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, XAxis, YAxis } from "recharts";

import { RangeBar } from "@/components/OfferLetter";
import { Panel, Stat } from "@/components/PagePrimitives";
import { Card, CardContent } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent, DRAW_MS } from "@/components/ui/chart";
import type { OfferBenefitStat, OfferGroup, OffersAnalytics } from "@/lib/api";
import { bandPosition, compactMoney, money, tierFill, tierTone, vsAverage } from "@/lib/offers";
import { cn } from "@/lib/utils";

/** The offers half of /analytics: the simulated letters, what they add up to, and the comparisons the
 *  numbers invite. Every figure and every benefit's wording arrives already computed from
 *  GET /stats/analytics; this file decides only how it is shown. */
export function OffersSection({ board }: { board: OffersAnalytics }) {
    if (board.offers.length === 0) {
        return (
            <Card>
                <CardContent className="pt-6">
                    <p className="text-sm text-muted-foreground">No offers yet. Every interview that gets a review is priced from it: your communication scores set the level band, the position inside it, and which benefits you cleared.</p>
                </CardContent>
            </Card>
        );
    }

    // No letter here on purpose: a run's letter is folded into its own review, right where the
    // interview ends. This section is the comparison across all of them.
    return (
        <div className="space-y-4">
            <OfferTiles board={board} />
            {/* Only the two panels that come out the same height stay side by side (both fixed at h-80);
                everything else is full width, so no panel sits in a column taller than its content. */}
            <div className="grid items-start gap-4 xl:grid-cols-2">
                <OfferTrend board={board} />
                <BandPosition groups={board.by_tier} />
            </div>
            <ByLevel groups={board.by_level} />
            <BenefitLadder benefits={board.benefits} offers={board.summary.count} />
            <OfferTable board={board} />
        </div>
    );
}

function OfferTiles({ board }: { board: OffersAnalytics }) {
    const { summary, offers } = board;
    const best = offers.find((o) => o.interview_id === summary.best_id);
    const worst = offers.find((o) => o.interview_id === summary.worst_id);

    return (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-6">
            <Stat label="Offers" value={String(summary.count)} hint="one per graded run" />
            <Stat label="Average base" value={money(summary.avg_base)} hint={`median ${money(summary.median_base)}`} />
            <Stat label="Lowest" value={money(summary.low_base)} hint={worst ? `${worst.title} · ${worst.tier_label.toLowerCase()}` : undefined} />
            <Stat label="Highest" value={money(summary.high_base)} hint={best ? `${best.title} · ${best.tier_label.toLowerCase()}` : undefined} />
            <Stat label="Average total comp" value={money(summary.avg_total)} hint={`+${money(summary.avg_equity)} equity, +${money(summary.avg_signing)} signing`} />
            <Stat label="Benefits per offer" value={summary.avg_benefits.toFixed(1)} hint={`mean run score ${summary.avg_performance}/100`} />
        </div>
    );
}

const TREND_CONFIG: ChartConfig = { base: { label: "Mean base", color: "var(--chart-1)" } };

/** Mean base per month. A monthly TOTAL would be a headcount chart wearing a money label. */
function OfferTrend({ board }: { board: OffersAnalytics }) {
    const points = board.activity.map((p) => ({ label: p.month.slice(2).replace("-", "/"), base: p.avg_base, offers: p.offers }));

    return (
        <Panel title="Offer trend" hint={`Monthly mean base · ${board.summary.count} offer${board.summary.count === 1 ? "" : "s"}, oldest to newest`} className="h-80">
            <ChartContainer defer config={TREND_CONFIG} className="h-60 w-full">
                <LineChart data={points} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                    <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" />
                    {/* No 0 floor: the interesting range is the spread between months, and a $0 baseline
                        flattens it into a straight line at the top. */}
                    <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={compactMoney} domain={["dataMin - 20000", "dataMax + 10000"]} />
                    <ChartTooltip content={<ChartTooltipContent indicator="line" labelFormatter={(label: unknown, payload: readonly { payload?: { offers?: number } }[]) => `${label} · ${payload?.[0]?.payload?.offers ?? 0} offers`} formatter={(value) => money(Number(value))} />} />
                    <Line dataKey="base" type="monotone" animationDuration={DRAW_MS} stroke="var(--color-base)" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
            </ChartContainer>
        </Panel>
    );
}

/** By how the run scored, not by dollars: the score IS the band position, so the bars compare across
 *  levels where the pay does not. */
const BAND_CONFIG: ChartConfig = { avg_performance: { label: "Up the band", color: "var(--chart-1)" } };

/** How far up its own level's range each tier of run landed, as a horizontal bar chart.
 *
 * A chart rather than a row per tier: the tiers are a couple of buckets, and rows left the card with the
 * empty half of a fixed-height box under them. Bars fill the height whatever the bucket count. The score
 * IS the band position, so a longer bar means a higher position inside the level, not a bigger salary;
 * the pay behind each bar is in the tooltip. */
function BandPosition({ groups }: { groups: OfferGroup[] }) {
    return (
        <Panel title="How far up the band" hint="Mean run score per tier. 100 is the top of that level's range." className="h-80">
            <ChartContainer defer config={BAND_CONFIG} className="h-full w-full">
                <BarChart data={groups} layout="vertical" margin={{ left: 4, right: 16, top: 8, bottom: 0 }}>
                    <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                    <XAxis type="number" domain={[0, 100]} tickLine={false} axisLine={false} unit="%" />
                    <YAxis type="category" dataKey="label" width={116} tickLine={false} axisLine={false} />
                    <ChartTooltip
                        cursor={false}
                        content={
                            <ChartTooltipContent
                                indicator="line"
                                formatter={(value, _name, item) => {
                                    const group = item?.payload as OfferGroup | undefined;
                                    return `${Math.round(Number(value))}% up the band${group ? ` · ${group.offers} offer${group.offers === 1 ? "" : "s"} · ${money(group.avg_base)} average base` : ""}`;
                                }}
                            />
                        }
                    />
                    <Bar dataKey="avg_performance" animationDuration={DRAW_MS} radius={4}>
                        {groups.map((g) => (
                            <Cell key={g.key} fill={tierFill(g.key)} />
                        ))}
                    </Bar>
                </BarChart>
            </ChartContainer>
        </Panel>
    );
}

/** Level -> the range the offers landed in, with the mean marked. Tracks are scaled to the widest top
 *  on the page, so a level's span reads against the whole ladder rather than in a vacuum. */
function ByLevel({ groups }: { groups: OfferGroup[] }) {
    const max = Math.max(...groups.map((g) => g.high_base));

    return (
        <Panel title="By target level">
            <div className="space-y-3">
                {groups.map((g) => (
                    <div key={g.key} className="space-y-1">
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                            <span>{g.label}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">
                                {money(g.avg_base)} avg · {money(g.low_base)} to {money(g.high_base)}
                            </span>
                        </div>
                        <RangeBar start={g.low_base} end={g.high_base} avg={g.avg_base} max={max} />
                    </div>
                ))}
                <p className="pt-1 text-xs text-muted-foreground">
                    The shaded span is what you were offered at that level, not the level's full band; {groups.reduce((a, g) => a + g.offers, 0)} offers across {groups.length} levels.
                </p>
            </div>
        </Panel>
    );
}

function BenefitLadder({ benefits, offers }: { benefits: OfferBenefitStat[]; offers: number }) {
    const earned = benefits.filter((b) => b.offers > 0).length;

    return (
        // Rungs laid out in two columns: nine full-width bars would be a lot of empty track for a rate
        // that is mostly 100%, and the ladder reads as a set, not as a ranking.
        <Panel title="Benefits earned" hint={`${earned} of ${benefits.length} rungs cleared by at least one offer, out of ${offers} offers`}>
            <div className="grid gap-x-8 gap-y-2.5 md:grid-cols-2">
                {benefits.map((b) => (
                    <div key={b.key} className="space-y-1">
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                            <span className={b.offers === 0 ? "text-muted-foreground" : undefined}>{b.label}</span>
                            <span className="shrink-0 text-xs text-muted-foreground">{b.offers === 0 ? "never granted" : `${b.offers} of ${offers} · ${b.rate}%`}</span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-[var(--chart-1)]" style={{ width: `${b.rate}%` }} />
                        </div>
                    </div>
                ))}
            </div>
        </Panel>
    );
}

/** Every offer, newest first. The delta column is the comparison the table exists for; the title links
 *  to the run, which is where that run's letter lives. Sorted client-side (already in memory). */
function OfferTable({ board }: { board: OffersAnalytics }) {
    return (
        <Panel title="All offers" hint={`${board.offers.length} offer${board.offers.length === 1 ? "" : "s"}, newest first. Click a row to read its letter.`}>
            <div className="-mx-3 overflow-x-auto">
                <table className="w-full min-w-[54rem] border-collapse text-sm">
                    <thead className="text-xs text-muted-foreground">
                        <tr className="border-b">
                            <th className="px-3 py-2 text-left font-medium">Date</th>
                            <th className="px-3 py-2 text-left font-medium">Offer</th>
                            <th className="px-3 py-2 text-left font-medium">Band</th>
                            <th className="px-3 py-2 text-left font-medium">Run score</th>
                            <th className="px-3 py-2 text-right font-medium">Base</th>
                            <th className="px-3 py-2 text-right font-medium">Total comp</th>
                            <th className="px-3 py-2 text-right font-medium">vs average</th>
                            <th className="px-3 py-2 text-right font-medium">Benefits</th>
                        </tr>
                    </thead>
                    <tbody>
                        {board.offers.map((offer) => {
                            const delta = vsAverage(offer, board.summary.avg_base);
                            return (
                                <tr key={offer.interview_id} className="border-b last:border-0">
                                    <td className="whitespace-nowrap px-3 py-2 tabular-nums text-muted-foreground">{offer.created_at.slice(0, 10)}</td>
                                    <td className="max-w-[16rem] px-3 py-2">
                                        <Link className="block truncate hover:underline" to={`/interviews/${offer.interview_id}`}>
                                            {offer.title}
                                        </Link>
                                        <span className="block truncate text-xs text-muted-foreground">
                                            {offer.level === "any" ? "any level" : offer.level}
                                            {offer.grade && offer.accuracy != null && ` · ${offer.grade} ${offer.accuracy}%`}
                                        </span>
                                    </td>
                                    <td className="px-3 py-2 text-xs text-muted-foreground">
                                        {compactMoney(offer.band_low)} to {compactMoney(offer.band_high)} · {bandPosition(offer)}% up
                                    </td>
                                    <td className="px-3 py-2">
                                        <span className="flex items-center gap-2">
                                            <span className={cn("rounded border px-1.5 py-0.5 text-[11px] font-medium", tierTone(offer.tier))}>{offer.performance}</span>
                                            <span className="text-xs text-muted-foreground">{offer.tier_label}</span>
                                        </span>
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums">{money(offer.base_salary)}</td>
                                    <td className="px-3 py-2 text-right tabular-nums">{money(offer.total_comp)}</td>
                                    <td className="px-3 py-2 text-right tabular-nums">
                                        {delta === null ? (
                                            "—"
                                        ) : (
                                            <span className={delta > 0 ? "text-[var(--chart-1)]" : delta < 0 ? "text-[var(--chart-4)]" : "text-muted-foreground"}>
                                                {delta > 0 ? "+" : ""}
                                                {delta}%
                                            </span>
                                        )}
                                    </td>
                                    <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{offer.benefits.length}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </Panel>
    );
}
