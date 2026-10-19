import { Fragment } from "react";

import type { Offer } from "@/lib/api";
import { decisionLabel } from "@/lib/interviewOptions";
import { bandPosition, compactMoney, money, tierTone } from "@/lib/offers";
import { cn } from "@/lib/utils";

export function OfferLetter({ offer }: { offer: Offer }) {
    return (
        <article className="space-y-4 text-sm leading-relaxed">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b pb-3">
                <span className="font-serif text-lg tracking-[-0.015em]">maxterview</span>
                <span className="text-xs text-muted-foreground">Offer of employment · {offer.created_at.slice(0, 10)}</span>
            </div>

            <p>Dear candidate,</p>
            <p>
                Following your interview, we are pleased to offer you the position of <strong>{offer.title}</strong>, starting <strong>{offer.starts_on}</strong>. The terms below are simulated from how that interview read.
            </p>

            <table className="w-full">
                <tbody>
                    <CompRow label="Base salary" value={`${money(offer.base_salary)} a year`} />
                    <CompRow label="Equity" value={offer.equity > 0 ? `${money(offer.equity)} a year, vested over four` : "no grant at this level"} />
                    <CompRow label="Signing bonus" value={offer.signing_bonus > 0 ? `${money(offer.signing_bonus)}, one time` : "none"} />
                </tbody>
                <tfoot>
                    <tr className="border-t">
                        <td className="pt-2 font-medium">Total annual compensation</td>
                        <td className="pt-2 text-right text-base font-semibold tabular-nums">{money(offer.total_comp)}</td>
                    </tr>
                </tfoot>
            </table>

            <div className="space-y-1.5">
                <p className="font-medium">Where the offer sits</p>
                <RangeBar start={offer.band_low} end={offer.band_high} avg={offer.base_salary} max={offer.band_high} />
                <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                    <span>{compactMoney(offer.band_low)} floor</span>
                    <span className="text-foreground">
                        {bandPosition(offer)}% up the {offer.band} band
                    </span>
                    <span>{compactMoney(offer.band_high)} ceiling</span>
                </div>
            </div>

            <div className="space-y-1.5">
                <p className="font-medium">Benefits</p>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-muted-foreground">
                    {offer.benefits.map((b) => (
                        <Fragment key={b.key}>
                            <dt className="text-foreground">{b.label}</dt>
                            <dd>{b.value}</dd>
                        </Fragment>
                    ))}
                </dl>
            </div>

            <div className="flex flex-wrap items-baseline gap-2 text-xs">
                <span className={cn("rounded border px-1.5 py-0.5 font-medium", tierTone(offer.tier))}>{offer.tier_label}</span>
                <span className="rounded border px-1.5 py-0.5 text-muted-foreground">run score {offer.performance}/100</span>
                {offer.grade && offer.accuracy != null && (
                    <span className="rounded border px-1.5 py-0.5 text-muted-foreground">
                        review {offer.grade} · {offer.accuracy}%
                    </span>
                )}
                {offer.decision && <span className="rounded border px-1.5 py-0.5 text-muted-foreground">{decisionLabel(offer.decision)}</span>}
            </div>

            <p className="text-xs text-muted-foreground">Sincerely, the {offer.role} panel. This letter is simulated from the interview, not an offer of employment.</p>
        </article>
    );
}

function CompRow({ label, value }: { label: string; value: string }) {
    return (
        <tr>
            <td className="py-0.5 text-muted-foreground">{label}</td>
            <td className="py-0.5 text-right tabular-nums">{value}</td>
        </tr>
    );
}

export function RangeBar({ start, end, avg, max }: { start: number; end: number; avg: number; max: number }) {
    const width = Math.max(1.5, (100 * (end - start)) / max);
    const offset = (100 * start) / max;
    const marker = end === start ? 50 : (100 * (avg - start)) / (end - start);

    return (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div className="relative h-full" style={{ marginLeft: `${offset}%`, width: `${width}%` }}>
                <div className="h-full rounded-full bg-[var(--chart-2)]" />
                <span className="absolute -top-0.5 h-2.5 w-0.5 bg-foreground" style={{ left: `${marker}%` }} />
            </div>
        </div>
    );
}
