import type { ReactNode } from "react";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, XAxis, YAxis } from "recharts";

import { AccuracyTrendChart } from "@/components/AccuracyTrendChart";
import { OffersSection } from "@/components/OffersSection";
import { LABEL, Page, Panel, SectionHeading, Stat } from "@/components/PagePrimitives";
import { Card, CardContent } from "@/components/ui/card";
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent, DRAW_MS } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { StateNote } from "@/components/ui/state";
import { useAnalytics } from "@/hooks/useInterviewData";
import type { Analytics, AnalyticsActivityWeek, AnalyticsDial, AnalyticsRun } from "@/lib/api";
import { dimLabel, groupDims, orderDims } from "@/lib/dimensions";
import { DECISIONS, DEPTHS, decisionLabel, isHiring } from "@/lib/interviewOptions";
import { gradeTone, MOVE_CLASSES, moveClassMeta } from "@/lib/moveClasses";
import { cn } from "@/lib/utils";

const TITLE = "Analytics";

const SECTIONS = {
    offers: { title: "Offers" },
    practice: { title: "Practice" },
    decisions: { title: "Decisions & settings" },
    runs: { title: "Run log" },
} as const;

type SectionId = keyof typeof SECTIONS;

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
    const { title } = SECTIONS[id];
    return (
        <section id={id} className="scroll-mt-20 space-y-4">
            <SectionHeading title={title} />
            {children}
        </section>
    );
}

function JumpStrip() {
    return (
        <nav aria-label="Analytics sections" className="flex flex-wrap gap-2">
            {Object.entries(SECTIONS).map(([id, s]) => (
                <a key={id} href={`#${id}`} className="rounded-full border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
                    {s.title}
                </a>
            ))}
        </nav>
    );
}

export function AnalyticsPage() {
    const { data, loading, error } = useAnalytics();

    if (loading) {
        return (
            <Page wide title={TITLE}>
                <div className="space-y-4" aria-busy="true">
                    <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
                        {[0, 1, 2, 3, 4].map((i) => (
                            <Skeleton key={i} className="h-24" />
                        ))}
                    </div>
                    <Skeleton className="h-80" />
                    <div className="grid gap-4 lg:grid-cols-2">
                        <Skeleton className="h-80" />
                        <Skeleton className="h-80" />
                    </div>
                </div>
            </Page>
        );
    }

    if (error || !data) {
        return <Notice>{error ?? "Could not load your analytics."}</Notice>;
    }
    if (data.runs.length === 0) {
        return <Notice>No interviews yet. Complete one and this page fills in with your accuracy history, move breakdown, dial comparisons and the offer each graded run earned.</Notice>;
    }

    return (
        <Page wide title={TITLE}>
            <JumpStrip />
            <SummaryRow data={data} />
            <Section id="offers">
                <OffersSection board={data.offers} />
            </Section>
            <Section id="practice">
                <div className="grid gap-4 xl:grid-cols-2">
                    <AccuracyHistory runs={data.runs} />
                    <MoveBreakdown counts={data.move_classes} />
                </div>
                <ActivityWeekly weeks={data.activity} />
                <DimensionHistory runs={data.runs} />
            </Section>
            <Section id="decisions">
                <DecisionHistory runs={data.runs} />
                <DialBreakdown dials={data.dials} />
            </Section>
            <Section id="runs">
                <RunLog runs={data.runs} />
            </Section>
        </Page>
    );
}

function Notice({ children }: { children: ReactNode }) {
    return (
        <Page wide title={TITLE}>
            <Card>
                <CardContent className="pt-6">
                    <StateNote>{children}</StateNote>
                </CardContent>
            </Card>
        </Page>
    );
}

function SummaryRow({ data }: { data: Analytics }) {
    const scored = data.runs.map((r) => r.accuracy).filter((a): a is number => a != null);
    const avg = scored.length === 0 ? null : scored.reduce((a, b) => a + b, 0) / scored.length;
    const decided = data.runs.filter((r) => r.decision);
    const hiring = decided.filter((r) => isHiring(r.decision));

    return (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Stat label="Interviews" value={String(data.runs.length)} />
            <Stat label="Avg accuracy" value={avg === null ? "n/a" : `${Math.round(avg)}%`} />
            <Stat label="Hire rate" value={decided.length === 0 ? "n/a" : `${Math.round((hiring.length / decided.length) * 100)}%`} />
            <Stat label="Answers given" value={String(data.total_turns)} />
            <Stat label="Streak" value={`${data.streak_days}d`} />
        </div>
    );
}

interface DayPoint {
    label: string;
    count: number;
}

function perDay<K extends string>(runs: AnalyticsRun[], series: (run: AnalyticsRun) => Record<K, number | null>): (DayPoint & Record<K, number>)[] {
    const days = new Map<string, { point: DayPoint; sums: Record<string, number>; ns: Record<string, number> }>();
    for (const run of runs) {
        const day = run.created_at.slice(0, 10);
        let entry = days.get(day);
        if (!entry) {
            entry = { point: { label: day.slice(5).replace("-", "/"), count: 0 }, sums: {}, ns: {} };
            days.set(day, entry);
        }
        entry.point.count += 1;
        for (const [key, value] of Object.entries(series(run)) as [K, number | null][]) {
            if (value == null) continue;
            entry.sums[key] = (entry.sums[key] ?? 0) + value;
            entry.ns[key] = (entry.ns[key] ?? 0) + 1;
        }
    }
    // ISO date order, not the MM/DD label: the label drops the year and would sort a multi-year
    // history by day-of-month.
    return [...days.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, { point, sums, ns }]) => {
            // The one cast: the series keys are built at runtime, so only the caller that chose them
            // can vouch for them.
            const means = {} as Record<K, number>;
            for (const [key, total] of Object.entries(sums) as [K, number][]) means[key] = Math.round((total / ns[key]) * 10) / 10;
            return { ...point, ...means } as DayPoint & Record<K, number>;
        });
}

const dayLabel = (label: unknown, payload: readonly { payload?: DayPoint }[]) => {
    const n = payload?.[0]?.payload?.count;
    return n ? `${label} · ${n} run${n === 1 ? "" : "s"}` : String(label);
};

function AccuracyHistory({ runs }: { runs: AnalyticsRun[] }) {
    const data = perDay(
        runs.filter((r) => r.accuracy != null),
        (r) => ({ accuracy: r.accuracy ?? null }),
    );

    return (
        <Panel title="Accuracy over time" className="h-80">
            {data.length === 0 ? <StateNote>Nothing has been scored yet.</StateNote> : <div className="h-60">{<AccuracyTrendChart defer data={data} />}</div>}
        </Panel>
    );
}

const ACTIVITY_CONFIG: ChartConfig = {
    completed: { label: "Finished", color: "var(--chart-1)" },
    started: { label: "Started", color: "var(--chart-4)" },
};

function ActivityWeekly({ weeks }: { weeks: AnalyticsActivityWeek[] }) {
    const data = weeks.map((w) => ({ label: w.week.slice(5).replace("-", "/"), started: w.started, completed: w.completed }));
    const runs = data.reduce((a, d) => a + d.started, 0);

    return (
        <Panel title="Practice activity" className="h-72">
            {runs === 0 ? (
                <StateNote>No interviews in the last 12 weeks.</StateNote>
            ) : (
                <ChartContainer defer config={ACTIVITY_CONFIG} className="h-52 w-full">
                    <BarChart data={data} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
                        <CartesianGrid vertical={false} strokeDasharray="3 3" />
                        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" />
                        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} />
                        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
                        <Bar dataKey="started" animationDuration={DRAW_MS} radius={4} fill="var(--color-started)" />
                        <Bar dataKey="completed" animationDuration={DRAW_MS} radius={4} fill="var(--color-completed)" />
                    </BarChart>
                </ChartContainer>
            )}
        </Panel>
    );
}

const MOVE_CONFIG: ChartConfig = { count: { label: "Turns", color: "var(--chart-1)" } };

// Ordered by rating.MOVE_CLASSES, never by count: an axis that reorders itself between loads cannot
// be compared over time.
function MoveBreakdown({ counts }: { counts: Analytics["move_classes"] }) {
    const rows = MOVE_ORDER.map((cls) => ({ cls, count: counts[cls] ?? 0 }));
    const total = rows.reduce((a, r) => a + r.count, 0);

    return (
        <Panel title="Answer quality" className="h-80">
            {total === 0 ? (
                <StateNote>Finish an interview to see how your answers were classed.</StateNote>
            ) : (
                <ChartContainer defer config={MOVE_CONFIG} className="h-60 w-full">
                    <BarChart data={rows} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
                        <CartesianGrid vertical={false} strokeDasharray="3 3" />
                        <XAxis dataKey="cls" tickLine={false} axisLine={false} tickMargin={8} tickFormatter={(v: string) => moveClassMeta(v)?.label ?? v} />
                        <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} />
                        <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" labelFormatter={(v) => moveClassMeta(String(v))?.hint ?? String(v)} />} />
                        <Bar dataKey="count" animationDuration={DRAW_MS} radius={4}>
                            {rows.map((r) => (
                                <Cell key={r.cls} fill={MOVE_SCALE[r.cls].chart} fillOpacity={MOVE_SCALE[r.cls].opacity} />
                            ))}
                        </Bar>
                    </BarChart>
                </ChartContainer>
            )}
        </Panel>
    );
}

function DimensionHistory({ runs }: { runs: AnalyticsRun[] }) {
    const scored = runs.filter((r) => Object.keys(r.scores).length > 0);
    const keys = orderDims([...new Set(scored.flatMap((r) => Object.keys(r.scores)))]);
    const axes = groupDims(keys);

    const data = perDay(scored, (r) =>
        Object.fromEntries(
            axes.map((group) => {
                const present = group.dims.map((d) => r.scores[d]).filter((v): v is number => typeof v === "number");
                return [group.axis, present.length === 0 ? null : present.reduce((a, b) => a + b, 0) / present.length];
            }),
        ),
    );

    if (scored.length === 0) {
        return (
            <Panel title="Dimension scores over time">
                <StateNote>No run has been scored on the 1-10 dimensions yet.</StateNote>
            </Panel>
        );
    }

    return (
        <Panel title="Dimension scores over time">
            <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
                <ChartContainer defer config={DIM_CONFIG} className="h-full min-h-64 w-full">
                    <LineChart data={data} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
                        <CartesianGrid vertical={false} strokeDasharray="3 3" />
                        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" />
                        {/* 0-10: the floor of the scale is the axis floor, or a 6 reads as a 5.5. */}
                        <YAxis domain={[0, 10]} tickLine={false} axisLine={false} width={28} allowDecimals={false} />
                        <ChartTooltip content={<ChartTooltipContent indicator="line" labelFormatter={dayLabel} />} />
                        {axes.map((a) => (
                            <Line key={a.axis} dataKey={a.axis} name={a.label} type="monotone" animationDuration={DRAW_MS} stroke={`var(--color-${a.axis})`} strokeWidth={2} dot={{ r: 3 }} connectNulls />
                        ))}
                    </LineChart>
                </ChartContainer>
                <div className="flex h-full flex-col justify-center">
                    <DimensionAverages runs={scored} keys={keys} />
                </div>
            </div>
        </Panel>
    );
}

function DimensionAverages({ runs, keys }: { runs: AnalyticsRun[]; keys: string[] }) {
    const rows = keys.map((dim) => {
        const values = runs.map((r) => r.scores[dim]).filter((v): v is number => typeof v === "number");
        return { dim, n: values.length, mean: values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length };
    });

    return (
        <div className="space-y-1">
            {groupDims(keys).map((group) => (
                <div key={group.axis} className="space-y-0.5">
                    <p className={LABEL}>{group.label}</p>
                    {group.dims.map((dim) => {
                        const row = rows.find((r) => r.dim === dim);
                        if (!row) return null;
                        return (
                            <div key={dim} className="flex items-baseline justify-between gap-2 text-sm">
                                <span className="truncate">{dimLabel(dim)}</span>
                                <span className="shrink-0 tabular-nums">
                                    {row.mean === null ? <span className="text-muted-foreground">not assessed</span> : <span className="font-medium">{row.mean.toFixed(1)}</span>}
                                    <span className="ml-1.5 text-xs text-muted-foreground">/{row.n}</span>
                                </span>
                            </div>
                        );
                    })}
                </div>
            ))}
        </div>
    );
}

function DecisionHistory({ runs }: { runs: AnalyticsRun[] }) {
    const decided = runs.filter((r) => r.decision);
    const data = perDay(decided, (r) => ({ certainty: r.certainty ?? null, lean: DECISION_LEAN[r.decision as string] ?? null }));

    return (
        <Panel title="Hiring decisions">
            {decided.length === 0 ? (
                <StateNote>Once runs come back with a hire/reject call, the lean and its certainty plot here.</StateNote>
            ) : (
                <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
                    <ChartContainer defer config={DECISION_CONFIG} className="h-full min-h-64 w-full">
                        <LineChart data={data} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
                            <CartesianGrid vertical={false} strokeDasharray="3 3" />
                            <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" />
                            <YAxis domain={[-100, 100]} ticks={[-100, -50, 0, 50, 100]} tickLine={false} axisLine={false} width={36} tickFormatter={(v: number) => (v === 0 ? "0" : v > 0 ? `+${v / 100}` : `${v / 100}`)} />
                            <ChartTooltip content={<ChartTooltipContent indicator="line" labelFormatter={dayLabel} />} />
                            <Line dataKey="lean" name="Lean" type="monotone" animationDuration={DRAW_MS} stroke="var(--color-lean)" strokeWidth={2} dot={{ r: 3 }} />
                            <Line dataKey="certainty" name="Certainty %" type="monotone" animationDuration={DRAW_MS} stroke="var(--color-certainty)" strokeWidth={2} strokeDasharray="4 3" dot={{ r: 3 }} connectNulls />
                        </LineChart>
                    </ChartContainer>
                    <div className="flex h-full flex-col justify-center">
                        <DecisionSplit runs={decided} />
                    </div>
                </div>
            )}
        </Panel>
    );
}

const DECISION_CONFIG: ChartConfig = {
    lean: { label: "Lean (+ hire / − reject)", color: "var(--chart-1)" },
    certainty: { label: "Certainty", color: "var(--chart-3)" },
};

const DIM_CONFIG: ChartConfig = {
    communication: { label: "Communication", color: "var(--chart-1)" },
    substance: { label: "Substance", color: "var(--chart-2)" },
    profile: { label: "Profile", color: "var(--chart-3)" },
    other: { label: "Other", color: "var(--chart-4)" },
};

function DecisionSplit({ runs }: { runs: AnalyticsRun[] }) {
    const total = runs.length;
    const count = (d: string) => runs.filter((r) => r.decision === d).length;
    const certainties = runs.map((r) => r.certainty).filter((c): c is number => typeof c === "number");
    const meanCertainty = certainties.length === 0 ? null : Math.round(certainties.reduce((a, b) => a + b, 0) / certainties.length);

    return (
        <div className="space-y-2">
            {DECISION_ORDER.map((d) => {
                const n = count(d.value);
                const pct = total === 0 ? 0 : (n / total) * 100;
                return (
                    <div key={d.value} className="space-y-1">
                        <div className="flex items-baseline justify-between text-sm">
                            <span>{d.label}</span>
                            <span className="tabular-nums text-muted-foreground">
                                {n} · {Math.round(pct)}%
                            </span>
                        </div>
                        {/* Width IS the share: an unlabeled bar segment makes a 1-of-9 read instantly. */}
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div className={cn("h-full rounded-full", DECISION_TONES[d.value])} style={{ width: `${pct}%` }} />
                        </div>
                    </div>
                );
            })}
            <p className="pt-1 text-xs text-muted-foreground">{meanCertainty === null ? "No certainty reported." : `Mean certainty ${meanCertainty}% across the runs that reported it.`}</p>
        </div>
    );
}

const DIAL_TITLES: Record<string, string> = {
    level: "By target level",
    cynicism: "By interviewer stance",
    company_size: "By company size",
    depth: "By interview depth",
    hardcore: "By hardcore mode",
    honesty: "By honesty setting",
    register: "By register",
};

function DialBreakdown({ dials }: { dials: Analytics["dials"] }) {
    const groups = Object.entries(dials).filter(([, rows]) => rows.length > 0);
    if (groups.length === 0) {
        return (
            <Panel title="How your settings track outcomes">
                <StateNote>Finish an interview to compare outcomes across the settings you dialled in.</StateNote>
            </Panel>
        );
    }
    return (
        <Panel title="How your settings track outcomes">
            <div className="columns-1 gap-x-8 md:columns-2 xl:columns-3">
                {groups.map(([key, rows]) => (
                    <div key={key} className="mb-6 break-inside-avoid space-y-2">
                        <h3 className={LABEL}>{DIAL_TITLES[key] ?? key}</h3>
                        <div className="space-y-2.5">
                            {rows.map((row) => (
                                <DialRow key={row.key} row={row} />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </Panel>
    );
}

function DialRow({ row }: { row: AnalyticsDial }) {
    return (
        <div className="space-y-1">
            <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate">{row.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                    {row.runs} run{row.runs === 1 ? "" : "s"}
                    {row.rated < row.runs && ` · ${row.rated} scored`}
                </span>
            </div>
            <div className="flex items-center gap-3">
                {/* Bar = accuracy only; the two percentages (accuracy, then hire rate) sit beside it. */}
                <div className="h-1.5 grow overflow-hidden rounded-full bg-muted">
                    {/* No bar at all when nothing was scored: a 0%-wide fill is indistinguishable from
                        a genuine 0% score, which is the reading "n/a acc" exists to avoid. */}
                    {row.avg_accuracy != null && <div className="h-full rounded-full bg-[var(--chart-1)]" style={{ width: `${row.avg_accuracy}%` }} />}
                </div>
                <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                    {row.avg_accuracy === null || row.avg_accuracy === undefined ? "n/a acc" : `${Math.round(row.avg_accuracy)}% acc`}
                    {row.hire_rate === null || row.hire_rate === undefined ? " · n/a" : ` · ${row.hire_rate}% hire`}
                </span>
            </div>
        </div>
    );
}

type SortKey = "created_at" | "accuracy" | "role";

function RunLog({ runs }: { runs: AnalyticsRun[] }) {
    const [key, setKey] = useState<SortKey>("created_at");
    const [desc, setDesc] = useState(true);

    const sorted = [...runs].sort((a, b) => {
        const dir = desc ? -1 : 1;
        if (key === "role") return dir * a.role.localeCompare(b.role);
        if (key === "accuracy") return dir * ((a.accuracy ?? -1) - (b.accuracy ?? -1));
        return dir * a.created_at.localeCompare(b.created_at);
    });

    const header = (label: string, sortKey: SortKey, className?: string) => (
        <th className={cn("px-3 py-2 text-left font-medium", className)}>
            <button
                type="button"
                className="inline-flex items-center gap-1 hover:text-foreground"
                onClick={() => {
                    if (key === sortKey) setDesc(!desc);
                    else {
                        setKey(sortKey);
                        setDesc(true);
                    }
                }}
            >
                {label}
                {key === sortKey && <span aria-hidden="true">{desc ? "↓" : "↑"}</span>}
            </button>
        </th>
    );

    return (
        <Panel title="All runs">
            <div className="-mx-3 overflow-x-auto">
                <table className="w-full min-w-[44rem] border-collapse text-sm">
                    <thead className="text-xs text-muted-foreground">
                        <tr className="border-b">
                            {header("Role", "role")}
                            <th className="px-3 py-2 text-left font-medium">Level</th>
                            {header("Date", "created_at")}
                            {header("Accuracy", "accuracy", "text-right")}
                            <th className="px-3 py-2 text-left font-medium">Grade</th>
                            <th className="px-3 py-2 text-left font-medium">Decision</th>
                            <th className="px-3 py-2 text-left font-medium">Dials</th>
                            <th className="px-3 py-2 text-left font-medium">Answer mix</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.map((run) => (
                            <tr key={run.id} className="border-b last:border-0">
                                <td className="max-w-[14rem] px-3 py-2">
                                    <span className="flex items-center gap-2">
                                        <span className="truncate">{run.role}</span>
                                        {/* Only the exception is marked: a finished run is what the row
                                            already looks like, and an unfinished one would otherwise
                                            read as a scored zero. */}
                                        {run.status !== "completed" && <span className="shrink-0 rounded border border-dashed px-1 text-xs text-muted-foreground">{run.status === "pending" ? "not started" : "in progress"}</span>}
                                    </span>
                                </td>
                                <td className="px-3 py-2 text-muted-foreground">{run.level === "any" ? "n/a" : run.level}</td>
                                <td className="px-3 py-2 tabular-nums text-muted-foreground">{run.created_at.slice(0, 10)}</td>
                                <td className="px-3 py-2 text-right tabular-nums">{run.accuracy == null ? "n/a" : `${run.accuracy}%`}</td>
                                <td className="px-3 py-2">
                                    {/* The grade chip is the same tone vocabulary the review page uses. */}
                                    <span className={cn("inline-flex min-w-[1.5rem] justify-center rounded border px-1 text-xs font-medium", gradeTone(run.grade))}>{run.grade ?? "n/a"}</span>
                                </td>
                                <td className="px-3 py-2 text-muted-foreground">{run.decision ? decisionLabel(run.decision) : "n/a"}</td>
                                <td className="px-3 py-2 text-muted-foreground">{dialSummary(run) || <span className="opacity-60">defaults</span>}</td>
                                <td className="px-3 py-2">
                                    <AnswerMix run={run} />
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </Panel>
    );
}

const DIAL_DEFAULTS = { cynicism: "neutral", company_size: "any", brutally_honest: false, human_mode: true, hardcore: false, depth: "standard" };

function dialSummary(run: AnalyticsRun): string {
    const d = run.dials;
    const parts: string[] = [];
    if (d.hardcore) parts.push("hardcore");
    if (d.brutally_honest) parts.push("brutal");
    if (!d.human_mode) parts.push("corporate");
    if (d.cynicism !== DIAL_DEFAULTS.cynicism) parts.push(d.cynicism);
    if (d.company_size !== DIAL_DEFAULTS.company_size) parts.push(d.company_size);
    if (d.depth !== DIAL_DEFAULTS.depth) parts.push(DEPTHS.find((x) => x.value === d.depth)?.label.toLowerCase() ?? d.depth);
    return parts.join(" · ");
}

// Move-class tallies, strongest first; unclassed turns are listed too, so a half-graded run does not
// read as fully reviewed.
function AnswerMix({ run }: { run: AnalyticsRun }) {
    const total = Object.values(run.moves).reduce((a, b) => a + (b ?? 0), 0);
    if (total === 0) return <span className="text-xs text-muted-foreground">{run.turns === 0 ? "no answers" : "not classed"}</span>;
    return (
        <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {MOVE_ORDER.map((cls) =>
                run.moves[cls] ? (
                    <span key={cls} className="inline-flex items-center gap-1">
                        <span className={cn("h-2 w-2 rounded-sm", MOVE_SCALE[cls].bg)} style={{ opacity: MOVE_SCALE[cls].opacity }} />
                        <span className="tabular-nums">
                            {moveClassMeta(cls)?.label ?? cls} {run.moves[cls]}
                        </span>
                    </span>
                ) : null,
            )}
            {total < run.turns && <span className="italic">+{run.turns - total} unclassed</span>}
        </span>
    );
}

const MOVE_ORDER = MOVE_CLASSES.map((m) => m.value);
const MOVE_SCALE: Record<string, { chart: string; bg: string; opacity: number }> = {
    brilliant: { chart: "var(--chart-1)", bg: "bg-[var(--chart-1)]", opacity: 1 },
    great: { chart: "var(--chart-2)", bg: "bg-[var(--chart-2)]", opacity: 1 },
    good: { chart: "var(--chart-2)", bg: "bg-[var(--chart-2)]", opacity: 0.7 },
    book: { chart: "var(--chart-2)", bg: "bg-[var(--chart-2)]", opacity: 0.4 },
    inaccuracy: { chart: "var(--chart-4)", bg: "bg-[var(--chart-4)]", opacity: 0.7 },
    mistake: { chart: "var(--chart-4)", bg: "bg-[var(--chart-4)]", opacity: 1 },
    blunder: { chart: "var(--chart-5)", bg: "bg-[var(--chart-5)]", opacity: 1 },
};

const DECISION_TONES: Record<string, string> = {
    hire: "bg-[var(--chart-1)]",
    lean_hire: "bg-[var(--chart-2)]",
    lean_reject: "bg-[var(--chart-4)]",
    reject: "bg-[var(--chart-5)]",
};
const DECISION_ORDER = [...DECISIONS].reverse();

const DECISION_LEAN: Record<string, number> = { reject: -100, lean_reject: -50, lean_hire: 50, hire: 100 };
